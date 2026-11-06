import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { normalizeDemo } from './demo-evidence.mjs'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const safeId = value => typeof value === 'string' && /^[a-z0-9-]+$/u.test(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const privatePath = /\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u

export function assertPublicBytes(bytes) {
  assert(!privatePath.test(Buffer.from(bytes).toString('utf8')), 'Public export contains an uncovered private machine path')
}

// This is the exact preregistration transformation, separate from per-run normalization.
export function normalizeProtocol(value, { repository, userHome = homedir(), temporaryDirectory = process.env.TMPDIR }) {
  if (typeof value === 'string') {
    for (const [prefix, replacement] of [[repository, '$REPOSITORY'], [userHome, '$HOME'], [temporaryDirectory, '$TEMP/']]) {
      if (prefix) value = value.replaceAll(prefix, replacement)
    }
    return value
  }
  if (Array.isArray(value)) return value.map(item => normalizeProtocol(item, { repository, userHome, temporaryDirectory }))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'PATH').map(([key, item]) => [key, normalizeProtocol(item, { repository, userHome, temporaryDirectory })]))
  return value
}

// Values remain private. Pointers and digests disclose exactly which fields changed.
export function normalizationChanges(before, after, pointer = '') {
  if (isDeepStrictEqual(before, after)) return []
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(key => normalizationChanges(before[key], after[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`))
  }
  return [{ pointer: pointer || '/', beforePresent: before !== undefined, afterPresent: after !== undefined, beforeValueSha256: before === undefined ? null : sha256(JSON.stringify(before)), afterValueSha256: after === undefined ? null : sha256(JSON.stringify(after)) }]
}

export function verifySupplement(supplement, record, expectedPublicHash) {
  assert.equal(supplement.schemaVersion, 1)
  assert.equal(supplement.runId, record.run.id)
  assert.equal(supplement.publicRecordSha256, expectedPublicHash)
  assert.equal(supplement.rawCaptureSha256, record.run.rawSha256)
  const expected = record.actions.filter(action => ['command_execution', 'mcp_tool_call'].includes(action.type))
  assert.deepEqual(supplement.actions.map(action => action.idSha256), expected.map(action => action.idSha256), 'Supplement must retain every completed public tool action in order')
  for (const [index, action] of supplement.actions.entries()) {
    const original = expected[index]
    for (const key of ['idSha256', 'type', 'status', ...(action.type === 'command_execution' ? ['outputSha256', 'outputBytes', 'exitCode'] : ['server', 'tool', 'resultSha256', 'resultBytes'])]) assert.deepEqual(action[key], original[key], `Supplement changes original action metadata: ${key}`)
  }
}

function verifyAudit(audit, report, reportBytes) {
  assert.equal(audit.schemaVersion, 1)
  assert.equal(audit.reportSha256, sha256(reportBytes), 'Independent audit must bind the untouched private report')
  assert.equal(audit.protocolSha256, report.protocolSha256)
  assert.equal(audit.noPrivateReasoningOrMessages, true)
  assert(typeof audit.reviewer === 'string' && audit.reviewer.trim())
  assert.equal(audit.runs.length, report.runs.length, 'Retain every independent judgment, including failed and unknown')
  for (const [index, run] of report.runs.entries()) {
    const row = audit.runs[index]
    assert.equal(row.id, run.id)
    assert.equal(row.evidenceSha256, run.evidenceSha256)
    assert(['pass', 'fail', 'unknown'].includes(row.instructionFollowed))
    assert(['usable', 'empty', 'failed', 'unknown'].includes(row.returnedEvidence))
    assert(typeof row.rationale === 'string' && row.rationale.trim().length >= 20)
  }
}

function prefixCandidates({ repository, study, runId, extraPrefixes }) {
  const runRoot = join(study, 'runs', runId)
  const values = [join(runRoot, 'workspace'), join(runRoot, 'provider-state'), runRoot, study, repository, homedir(), tmpdir(), process.env.TMPDIR, ...extraPrefixes.map(rule => rule[0])].filter(Boolean)
  for (const value of [...values]) {
    if (existsSync(value)) values.push(realpathSync(value))
    if (value.startsWith('/private/')) values.push(value.slice('/private'.length))
    else if (value.startsWith('/var/') || value.startsWith('/tmp/')) values.push('/private' + value)
  }
  return new Map([...new Set(values)].map(value => [sha256(value), value]))
}

function frozenFile(protocol, fileName) {
  const matches = protocol.inputs.filter(input => input.kind === 'file' && basename(input.path) === fileName)
  assert.equal(matches.length, 1, `Require exactly one frozen ${fileName}`)
  const input = matches[0], bytes = readFileSync(input.path)
  assert.equal(sha256(bytes), input.sha256, `Frozen source changed: ${fileName}`)
  assert.equal(bytes.length, input.bytes)
  return { ...input, bytes }
}

function existingFiles(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    assert(!entry.isSymbolicLink(), 'Published evidence cannot use symlinks')
    if (entry.isDirectory()) return existingFiles(directory, path)
    assert(entry.isFile(), 'Published evidence must be ordinary files')
    return [path]
  })
}

export async function prepareGuidedPublication({ study, destination, auditPath, repository = resolve(import.meta.dirname, '..'), extraPrefixes = [], temporaryDirectory = process.env.TMPDIR }) {
  study = resolve(study); destination = resolve(destination); auditPath = resolve(auditPath); repository = resolve(repository)
  const privateReportPath = join(study, 'report-private.json'), privateReportBytes = readFileSync(privateReportPath)
  const report = JSON.parse(privateReportBytes), privateProtocolBytes = readFileSync(join(study, 'protocol.json'))
  const wrapperBytes = readFileSync(join(destination, 'protocol.json')), wrapper = JSON.parse(wrapperBytes)
  const privateAuditBytes = readFileSync(auditPath), privateAudit = JSON.parse(privateAuditBytes)
  assert.equal(report.complete, true, 'Publish after every scheduled run has been retained')
  assert.equal(report.runs.length, 12)
  assert.equal(report.protocol.schedule.length, 12)
  assert.equal(report.protocolSha256, sha256(privateProtocolBytes))
  assert.deepEqual(report.protocol, JSON.parse(privateProtocolBytes))
  assert.equal(wrapper.privateProtocolSha256, report.protocolSha256)
  assert.deepEqual(wrapper.protocol, normalizeProtocol(report.protocol, { repository, temporaryDirectory }), 'Public preregistration may change only declared paths and PATH fields')
  assert.equal(new Set(report.runs.map(run => run.id)).size, 12)
  for (const [index, run] of report.runs.entries()) {
    assert(safeId(run.id), 'Run IDs must be single safe path components')
    for (const field of ['id', 'task', 'repeat', 'arm']) assert.equal(run[field], report.protocol.schedule[index][field])
  }
  verifyAudit(privateAudit, report, privateReportBytes)

  const sources = ['decision.mjs', 'workflow-review.mjs', 'adjudicate.mjs', 'monorepo-tool-outputs.mjs'].map(name => frozenFile(report.protocol, name))
  const decisionSource = sources.find(source => basename(source.path) === 'decision.mjs')
  const { evaluateDecision } = await import(pathToFileURL(decisionSource.path).href)
  const extractorSource = sources.find(source => basename(source.path) === 'monorepo-tool-outputs.mjs')
  assert.equal(extractorSource.sha256, report.protocol.supplementalOutputs.extractorSha256)
  const { extractToolOutputs } = await import(pathToFileURL(extractorSource.path).href)
  const { adjudicate } = await import(pathToFileURL(sources.find(source => basename(source.path) === 'adjudicate.mjs').path).href)
  assert.deepEqual(report.decision, evaluateDecision(report), 'Original automatic pending decision must remain unchanged')

  const files = new Map(), entries = [], publicRecords = {}, publicOutputs = {}, outputReceipts = []
  const add = (path, bytes, kind) => {
    assert(!files.has(path) && !path.startsWith('/') && !path.split('/').includes('..'))
    bytes = Buffer.from(bytes); assertPublicBytes(bytes)
    files.set(path, bytes); entries.push({ path, sha256: sha256(bytes), bytes: bytes.length, kind })
  }
  for (const path of existingFiles(destination)) {
    assert(path === 'protocol.json' || path === 'protocol-001.json' || path.startsWith('pilot-001/'), `Refuse to overwrite or silently absorb an existing publication: ${path}`)
    add(path, readFileSync(join(destination, path)), path === 'protocol.json' ? 'preregistration' : 'retained-pilot')
  }
  const pilot = readJson(join(destination, 'pilot-001/report.json'))
  assert.equal(pilot.confirmatoryComparisonEligible, false)
  assert.equal(pilot.runs.length, 3)
  for (const run of pilot.runs) {
    assert(safeId(run.id) && run.evidence === `runs/${run.id}.json`)
    assert.equal(sha256(files.get(`pilot-001/${run.evidence}`)), run.evidenceSha256, 'Retain exact pilot evidence bytes')
  }
  for (const source of sources) add(basename(source.path), source.bytes, 'frozen-source')

  const globalRules = [[study, '$STUDY'], [repository, '$REPOSITORY'], [homedir(), '$USER_HOME']]
  const publicRuns = report.runs.map((run, index) => {
    const runRoot = join(study, 'runs', run.id), recordBytes = readFileSync(join(runRoot, 'public-evidence.json'))
    assert.equal(sha256(recordBytes), run.evidenceSha256, `Public action record changed: ${run.id}`)
    const record = JSON.parse(recordBytes), { evidenceSha256, ...measurements } = run
    const rules = [[join(runRoot, 'workspace'), '$WORKSPACE'], [join(runRoot, 'provider-state'), '$PROVIDER_STATE'], ...globalRules]
    assert.deepEqual(record.run, normalizeDemo(measurements, rules), 'Public record must preserve every run measurement, including unknowns')
    const prompt = report.protocol.prompts.find(item => item.task === run.task && item.arm === run.arm)
    assert(prompt && digest(prompt.promptSha256))
    assert.equal(sha256(prompt.prompt), prompt.promptSha256)
    assert.equal(record.prompt, prompt.prompt)
    assert.equal(run.promptSha256, prompt.promptSha256)
    const evidence = `runs/${run.id}/public-evidence.json`
    add(evidence, recordBytes, 'exact-public-evidence'); publicRecords[run.id] = recordBytes.toString('utf8')

    const outputPath = join(runRoot, 'tool-outputs.json'), unavailablePath = join(runRoot, 'tool-outputs-unavailable.json')
    assert(existsSync(outputPath) !== existsSync(unavailablePath), 'Require either a bound supplement or an explicit unavailable-output receipt for every run')
    if (existsSync(outputPath)) {
      const outputBytes = readFileSync(outputPath), output = JSON.parse(outputBytes)
      verifySupplement(output, record, evidenceSha256)
      assert.equal(privateAudit.runs[index].toolOutputsSha256, sha256(outputBytes), 'Independent audit must bind the exact supplement')
      const known = prefixCandidates({ repository, study, runId: run.id, extraPrefixes })
      const replacements = output.normalization.prefixes.map(rule => {
        assert(known.has(rule.prefixSha256), `Unknown normalization prefix digest: ${rule.prefixSha256}`)
        return [known.get(rule.prefixSha256), rule.replacement]
      })
      const regenerated = extractToolOutputs({ raw: readFileSync(join(runRoot, 'capture/raw-events.jsonl')), publicRecordBytes: recordBytes, expectedPublicRecordSha256: evidenceSha256, replacements })
      assert.deepEqual(output, regenerated, 'Supplement must reproduce from allowlisted raw tool events')
      const toolOutputs = `runs/${run.id}/tool-outputs.json`
      add(toolOutputs, outputBytes, 'exact-tool-outputs'); publicOutputs[run.id] = outputBytes.toString('utf8')
      outputReceipts.push({ id: run.id, status: 'available', path: toolOutputs, sha256: sha256(outputBytes), originalRawSha256: run.rawSha256, originalPublicRecordSha256: evidenceSha256, reextractedAndMatched: true })
      return { ...record.run, evidenceSha256, evidence, toolOutputs, toolOutputsSha256: sha256(outputBytes) }
    }
    const unavailableBytes = readFileSync(unavailablePath), unavailable = JSON.parse(unavailableBytes)
    assert.equal(unavailable.schemaVersion, 1); assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.runId, run.id)
    assert.equal(unavailable.publicRecordSha256, evidenceSha256); assert.equal(unavailable.rawCaptureSha256, run.rawSha256 ?? null)
    assert(typeof unavailable.reason === 'string' && unavailable.reason.trim().length >= 20)
    assert.equal(privateAudit.runs[index].toolOutputsSha256 ?? null, null)
    assert.equal(privateAudit.runs[index].returnedEvidence, 'unknown', 'Unavailable outputs require an unknown returned-evidence judgment')
    const unavailableEvidence = `runs/${run.id}/tool-outputs-unavailable.json`
    add(unavailableEvidence, unavailableBytes, 'unavailable-tool-outputs')
    outputReceipts.push({ id: run.id, status: 'unavailable', path: unavailableEvidence, sha256: sha256(unavailableBytes), originalRawSha256: run.rawSha256 ?? null, originalPublicRecordSha256: evidenceSha256, reextractedAndMatched: false })
    return { ...record.run, evidenceSha256, evidence, toolOutputs: null, toolOutputsSha256: null, unavailableToolOutputs: unavailableEvidence }
  })

  const originalReportSha256 = sha256(privateReportBytes), originalAuditSha256 = sha256(privateAuditBytes)
  const publicReport = { ...normalizeDemo(report, globalRules), protocol: wrapper.protocol, runs: publicRuns, publication: {
    originalPrivateReportSha256: originalReportSha256, originalPrivateAuditSha256: originalAuditSha256,
    protocol: 'protocol.json', workflowAudit: 'workflow-audit.json', adjudication: 'adjudication.json', normalization: 'normalization.json', retainedPilot: 'pilot-001/report.json',
    originalDecisionUnchanged: true, originalPrivateFilesUnchanged: true,
    evidenceBoundary: 'Every scheduled run is retained. Original public action records and normalized tool-output supplements are copied exactly. No model reasoning or assistant message bodies are exported. The report decision remains the original automatic decision; independent workflow review is applied only in adjudication.json.',
  } }
  assert.deepEqual(publicReport.decision, report.decision)
  assert.deepEqual(publicReport.decision, evaluateDecision(publicReport))
  const publicReportBytes = jsonBytes(publicReport), publicReportSha256 = sha256(publicReportBytes)
  add('report.json', publicReportBytes, 'normalized-report')
  const publicAudit = { ...normalizeDemo(privateAudit, globalRules), reportSha256: publicReportSha256, publicationBinding: {
    originalPrivateReportSha256: originalReportSha256, originalPrivateAuditSha256: originalAuditSha256, publicReportSha256,
    normalization: 'normalization.json', judgmentsAndActionIdsUnchanged: true,
  } }
  for (const [index, row] of privateAudit.runs.entries()) {
    for (const key of Object.keys(row).filter(key => !['rationale', 'limitations'].includes(key))) assert.deepEqual(publicAudit.runs[index][key], row[key], `Do not alter an independent judgment: ${key}`)
  }
  const publicAuditBytes = jsonBytes(publicAudit)
  add('workflow-audit.json', publicAuditBytes, 'rebound-workflow-audit')
  const privateAdjudication = adjudicate(privateReportPath, auditPath)
  const reviewedDecision = evaluateDecision(publicReport, { report: publicReport, reportBytes: publicReportBytes.toString('utf8'), publicRecords, publicOutputs, audit: publicAudit })
  const expectedReviewedDecision = normalizeDemo(privateAdjudication.decision, globalRules)
  if (expectedReviewedDecision.workflowReview) expectedReviewedDecision.workflowReview.auditReportSha256 = publicReportSha256
  assert.deepEqual(reviewedDecision, expectedReviewedDecision, 'Publication must not change the reviewed outcome')
  const adjudication = { schemaVersion: 1, createdAt: privateAdjudication.createdAt, reportSha256: publicReportSha256, workflowAuditSha256: sha256(publicAuditBytes), protocolSha256: report.protocolSha256, originalReportUnchanged: true, decision: reviewedDecision }
  const adjudicationBytes = jsonBytes(adjudication)
  add('adjudication.json', adjudicationBytes, 'reviewed-adjudication')

  const normalization = {
    schemaVersion: 1, kind: 'guided-publication-normalization',
    original: { reportSha256: originalReportSha256, workflowAuditSha256: originalAuditSha256, protocolSha256: report.protocolSha256 },
    public: { reportSha256: publicReportSha256, workflowAuditSha256: sha256(publicAuditBytes), protocolWrapperSha256: sha256(wrapperBytes), adjudicationSha256: sha256(adjudicationBytes) },
    rules: { protocol: wrapper.normalization, report: 'Runner-normalized run objects copied without measurement changes. Other private study, repository and home paths use named placeholders. Public relative evidence links and publication bindings are added.', audit: 'Independent judgments and action IDs are unchanged. Private machine paths in prose are normalized. reportSha256 is explicitly rebound to public report bytes; original hashes remain recorded.' },
    originalFilesUnchanged: true, automaticDecisionUnchanged: true, reviewedDecisionUnchanged: true, allScheduledRunsRetained: true, judgmentsAndActionIdsUnchanged: true,
    changes: { report: normalizationChanges(report, publicReport), workflowAudit: normalizationChanges(privateAudit, publicAudit), protocol: normalizationChanges(report.protocol, wrapper.protocol) },
    supplements: outputReceipts,
    exactCopies: entries.filter(entry => ['exact-public-evidence', 'exact-tool-outputs', 'unavailable-tool-outputs', 'frozen-source', 'retained-pilot', 'preregistration'].includes(entry.kind)),
    exporter: { sourceSha256: sha256(readFileSync(import.meta.filename)), normalizerSha256: sha256(readFileSync(join(import.meta.dirname, 'demo-evidence.mjs'))) },
  }
  add('normalization.json', jsonBytes(normalization), 'normalization-receipt')
  const manifest = { schemaVersion: 1, kind: 'guided-agent-publication', protocolSha256: report.protocolSha256, runCount: publicRuns.length, files: entries.toSorted((a, b) => a.path.localeCompare(b.path)), manifestExcludesItself: true }
  add('manifest.json', jsonBytes(manifest), 'manifest')
  assert.equal(sha256(readFileSync(privateReportPath)), originalReportSha256, 'Private report changed during export')
  assert.equal(sha256(readFileSync(auditPath)), originalAuditSha256, 'Private audit changed during export')
  return { files, report: publicReport, adjudication, normalization, manifest }
}

export async function exportGuidedPublication(options) {
  const destination = resolve(options.destination), prepared = await prepareGuidedPublication(options)
  // Validate the entire bundle before writing. Existing preregistration and pilot bytes are never rewritten.
  for (const [path, bytes] of prepared.files) {
    const target = join(destination, path)
    if (existsSync(target)) { assert(lstatSync(target).isFile()); assert.equal(sha256(readFileSync(target)), sha256(bytes)); continue }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o644 })
  }
  return { exported: destination, runs: prepared.report.runs.length, originalDecision: prepared.report.decision, reviewedDecision: prepared.adjudication.decision, manifestSha256: sha256(prepared.files.get('manifest.json')) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [study, destination, auditPath, prefixFile] = process.argv.slice(2)
  assert(study && destination && auditPath, 'Use STUDY_DIRECTORY PUBLIC_DESTINATION PRIVATE_WORKFLOW_AUDIT [EXTRA_PREFIX_PAIRS_JSON]')
  console.log(JSON.stringify(await exportGuidedPublication({ study, destination, auditPath, extraPrefixes: prefixFile ? readJson(prefixFile) : [] })))
}
