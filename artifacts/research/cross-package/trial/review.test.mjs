import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { adjudicate, reviewRules } from './review.mjs'
import { decisionGate, makeSchedule } from './decision.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const encode = value => JSON.stringify(value, null, 2) + '\n'

function fixture() {
  const protocol = { phase: 'development', tasks: [{ id: 'task', category: 'impact', split: 'development', mode: 'analysis' }], arms: ['native', 'typelatch', 'competitor'], candidates: ['typelatch'], repeats: 1, decisionGate, spec: { arms: { native: { servers: {} }, typelatch: { servers: { typelatch: {} } }, competitor: { servers: { serena: {} } } } } }
  protocol.schedule = makeSchedule(protocol.tasks, protocol.arms, 1)
  protocol.prompts = protocol.arms.map(arm => ({ task: 'task', arm, prompt: 'Task prompt ' + arm, promptSha256: hash('Task prompt ' + arm) }))
  const protocolBytes = encode(protocol), records = new Map(), outputs = new Map(), reviewRows = []
  const runs = protocol.schedule.map(slot => {
    const prompt = protocol.prompts.find(p => p.arm === slot.arm), idSha256 = hash(slot.id), server = slot.arm === 'typelatch' ? 'typelatch' : 'serena'
    const run = { ...slot, status: 'completed', exitCode: 0, timedOut: false, processGroupStopped: true, providerStopped: true, correct: true, elapsedMs: 1000, providerSetupMs: 10, capture: { complete: true }, usage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 }, counts: { shellCalls: 1 }, rawSha256: hash('raw ' + slot.id), promptSha256: prompt.promptSha256 }
    const action = slot.arm === 'native' ? { idSha256, type: 'command_execution', status: 'completed' } : { idSha256, type: 'mcp_tool_call', server, tool: slot.arm === 'typelatch' ? 'workspace_context' : 'serena_repl', status: 'completed' }
    const recordBytes = encode({ run, prompt: prompt.prompt, actions: [action], grading: { passed: true } })
    run.evidenceSha256 = hash(recordBytes); records.set(run.id, recordBytes)
    const outputBytes = encode({ runId: run.id, publicRecordSha256: run.evidenceSha256, rawCaptureSha256: run.rawSha256, actions: [{ ...action, result: { text: 'recorded source' }, error: null }] })
    run.toolOutputsSha256 = hash(outputBytes); outputs.set(run.id, outputBytes)
    reviewRows.push({ id: run.id, evidenceSha256: run.evidenceSha256, toolOutputsSha256: run.toolOutputsSha256, workflow: 'pass', providerEvidence: slot.arm === 'native' ? 'not-applicable' : 'usable', basisActionIds: [idSha256], providerActionIds: slot.arm === 'native' ? [] : [idSha256], notes: 'Synthetic boundary test, not an actual semantic review.' })
    return run
  })
  const report = { protocol, protocolSha256: hash(protocolBytes), complete: true, runs, preparationAttempts: runs.map(r => ({ id: r.id, status: 'ready' })) }, reportBytes = encode(report)
  const audit = { schemaVersion: 1, reportSha256: hash(reportBytes), protocolSha256: report.protocolSha256, rules: reviewRules, reviewer: 'independent synthetic reviewer', noPrivateReasoningOrMessages: true, runs: reviewRows }
  return { reportBytes, protocolBytes, audit, records, outputs }
}

test('consistent exact records adjudicate without promoting development to an edge', () => {
  const result = adjudicate(fixture())
  assert.equal(result.decision.measurable, true)
  assert.equal(result.decision.anyQualifiedEdge, false)
})

test('changed cost or correctness cannot be blessed by an audit of a different report', () => {
  for (const mutate of [r => { r.runs[1].elapsedMs = 1 }, r => { r.runs[1].usage.inputTokens = 1; r.runs[1].usage.totalTokens = 101 }, r => { r.runs[1].correct = false }]) {
    const input = fixture(), report = JSON.parse(input.reportBytes); mutate(report)
    input.reportBytes = encode(report); input.audit.reportSha256 = hash(input.reportBytes)
    assert.throws(() => adjudicate(input), /Report\/public record disagreement/u)
  }
})

test('protocol, output and review action substitution fail closed', () => {
  const protocol = fixture(), report = JSON.parse(protocol.reportBytes); report.protocol.phase = 'confirmation'; protocol.reportBytes = encode(report); protocol.audit.reportSha256 = hash(protocol.reportBytes)
  assert.throws(() => adjudicate(protocol), /Report protocol/u)
  const output = fixture(); output.outputs.set(output.audit.runs[1].id, '{}'); assert.throws(() => adjudicate(output))
  const action = fixture(); action.audit.runs[1].providerActionIds = [hash('invented')]; assert.throws(() => adjudicate(action))
})
