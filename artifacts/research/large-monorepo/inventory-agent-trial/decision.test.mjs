import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { decisionGate, evaluateDecision, makeSchedule } from './decision.mjs'
import { guidedReviewRules } from './workflow-review.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
function fixture() {
  const tasks = [{ id: 'rename' }, { id: 'migration' }], schedule = makeSchedule(tasks.map(task => task.id), ['packet'])
  const runs = schedule.map(slot => {
    const candidate = slot.arm === 'packet', first = hash(slot.id + ':check')
    return { ...slot, status: 'completed', exitCode: 0, timedOut: false, processGroupStopped: true, providerStopped: true, capture: { complete: true }, nativeValidation: { failingThenLaterCheckObserved: true, checks: [{ passed: false, actionIdSha256: first }, { passed: true }] }, correct: true, elapsedMs: candidate ? 60 : 100, providerSetupMs: candidate ? 10 : 0, usage: { inputTokens: candidate ? 60 : 90, outputTokens: 10, totalTokens: candidate ? 70 : 100 }, counts: { mcpCalls: slot.arm === 'native' ? 0 : 1, mcpSucceeded: slot.arm === 'native' ? 0 : 1 } }
  })
  const report = { complete: true, protocolSha256: 'frozen-protocol', protocol: { repeats: 2, tasks, schedule, candidates: ['packet'], decisionGate, workflowReviewRules: guidedReviewRules }, runs, preparationAttempts: runs.map(run => ({ id: run.id, status: 'ready' })) }
  const publicRecords = {}, reviews = []
  for (const run of runs) {
    const check = run.nativeValidation.checks[0].actionIdSha256, investigation = hash(run.id + ':investigation')
    const provider = run.arm !== 'native'
    const actions = [
      { type: 'command_execution', idSha256: check, command: 'npm run test:typelatch-benchmark' },
      provider ? { type: 'mcp_tool_call', idSha256: investigation, server: run.arm === 'packet' ? 'typelatch_packet' : 'serena', tool: run.arm === 'packet' ? 'workspace_evidence' : 'serena_repl', hasError: false, arguments: { question: 'Find the implementation of the reported behavior' } } : { type: 'command_execution', idSha256: investigation, command: 'rg behavior src' },
      { type: 'file_change', idSha256: hash(run.id + ':edit') },
    ]
    const bytes = JSON.stringify({ run: { id: run.id }, actions })
    publicRecords[run.id] = bytes; run.evidenceSha256 = hash(bytes)
    reviews.push({ id: run.id, evidenceSha256: run.evidenceSha256, instructionFollowed: 'pass', firstNativeCheckActionIdSha256: check, firstInvestigationActionIdSha256: investigation, providerRetrievalActionIdSha256: provider ? investigation : null, taskRelevant: provider ? true : null, returnedEvidence: 'unknown', rationale: 'The cited first source query addresses the task behavior after its failing check.', limitations: [] })
  }
  const reportBytes = JSON.stringify(report), audit = { schemaVersion: 1, reportSha256: hash(reportBytes), protocolSha256: report.protocolSha256, reviewer: 'independent-reviewer', noPrivateReasoningOrMessages: true, runs: reviews }
  return { report, context: { reportBytes, publicRecords, audit } }
}
const evaluate = ({ report, context }) => evaluateDecision(report, context)
const rebindReport = value => { value.context.reportBytes = JSON.stringify(value.report); value.context.audit.reportSha256 = hash(value.context.reportBytes) }

test('12-session guided schedule reverses both task orders and fixes the packet candidate', () => {
  const { report } = fixture()
  assert.equal(report.runs.length, 12)
  for (const task of ['rename', 'migration']) assert.deepEqual(report.runs.filter(run => run.task === task && run.repeat === 1).map(run => run.arm).reverse(), report.runs.filter(run => run.task === task && run.repeat === 2).map(run => run.arm))
  assert.throws(() => makeSchedule(['a', 'b'], ['typelatch']))
})
test('both-control 20percent gate passes only with all correct and reviewed instructed use', () => {
  const result = evaluate(fixture())
  assert.equal(result.anyQualifiedWin, true)
  assert.equal(result.candidateDecisions.packet.comparisons.native.metrics.totalTokens.aggregateReductionPercent, 30)
  assert.equal(result.candidateDecisions.packet.comparisons.competitor.metrics.chargedTimeMs.aggregateReductionPercent, 30)
  assert.equal(result.workflowReview.runs.filter(run => run.adoption.attempted).length, 8)
})
test('pending independent review never creates a qualified win', () => {
  const { report } = fixture(), result = evaluateDecision(report)
  assert.equal(result.measurable, true)
  assert.equal(result.candidateDecisions.packet.economicGatePassed, true)
  assert.equal(result.anyQualifiedWin, false)
})
test('zero, irrelevant or startup-only provider calls cannot satisfy the guided policy', () => {
  for (const arm of ['packet', 'competitor']) for (const kind of ['missing', 'irrelevant', 'startup']) {
    const value = fixture(), run = value.report.runs.find(run => run.arm === arm), review = value.context.audit.runs.find(row => row.id === run.id)
    if (kind === 'missing') review.providerRetrievalActionIdSha256 = null
    if (kind === 'irrelevant') review.taskRelevant = false
    if (kind === 'startup') {
      const record = JSON.parse(value.context.publicRecords[run.id]); record.actions[1].tool = 'initial_instructions'
      const bytes = JSON.stringify(record); value.context.publicRecords[run.id] = bytes; run.evidenceSha256 = review.evidenceSha256 = hash(bytes); rebindReport(value)
    }
    assert.equal(evaluate(value).anyQualifiedWin, false)
  }
})
test('unknown instruction compliance, changed report or changed public evidence blocks a win', () => {
  for (const mutate of [v => { v.context.audit.runs[0].instructionFollowed = 'unknown' }, v => { v.context.audit.reportSha256 = 'other' }, v => { v.context.audit.protocolSha256 = 'other' }, v => { v.context.publicRecords[v.report.runs[0].id] += ' ' }, v => { v.context.audit.runs.pop() }, v => { v.context.audit.noPrivateReasoningOrMessages = false }]) {
    const value = fixture(); mutate(value); assert.equal(evaluate(value).anyQualifiedWin, false)
  }
})
test('a failed relevant provider attempt remains charged and can satisfy attempted-use policy', () => {
  const value = fixture(), run = value.report.runs.find(run => run.arm === 'packet'), review = value.context.audit.runs.find(row => row.id === run.id)
  const record = JSON.parse(value.context.publicRecords[run.id]); record.actions[1].hasError = true
  const bytes = JSON.stringify(record); value.context.publicRecords[run.id] = bytes; run.evidenceSha256 = review.evidenceSha256 = hash(bytes); review.returnedEvidence = 'failed'; rebindReport(value)
  assert.equal(evaluate(value).anyQualifiedWin, true)
})
test('stronger competitor, charged setup, median and repeat-direction losses block the economic gate', () => {
  for (const mutate of [
    v => { for (const run of v.report.runs.filter(r => r.arm === 'competitor')) Object.assign(run.usage, { inputTokens: 40, totalTokens: 50 }) },
    v => { for (const run of v.report.runs.filter(r => r.arm === 'packet')) run.providerSetupMs = 80 },
    v => { for (const [i, run] of v.report.runs.filter(r => r.arm === 'packet').entries()) Object.assign(run.usage, { inputTokens: i ? 80 : 0, totalTokens: i ? 90 : 10 }) },
    v => { for (const run of v.report.runs) if (run.arm === 'packet' && run.repeat === 2) run.elapsedMs = 100; else if (run.arm !== 'packet' && run.repeat === 1) run.elapsedMs = 1000 },
  ]) { const value = fixture(); mutate(value); rebindReport(value); assert.equal(evaluate(value).candidateDecisions.packet.economicGatePassed, false) }
})
test('one incorrect candidate run blocks all qualified-win claims even if both controls are wrong', () => {
  const value = fixture()
  for (const run of value.report.runs) if (run.task === 'rename' && run.repeat === 1) run.correct = false
  rebindReport(value); assert.equal(evaluate(value).anyQualifiedWin, false); assert.equal(evaluate(value).candidateDecisions.packet.economicGatePassed, false)
})
test('incomplete captures, skipped validation and altered protocol remain ineligible', () => {
  for (const mutate of [v => { v.report.runs.pop() }, v => { v.report.runs[0].providerStopped = false }, v => { v.report.runs[0].nativeValidation.checks.at(-1).passed = false }, v => { v.report.protocol.decisionGate = { ...decisionGate, minimumReductionPercent: 10 } }, v => { v.report.preparationAttempts[0].status = 'failed' }]) {
    const value = fixture(); mutate(value); assert.equal(evaluate(value).measurable, false)
  }
})

test('missing or changed frozen interpretation prevents a qualified workflow claim', () => {
  for (const mutate of [v => { delete v.report.protocol.workflowReviewRules }, v => { v.report.protocol.workflowReviewRules = { ...guidedReviewRules, firstInvestigation: 'Anything counts' } }]) { const value = fixture(); mutate(value); rebindReport(value); assert.equal(evaluate(value).anyQualifiedWin, false) }
})

test('built-in resource discovery is retained but cannot satisfy the inventory-explicit workflow', () => {
  const value = fixture(), run = value.report.runs[0], review = value.context.audit.runs[0]
  const record = JSON.parse(value.context.publicRecords[run.id]); record.actions.splice(1, 0, { type: 'mcp_tool_call', idSha256: hash('resource-list'), server: 'codex', tool: 'list_mcp_resources' })
  const bytes = JSON.stringify(record); value.context.publicRecords[run.id] = bytes; run.evidenceSha256 = review.evidenceSha256 = hash(bytes); rebindReport(value)
  assert.equal(evaluate(value).anyQualifiedWin, false)
})

test('usable retrieval claims need a supplement bound to raw and public evidence', () => {
  const value = fixture(), run = value.report.runs.find(run => run.arm === 'packet'), review = value.context.audit.runs.find(row => row.id === run.id)
  review.returnedEvidence = 'usable'
  assert.equal(evaluate(value).anyQualifiedWin, false)
  const record = JSON.parse(value.context.publicRecords[run.id]), action = record.actions[1]
  run.rawSha256 = hash('raw capture'); action.resultSha256 = hash('actual returned source')
  value.context.publicRecords[run.id] = JSON.stringify(record); run.evidenceSha256 = review.evidenceSha256 = hash(value.context.publicRecords[run.id])
  const bytes = JSON.stringify({ rawCaptureSha256: run.rawSha256, publicRecordSha256: run.evidenceSha256, actions: [{ idSha256: action.idSha256, type: 'mcp_tool_call', resultSha256: action.resultSha256, result: { content: [{ type: 'text', text: 'actual returned source' }] } }] })
  review.toolOutputsSha256 = hash(bytes); value.context.publicOutputs = { [run.id]: bytes }; rebindReport(value)
  assert.equal(evaluate(value).anyQualifiedWin, true)
  value.context.publicOutputs[run.id] += ' '
  assert.equal(evaluate(value).anyQualifiedWin, false)
})

test('native supplemental evidence hashes are checked symmetrically', () => { const value = fixture(); value.context.audit.runs[0].toolOutputsSha256 = hash('invented supplement'); assert.equal(evaluate(value).anyQualifiedWin, false) })
