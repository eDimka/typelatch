import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { extractToolOutputs } from './monorepo-tool-outputs.mjs'
import { assertPublicBytes, exportGuidedPublication, normalizationChanges, normalizeProtocol, prepareGuidedPublication, sha256, verifySupplement } from './guided-agent-export.mjs'

const repository = resolve(import.meta.dirname, '..')
const publicSource = join(repository, 'docs/benchmarks/monorepo-guided-study')
const gateSource = existsSync(join(publicSource, 'decision.mjs')) ? publicSource : join(repository, 'artifacts/research/large-monorepo/inventory-agent-trial')
const { decisionGate, evaluateDecision, makeSchedule } = await import(pathToFileURL(join(gateSource, 'decision.mjs')).href)
const { guidedReviewRules } = await import(pathToFileURL(join(gateSource, 'workflow-review.mjs')).href)
const encode = value => JSON.stringify(value, null, 2) + '\n'
const save = (path, value) => { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : encode(value)) }

function fixture(t, { failed = false, unknown = false, unavailable = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'guided-export-test-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const study = join(temporary, 'study'), destination = join(temporary, 'publication'), source = join(temporary, 'frozen')
  mkdirSync(source, { recursive: true }); mkdirSync(destination)
  const inputs = ['decision.mjs', 'workflow-review.mjs', 'adjudicate.mjs', 'monorepo-tool-outputs.mjs'].map(name => {
    const bytes = readFileSync(name === 'monorepo-tool-outputs.mjs' ? join(repository, 'scripts', name) : join(gateSource, name)), path = join(source, name)
    writeFileSync(path, bytes)
    return { path, kind: 'file', sha256: sha256(bytes), bytes: bytes.length }
  })
  const tasks = [{ id: 'rename' }, { id: 'migration' }], schedule = makeSchedule(tasks.map(task => task.id))
  const prompts = tasks.flatMap(task => ['native', 'packet', 'competitor'].map(arm => { const prompt = `Common task ${task.id}. Actual provider: ${arm}.`; return { task: task.id, arm, inventory: arm, prompt, promptSha256: sha256(prompt) } }))
  const protocol = { schemaVersion: 1, repeats: 2, candidates: ['packet'], tasks, prompts, schedule, decisionGate, workflowReviewRules: guidedReviewRules, inputs, supplementalOutputs: { extractorSha256: inputs.find(input => basename(input.path) === 'monorepo-tool-outputs.mjs').sha256 }, secretEnvironment: { PATH: '/private/executable/path', OTHER: join(repository, 'src') } }
  const protocolBytes = encode(protocol), report = { complete: true, protocolSha256: sha256(protocolBytes), protocol, runs: [], preparationAttempts: [] }, auditRows = []
  save(join(study, 'protocol.json'), protocolBytes)
  save(join(destination, 'protocol.json'), { schemaVersion: 1, kind: 'public-preregistration', privateProtocolSha256: report.protocolSha256, normalization: 'Exact declared path replacement and PATH omission.', protocol: normalizeProtocol(protocol, { repository }) })
  save(join(destination, 'protocol-001.json'), { status: 'retained-pilot-protocol' })
  const pilotRuns = ['native', 'packet', 'competitor'].map(arm => { const id = `pilot-${arm}`, bytes = encode({ run: { id }, actions: [] }); save(join(destination, `pilot-001/runs/${id}.json`), bytes); return { id, evidence: `runs/${id}.json`, evidenceSha256: sha256(bytes) } })
  save(join(destination, 'pilot-001/report.json'), { confirmatoryComparisonEligible: false, runs: pilotRuns })

  for (const [index, slot] of schedule.entries()) {
    const runRoot = join(study, 'runs', slot.id), candidate = slot.arm === 'packet', provider = slot.arm !== 'native'
    const first = { id: `${slot.id}:check`, type: 'command_execution', status: 'completed', command: 'npm run test:typelatch-benchmark', aggregated_output: 'Public check failed.', exit_code: 1 }
    const investigate = provider
      ? { id: `${slot.id}:read`, type: 'mcp_tool_call', status: 'completed', server: slot.arm === 'packet' ? 'typelatch_packet' : 'serena', tool: slot.arm === 'packet' ? 'workspace_evidence' : 'serena_repl', result: { content: [{ type: 'text', text: 'export function relevantSource() {}' }] }, error: null }
      : { id: `${slot.id}:read`, type: 'command_execution', status: 'completed', command: 'rg relevantSource src', aggregated_output: 'src/example.ts:1:export function relevantSource() {}', exit_code: 0 }
    const raw = [JSON.stringify({ type: 'item.completed', item: { id: 'private', type: 'reasoning', text: 'DO_NOT_EXPORT_PRIVATE_THOUGHT' } }), ...[first, investigate].map(item => JSON.stringify({ type: 'item.completed', item }))].join('\n') + '\n'
    const actions = [first, investigate].map(item => item.type === 'command_execution'
      ? { idSha256: sha256(item.id), type: item.type, status: item.status, command: item.command, outputSha256: sha256(item.aggregated_output), outputBytes: Buffer.byteLength(item.aggregated_output), exitCode: item.exit_code }
      : { idSha256: sha256(item.id), type: item.type, status: item.status, server: item.server, tool: item.tool, resultSha256: sha256(JSON.stringify(item.result)), resultBytes: Buffer.byteLength(JSON.stringify(item.result)), hasResult: true, hasError: false })
    actions.push({ idSha256: sha256(slot.id + ':edit'), type: 'file_change' })
    const prompt = prompts.find(prompt => prompt.task === slot.task && prompt.arm === slot.arm)
    const run = { ...slot, status: failed && index === 0 ? 'failed' : 'completed', exitCode: failed && index === 0 ? 1 : 0, timedOut: false, processGroupStopped: true, providerStopped: true, capture: { complete: !(failed && index === 0) }, correct: failed && index === 0 ? null : true, elapsedMs: candidate ? 60 : 100, providerSetupMs: candidate ? 10 : 0, usage: { inputTokens: candidate ? 60 : 90, outputTokens: 10, totalTokens: candidate ? 70 : 100 }, counts: { mcpCalls: provider ? 1 : 0, mcpSucceeded: provider ? 1 : 0 }, nativeValidation: { failingThenLaterCheckObserved: true, checks: [{ passed: false, actionIdSha256: sha256(first.id) }, { passed: true }] }, rawSha256: sha256(raw), promptSha256: prompt.promptSha256 }
    const record = { schemaVersion: 1, run: structuredClone(run), prompt: prompt.prompt, actions, grading: { passed: run.correct }, changes: [] }, recordBytes = encode(record)
    run.evidenceSha256 = sha256(recordBytes)
    save(join(runRoot, 'capture/raw-events.jsonl'), raw); save(join(runRoot, 'public-evidence.json'), recordBytes)
    let toolOutputsSha256 = null
    if (unavailable && index === 0) save(join(runRoot, 'tool-outputs-unavailable.json'), { schemaVersion: 1, runId: run.id, status: 'unavailable', rawCaptureSha256: run.rawSha256, publicRecordSha256: run.evidenceSha256, reason: 'Retained incomplete output cannot establish returned content.' })
    else {
      const output = extractToolOutputs({ raw, publicRecordBytes: recordBytes, expectedPublicRecordSha256: run.evidenceSha256, replacements: [[study, '$STUDY'], [repository, '$REPOSITORY']] }), outputBytes = encode(output)
      toolOutputsSha256 = sha256(outputBytes); save(join(runRoot, 'tool-outputs.json'), outputBytes)
    }
    auditRows.push({ id: run.id, evidenceSha256: run.evidenceSha256, toolOutputsSha256, instructionFollowed: unknown && index === 0 ? 'unknown' : 'pass', firstNativeCheckActionIdSha256: sha256(first.id), firstInvestigationActionIdSha256: sha256(investigate.id), providerRetrievalActionIdSha256: provider ? sha256(investigate.id) : null, taskRelevant: provider ? true : null, returnedEvidence: toolOutputsSha256 ? 'usable' : 'unknown', rationale: 'The cited investigation follows the public failing check and retrieves relevant implementation evidence.', limitations: [] })
    report.runs.push(run); report.preparationAttempts.push({ id: run.id, status: 'ready' })
  }
  report.decision = evaluateDecision(report)
  const reportBytes = encode(report), auditPath = join(study, 'independent-workflow-audit.json')
  save(join(study, 'report-private.json'), reportBytes)
  save(auditPath, { schemaVersion: 1, reportSha256: sha256(reportBytes), protocolSha256: report.protocolSha256, reviewer: 'independent-synthetic-review', noPrivateReasoningOrMessages: true, runs: auditRows })
  return { study, destination, auditPath, repository }
}

test('protocol normalization changes only declared paths and omits PATH symmetrically', () => {
  const result = normalizeProtocol({ PATH: '/secret/bin', nested: { PATH: 'hidden', keep: '/repo/x /users/name/y /temp/z' }, number: 7 }, { repository: '/repo', userHome: '/users/name', temporaryDirectory: '/temp/' })
  assert.deepEqual(result, { nested: { keep: '$REPOSITORY/x $HOME/y $TEMP/z' }, number: 7 })
})

test('normalization receipts expose field digests without private source values', () => {
  const changes = normalizationChanges({ path: '/Users/private/file', number: 3 }, { path: '$HOME/file', number: 3, link: 'runs/a.json' })
  assert.deepEqual(changes.map(row => row.pointer), ['/path', '/link'])
  assert(!JSON.stringify(changes).includes('/Users/private'))
  assert.equal(changes[1].beforePresent, false)
  assert.throws(() => assertPublicBytes('/Users/private/file'))
})

test('public export retains pending decision and separately recomputes reviewed qualified outcome', async t => {
  const options = fixture(t), privateBefore = readFileSync(join(options.study, 'report-private.json')), auditBefore = readFileSync(options.auditPath)
  const prepared = await prepareGuidedPublication(options)
  assert.equal(prepared.report.decision.anyQualifiedWin, false)
  assert.equal(prepared.adjudication.decision.anyQualifiedWin, true)
  assert.equal(prepared.report.runs.length, 12)
  assert.equal(prepared.manifest.files.filter(entry => entry.kind === 'exact-public-evidence').length, 12)
  assert.equal(prepared.manifest.files.filter(entry => entry.kind === 'exact-tool-outputs').length, 12)
  assert.equal(prepared.manifest.files.filter(entry => entry.kind === 'retained-pilot').length, 5)
  assert.equal(prepared.normalization.original.reportSha256, sha256(privateBefore))
  assert.equal(prepared.adjudication.reportSha256, sha256(prepared.files.get('report.json')))
  for (const bytes of prepared.files.values()) assert(!bytes.toString().includes('DO_NOT_EXPORT_PRIVATE_THOUGHT'))
  assert.deepEqual(readFileSync(join(options.study, 'report-private.json')), privateBefore)
  assert.deepEqual(readFileSync(options.auditPath), auditBefore)
})

test('failed captures and unknown reviews stay visible and cannot turn into a qualified win', async t => {
  for (const condition of [{ failed: true }, { unknown: true }, { failed: true, unavailable: true }]) {
    const prepared = await prepareGuidedPublication(fixture(t, condition))
    assert.equal(prepared.report.runs.length, 12)
    assert.notEqual(prepared.adjudication.decision.anyQualifiedWin, true)
    if (condition.failed) assert.equal(prepared.report.runs[0].correct, null)
    if (condition.unavailable) { assert.equal(prepared.report.runs[0].toolOutputs, null); assert.equal(prepared.normalization.supplements[0].status, 'unavailable') }
  }
})

test('unavailable output cannot be classified as usable, empty or failed content', async t => {
  for (const returnedEvidence of ['usable', 'empty', 'failed']) {
    const options = fixture(t, { failed: true, unavailable: true }), audit = JSON.parse(readFileSync(options.auditPath))
    audit.runs[0].returnedEvidence = returnedEvidence
    save(options.auditPath, audit)
    await assert.rejects(prepareGuidedPublication(options), /unknown returned-evidence/u)
  }
})

test('tampered public protocol, action record, output or original audit is rejected before publication', async t => {
  for (const target of ['protocol', 'action', 'output', 'output-resealed', 'audit']) {
    const options = fixture(t), id = 'rename-r1-native'
    if (target === 'protocol') { const path = join(options.destination, 'protocol.json'), value = JSON.parse(readFileSync(path)); value.protocol.prompts[0].prompt += ' altered'; save(path, value) }
    if (target === 'action') { const path = join(options.study, 'runs', id, 'public-evidence.json'); writeFileSync(path, readFileSync(path, 'utf8') + ' ') }
    if (target.startsWith('output')) {
      const path = join(options.study, 'runs', id, 'tool-outputs.json'), value = JSON.parse(readFileSync(path))
      value.actions[1].stdout = 'fabricated'; save(path, value)
      if (target === 'output-resealed') { const audit = JSON.parse(readFileSync(options.auditPath)); audit.runs[0].toolOutputsSha256 = sha256(readFileSync(path)); save(options.auditPath, audit) }
    }
    if (target === 'audit') { const value = JSON.parse(readFileSync(options.auditPath)); value.reportSha256 = sha256('wrong'); save(options.auditPath, value) }
    await assert.rejects(prepareGuidedPublication(options), target === 'output-resealed' ? /reproduce from allowlisted/u : undefined)
    assert(!existsSync(join(options.destination, 'manifest.json')))
  }
})

test('supplement verifies all completed tool actions without filtering failures', () => {
  const action = { idSha256: sha256('a'), type: 'command_execution', status: 'failed', outputSha256: sha256('failure'), outputBytes: 7, exitCode: 1 }, record = { run: { id: 'a', rawSha256: sha256('raw') }, actions: [action] }
  const supplement = { schemaVersion: 1, runId: 'a', rawCaptureSha256: record.run.rawSha256, publicRecordSha256: sha256('public'), actions: [action] }
  verifySupplement(supplement, record, sha256('public'))
  assert.throws(() => verifySupplement({ ...supplement, actions: [] }, record, sha256('public')))
})

test('write preserves pre-existing pilot bytes and refuses an accidental second export', async t => {
  const options = fixture(t), pilotPath = join(options.destination, 'pilot-001/report.json'), before = readFileSync(pilotPath)
  await exportGuidedPublication(options)
  assert.deepEqual(readFileSync(pilotPath), before)
  const manifest = JSON.parse(readFileSync(join(options.destination, 'manifest.json')))
  for (const file of manifest.files) { const bytes = readFileSync(join(options.destination, file.path)); assert.equal(sha256(bytes), file.sha256); assert.equal(bytes.length, file.bytes) }
  await assert.rejects(exportGuidedPublication(options), /existing publication/u)
})
