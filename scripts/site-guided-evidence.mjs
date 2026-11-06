import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { verifyAgentRecord, verifyAgentRun } from './site-monorepo-benchmark.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const safeId = value => typeof value === 'string' && /^[a-z0-9-]+$/u.test(value)
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message)
const parse = bytes => JSON.parse(bytes.toString())
const dataModule = bytes => `data:text/javascript;base64,${Buffer.from(bytes).toString('base64')}`
const publicProtocolSha256 = 'ca4de71b54f1f15626d0d97233928b091810139c938149ec565f668fd1c1c701'
const publicPilotProtocolSha256 = 'cfe476bf51ba426fd27c28a1fcbdd4e726126ed56be62c37f8e357d6aad97813'
export const frozenGuidedSources = Object.freeze({
  'decision.mjs': '3efebebc8a4405f544edbcb2f6691745cd9db1c6ba4f88c115a86431aca1b279',
  'workflow-review.mjs': '656686c61700f399fb241d892a5f79536e182f76f7cf87f0d7a968d8410a94e1',
  'adjudicate.mjs': '42bad53cdb5f24778893d6bb7c47a421dfa9004908c385c9935e846d508b57b9',
  'monorepo-tool-outputs.mjs': 'a9d392a262a155e4a2272d7b228decc1e1527a22028f87b8c66feee5c14c2575',
})

function verifyOutputs(bytes, record, run) {
  const output = parse(bytes)
  equal(output.schemaVersion, 1, 'Known full tool output schema')
  equal(output.runId, run.id, 'Returned evidence belongs to its run')
  equal(output.rawCaptureSha256, run.rawSha256, 'Returned evidence retains the original capture identity')
  equal(output.publicRecordSha256, run.evidenceSha256, 'Returned evidence binds its exact public action record')
  const actions = record.actions.filter(action => ['command_execution', 'mcp_tool_call'].includes(action.type))
  equal(output.actions.map(action => action.idSha256), actions.map(action => action.idSha256), 'Every completed public tool output is retained in order')
  assert(Number.isSafeInteger(output.identicalCompletedDuplicates) && output.identicalCompletedDuplicates >= 0)
  for (const [index, returned] of output.actions.entries()) {
    const action = actions[index]
    for (const key of ['type', 'status']) equal(returned[key], action[key], 'Returned action metadata matches its public record')
    assert(Number.isSafeInteger(returned.originalLine) && returned.originalLine > 0)
    if (action.type === 'command_execution') {
      for (const key of ['outputSha256', 'outputBytes', 'exitCode']) equal(returned[key], action[key], 'Original shell output identity is retained')
      assert(returned.stdout === null || typeof returned.stdout === 'string', 'Normalized shell output stays explicit')
    } else {
      for (const key of ['server', 'tool', 'resultSha256', 'resultBytes']) equal(returned[key], action[key], 'Original MCP result identity is retained')
      equal(returned.result !== null, action.hasResult, 'MCP result absence is preserved')
      equal(returned.error !== null, action.hasError, 'MCP failure absence is preserved')
    }
  }
  assert(Array.isArray(output.normalization?.prefixes), 'Output normalization remains declared')
  for (const rule of output.normalization.prefixes) assert(digest(rule.prefixSha256) && /^\$[A-Z][A-Z0-9_]*$/u.test(rule.replacement), 'Private prefixes retain digests and named replacements')
  return output
}

function promptFor(protocol, run) {
  const task = protocol.tasks.find(task => task.id === run.task)
  const sent = protocol.prompts.find(prompt => prompt.task === run.task && prompt.arm === run.arm)
  assert(task && sent, 'Every run has its own frozen provider inventory prompt')
  return { ...task, prompt: sent.prompt, promptSha256: sent.promptSha256 }
}

function publicValueAtPointer(root, pointer) {
  let value = root
  for (const key of pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { present: false }
    value = value[key]
  }
  return { present: true, value }
}

function verifyReport(report, wrapper, gate) {
  equal(report.schemaVersion, 1, 'Known guided study schema')
  equal(report.complete, true, 'Publish only after every guided session is retained')
  equal(wrapper.schemaVersion, 1, 'Known guided protocol wrapper')
  assert(digest(report.protocolSha256))
  equal(report.protocolSha256, wrapper.privateProtocolSha256, 'Public protocol retains the original frozen identity')
  equal(report.protocol, wrapper.protocol, 'Public report and protocol are identical after documented normalization')
  const protocol = report.protocol
  equal(protocol.candidates, ['packet'], 'Keep the original candidate and both controls')
  equal(protocol.repeats, 2)
  equal(protocol.runCount, 12)
  equal(protocol.tasks.length, 2)
  equal(protocol.prompts.length, 6, 'Each task has all three explicit inventories')
  equal(protocol.decisionGate, gate.decisionGate, 'The frozen decision gate remains unchanged')
  equal(protocol.schedule, gate.makeSchedule(protocol.tasks.map(task => task.id)), 'Preserve the counterbalanced twelve-session schedule')
  equal(report.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm })), protocol.schedule, 'Retain every session in the frozen order')
  equal(new Set(protocol.prompts.map(prompt => `${prompt.task}:${prompt.arm}`)).size, 6)
  for (const prompt of protocol.prompts) {
    assert(protocol.tasks.some(task => task.id === prompt.task) && ['native', 'packet', 'competitor'].includes(prompt.arm))
    equal(hash(prompt.prompt), prompt.promptSha256, 'Exact sent prompts retain their original digest')
  }
  equal(report.preparationAttempts?.length, 12, 'Every preparation attempt remains recorded')
  const fixtures = new Map()
  for (const [index, run] of report.runs.entries()) {
    verifyAgentRun(run, promptFor(protocol, run))
    const preparation = report.preparationAttempts[index]
    for (const key of ['id', 'task', 'repeat', 'arm', 'providerSetupMs']) equal(preparation[key], run[key], 'All provider preparation is charged to its session')
    assert(['ready', 'failed'].includes(preparation.status))
    if (fixtures.has(run.task)) equal(run.fixtureSha256, fixtures.get(run.task), 'All conditions start from matching task files')
    else fixtures.set(run.task, run.fixtureSha256)
  }
  equal(report.decision, gate.evaluateDecision(report), 'The original automatic decision stays unchanged')
}

export async function verifyGuidedEvidence(readPublic) {
  const reportBytes = readPublic('report.json'), report = parse(reportBytes)
  const wrapper = parse(readPublic('protocol.json')), manifestBytes = readPublic('manifest.json'), manifest = parse(manifestBytes)
  equal(manifest.schemaVersion, 1)
  equal(manifest.kind, 'guided-agent-publication')
  equal(manifest.protocolSha256, report.protocolSha256)
  equal(manifest.runCount, 12)
  equal(manifest.manifestExcludesItself, true)
  for (const run of report.runs) {
    assert(safeId(run.id), 'Run identity is a safe path component')
    equal(run.evidence, `runs/${run.id}/public-evidence.json`, 'Exact public record link')
    if (run.toolOutputs === null) {
      equal(run.toolOutputsSha256, null)
      equal(run.unavailableToolOutputs, `runs/${run.id}/tool-outputs-unavailable.json`, 'Missing output has an exact receipt link')
    } else {
      equal(run.toolOutputs, `runs/${run.id}/tool-outputs.json`, 'Exact full output link')
      assert(digest(run.toolOutputsSha256))
    }
  }
  const pilot = parse(readPublic('pilot-001/report.json'))
  equal(pilot.schemaVersion, 1)
  equal(pilot.status, 'retained-methodological-pilot')
  equal(pilot.confirmatoryComparisonEligible, false, 'The earlier pilot is separate from the comparison')
  equal(pilot.runs.length, 3, 'All three pilot launches are retained')
  for (const run of pilot.runs) assert(safeId(run.id) && run.evidence === `runs/${run.id}.json`)
  const required = ['report.json', 'protocol.json', 'protocol-001.json', 'workflow-audit.json', 'adjudication.json', 'normalization.json', ...Object.keys(frozenGuidedSources), 'pilot-001/report.json', ...pilot.runs.map(run => `pilot-001/${run.evidence}`), ...report.runs.flatMap(run => [run.evidence, run.toolOutputs ?? run.unavailableToolOutputs])]
  equal(manifest.files.map(file => file.path).toSorted(), required.toSorted(), 'Public manifest contains every required artifact exactly once')
  const files = new Map()
  for (const file of manifest.files) {
    const bytes = readPublic(file.path)
    equal(hash(bytes), file.sha256, `Public artifact digest matches: ${file.path}`)
    equal(Buffer.byteLength(bytes), file.bytes, `Public artifact length matches: ${file.path}`)
    files.set(file.path, bytes)
  }
  for (const [name, expected] of Object.entries(frozenGuidedSources)) {
    equal(hash(files.get(name)), expected, `Use the exact frozen source: ${name}`)
    const inputs = report.protocol.inputs.filter(input => String(input.path).endsWith(`/${name}`))
    equal(inputs.length, 1, `Protocol binds one implementation: ${name}`)
    equal(inputs[0].sha256, expected)
  }
  equal(hash(files.get('protocol.json')), publicProtocolSha256, 'Public protocol bytes were frozen before model sessions')
  equal(hash(files.get('protocol-001.json')), publicPilotProtocolSha256, 'Original pilot protocol bytes remain unchanged')
  const workflowUrl = dataModule(files.get('workflow-review.mjs'))
  const workflow = await import(workflowUrl)
  const source = files.get('decision.mjs').toString()
  const importText = "from './workflow-review.mjs'"
  equal(source.split(importText).length, 2, 'Only the verified local workflow dependency is rebound for evaluation')
  const gate = await import(dataModule(source.replace(importText, `from '${workflowUrl}'`)))
  verifyReport(report, wrapper, gate)
  const publicRecords = {}, publicOutputs = {}
  for (const run of report.runs) {
    const bytes = files.get(run.evidence), record = parse(bytes)
    equal(hash(bytes), run.evidenceSha256, 'Exact public record matches the measured run')
    const { toolOutputs, toolOutputsSha256, unavailableToolOutputs, ...measured } = run
    verifyAgentRecord(record, measured, promptFor(report.protocol, run), report.protocol.config)
    if (toolOutputs !== null) {
      equal(hash(files.get(toolOutputs)), toolOutputsSha256)
      verifyOutputs(files.get(toolOutputs), record, run)
      publicOutputs[run.id] = files.get(toolOutputs).toString()
    } else {
      const unavailable = parse(files.get(unavailableToolOutputs))
      equal(unavailable.schemaVersion, 1)
      equal(unavailable.status, 'unavailable')
      equal(unavailable.runId, run.id)
      equal(unavailable.publicRecordSha256, run.evidenceSha256)
      equal(unavailable.rawCaptureSha256, run.rawSha256 ?? null)
      assert(typeof unavailable.reason === 'string' && unavailable.reason.trim().length >= 20)
    }
    publicRecords[run.id] = bytes.toString()
  }
  const auditBytes = files.get('workflow-audit.json'), audit = parse(auditBytes), adjudication = parse(files.get('adjudication.json'))
  equal(audit.schemaVersion, 1)
  equal(audit.reportSha256, hash(reportBytes), 'Review binds the exact public report bytes')
  equal(audit.protocolSha256, report.protocolSha256)
  equal(audit.noPrivateReasoningOrMessages, true)
  assert(typeof audit.reviewer === 'string' && audit.reviewer.trim())
  equal(audit.runs.map(row => row.id), report.runs.map(run => run.id), 'Every reviewed session remains in order')
  for (const [index, row] of audit.runs.entries()) {
    const run = report.runs[index]
    equal(row.evidenceSha256, run.evidenceSha256)
    equal(row.toolOutputsSha256, run.toolOutputsSha256, 'Review binds all normalized returned evidence')
    if (run.toolOutputs === null) equal(row.returnedEvidence, 'unknown', 'Unavailable output requires an unknown returned evidence state')
    assert(['pass', 'fail', 'unknown'].includes(row.instructionFollowed))
    assert(['usable', 'empty', 'failed', 'unknown'].includes(row.returnedEvidence))
  }
  equal(adjudication.schemaVersion, 1)
  equal(adjudication.originalReportUnchanged, true)
  equal(adjudication.reportSha256, hash(reportBytes))
  equal(adjudication.workflowAuditSha256, hash(auditBytes))
  equal(adjudication.protocolSha256, report.protocolSha256)
  const reviewContext = { reportBytes: reportBytes.toString(), publicRecords, publicOutputs, audit }
  equal(adjudication.decision, gate.evaluateDecision(report, reviewContext), 'The reviewed decision is recomputed from exact public evidence')
  const workflowReview = workflow.reviewGuidedWorkflow(report, reviewContext)
  const normalization = parse(files.get('normalization.json'))
  equal(normalization.schemaVersion, 1)
  equal(normalization.kind, 'guided-publication-normalization')
  equal(normalization.original.protocolSha256, report.protocolSha256)
  equal(normalization.original.reportSha256, report.publication.originalPrivateReportSha256)
  equal(normalization.original.workflowAuditSha256, report.publication.originalPrivateAuditSha256)
  equal(report.publication.originalDecisionUnchanged, true)
  equal(report.publication.originalPrivateFilesUnchanged, true)
  for (const value of Object.values(normalization.original)) assert(digest(value), 'Original publication receipts retain their digests')
  equal(normalization.public, { reportSha256: hash(reportBytes), workflowAuditSha256: hash(auditBytes), protocolWrapperSha256: hash(files.get('protocol.json')), adjudicationSha256: hash(files.get('adjudication.json')) }, 'Normalization receipts bind every transformed public artifact')
  for (const field of ['originalFilesUnchanged', 'automaticDecisionUnchanged', 'reviewedDecisionUnchanged', 'allScheduledRunsRetained', 'judgmentsAndActionIdsUnchanged']) equal(normalization[field], true, 'Publication preserves original evidence and judgments')
  equal(audit.publicationBinding, { originalPrivateReportSha256: normalization.original.reportSha256, originalPrivateAuditSha256: normalization.original.workflowAuditSha256, publicReportSha256: hash(reportBytes), normalization: 'normalization.json', judgmentsAndActionIdsUnchanged: true })
  const byPath = (a, b) => a.path.localeCompare(b.path)
  equal(normalization.exactCopies.toSorted(byPath), manifest.files.filter(entry => ['exact-public-evidence', 'exact-tool-outputs', 'unavailable-tool-outputs', 'frozen-source', 'retained-pilot', 'preregistration'].includes(entry.kind)).toSorted(byPath), 'Exact-copy receipts match published artifacts')
  equal(normalization.rules.protocol, wrapper.normalization)
  equal(normalization.supplements.length, 12)
  for (const [index, receipt] of normalization.supplements.entries()) {
    const run = report.runs[index], available = run.toolOutputs !== null
    equal(receipt, { id: run.id, status: available ? 'available' : 'unavailable', path: run.toolOutputs ?? run.unavailableToolOutputs, sha256: hash(files.get(run.toolOutputs ?? run.unavailableToolOutputs)), originalRawSha256: run.rawSha256 ?? null, originalPublicRecordSha256: run.evidenceSha256, reextractedAndMatched: available }, 'Every output has an explicit reproduction or unavailability receipt')
  }
  for (const field of ['report', 'workflowAudit', 'protocol']) {
    assert(Array.isArray(normalization.changes[field]))
    for (const change of normalization.changes[field]) {
      assert(typeof change.pointer === 'string' && change.pointer.startsWith('/'))
      for (const side of ['before', 'after']) assert(typeof change[`${side}Present`] === 'boolean' && (change[`${side}Present`] ? digest(change[`${side}ValueSha256`]) : change[`${side}ValueSha256`] === null))
      const after = publicValueAtPointer({ report, workflowAudit: audit, protocol: wrapper.protocol }[field], change.pointer)
      equal(change.afterPresent, after.present, 'Normalization change points to the published value or its recorded removal')
      if (after.present) equal(change.afterValueSha256, hash(JSON.stringify(after.value)), 'Normalization receipt matches the exact published field value')
    }
  }
  assert(digest(normalization.exporter.sourceSha256) && digest(normalization.exporter.normalizerSha256))
  const pilotWrapper = parse(files.get('protocol-001.json'))
  equal(pilot.privateProtocolSha256, pilotWrapper.privateProtocolSha256)
  equal(pilot.protocol, '../protocol-001.json')
  equal(pilot.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm })), pilotWrapper.protocol.schedule.slice(0, 3))
  for (const run of pilot.runs) {
    const task = pilotWrapper.protocol.tasks.find(task => task.id === run.task), bytes = files.get(`pilot-001/${run.evidence}`)
    verifyAgentRun(run, task)
    equal(hash(bytes), run.evidenceSha256)
    verifyAgentRecord(parse(bytes), run, task, pilotWrapper.protocol.config)
  }
  files.set('manifest.json', manifestBytes)
  return { report, wrapper, adjudication, audit, workflowReview, files, verify: () => {
    equal(report, parse(reportBytes), 'Verified measurements were not changed before rendering')
    equal(audit, parse(auditBytes), 'Verified workflow review was not changed before rendering')
    equal(adjudication.decision, gate.evaluateDecision(report, reviewContext), 'Rendered decision remains evidence bound')
    equal(workflowReview, workflow.reviewGuidedWorkflow(report, reviewContext), 'Rendered workflow states remain evidence bound')
  } }
}

export function verifyGuidedAnimation(verified, animation, readAsset, rendererBytes) {
  verified.verify()
  const { report, files } = verified, prefix = 'evidence/monorepo-guided-study/'
  equal(animation.schemaVersion, 1)
  equal(animation.kind, 'inventory-guided-public-action-replay')
  for (const [field, path] of [['report', 'report.json'], ['adjudication', 'adjudication.json'], ['protocol', 'protocol.json']]) equal(animation[field], { path: prefix + path, sha256: hash(files.get(path)) }, 'Replay binds the exact published study and reviewed outcome')
  equal(animation.protocolSha256, report.protocolSha256)
  equal(animation.renderer.path, 'scripts/monorepo-guided-gif.py')
  equal(animation.renderer.sha256, hash(rendererBytes), 'Replay binds its own renderer without changing the historical renderer')
  const selection = report.protocol.replaySelection
  equal(animation.task, selection.task)
  equal(animation.repeat, selection.repeat)
  equal(animation.arms, ['native', 'packet'])
  equal(animation.runs.map(run => run.id), selection.runIds, 'Replay keeps the pair chosen before results, including failures')
  for (const selected of animation.runs) {
    const run = report.runs.find(run => run.id === selected.id)
    equal(selected.evidence, prefix + run.evidence)
    equal(selected.evidenceSha256, run.evidenceSha256)
    equal(selected.toolOutputs, run.toolOutputs === null ? null : prefix + run.toolOutputs)
    equal(selected.toolOutputsSha256, run.toolOutputsSha256)
  }
  equal(animation.playback.accelerated, true)
  equal(animation.playback.separateSessionsAlignedAtStart, true)
  assert(typeof animation.playback.durationSeconds === 'number' && animation.playback.durationSeconds > 0 && animation.playback.durationSeconds <= 60)
  for (const [kind, path] of [['gif', 'assets/codex-guided-comparison.gif'], ['poster', 'assets/codex-guided-comparison.png']]) {
    const asset = animation.assets[kind], bytes = Buffer.from(readAsset(path))
    equal(asset.path, path)
    equal(hash(bytes), asset.sha256)
    equal(bytes.length, asset.bytes)
    if (kind === 'gif') {
      assert.match(bytes.subarray(0, 6).toString(), /^GIF8[79]a$/u)
      equal([bytes.readUInt16LE(6), bytes.readUInt16LE(8)], [asset.width, asset.height])
    } else {
      equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      equal([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [asset.width, asset.height])
    }
    assert(asset.width > 0 && asset.height > 0 && bytes.length <= 2_000_000, 'Replay stays bounded and has known intrinsic dimensions')
  }
  return animation
}
