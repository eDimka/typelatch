import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionGate, evaluateDecision, makeSchedule } from './decision.mjs'

function report(candidates = ['typelatch']) {
  const tasks = [{ id: 'pnpm' }, { id: 'datefns' }], schedule = makeSchedule(tasks.map(task => task.id), candidates)
  const runs = schedule.map(slot => ({ ...slot, status: 'completed', exitCode: 0, timedOut: false, processGroupStopped: true, providerStopped: true, capture: { complete: true }, nativeValidation: { failingThenLaterCheckObserved: true, checks: [{ passed: false }, { passed: true }] }, correct: true, elapsedMs: candidates.includes(slot.arm) ? 60 : 100, providerSetupMs: candidates.includes(slot.arm) ? 10 : 0, usage: { inputTokens: candidates.includes(slot.arm) ? 60 : 90, outputTokens: 10, totalTokens: candidates.includes(slot.arm) ? 70 : 100 }, counts: { mcpCalls: 0, mcpSucceeded: 0 } }))
  return { complete: true, protocol: { repeats: 2, tasks, schedule, candidates, decisionGate }, runs, preparationAttempts: runs.map(run => ({ id: run.id, status: 'ready' })) }
}

test('20percent gate checks both independent controls and retains zero tool adoption', () => {
  const result = evaluateDecision(report())
  assert.equal(result.anyCandidatePassed, true)
  assert.equal(result.candidateDecisions.typelatch.comparisons.native.metrics.totalTokens.aggregateReductionPercent, 30)
  assert.equal(result.candidateDecisions.typelatch.comparisons.competitor.metrics.chargedTimeMs.aggregateReductionPercent, 30)
  assert(result.candidateDecisions.typelatch.adoption.every(run => run.mcpCalls === 0))
})
test('a stronger competitor defeats the gate even when native comparison wins', () => {
  const value = report()
  for (const run of value.runs.filter(run => run.arm === 'competitor')) Object.assign(run.usage, { inputTokens: 40, totalTokens: 50 })
  assert.equal(evaluateDecision(value).anyCandidatePassed, false)
})
test('provider setup is charged and can erase apparent agent speedup', () => {
  const value = report()
  for (const run of value.runs.filter(run => run.arm === 'typelatch')) run.providerSetupMs = 80
  assert.equal(evaluateDecision(value).anyCandidatePassed, false)
})
test('one worse repeat fails even when aggregate and median would improve', () => {
  const value = report()
  for (const run of value.runs.filter(run => run.repeat === 1 && run.arm !== 'typelatch')) run.elapsedMs = 1000
  for (const run of value.runs.filter(run => run.repeat === 2 && run.arm === 'typelatch')) run.elapsedMs = 100
  assert.equal(evaluateDecision(value).anyCandidatePassed, false)
})
test('task-level correctness loss cannot hide behind another task', () => {
  const value = report()
  for (const run of value.runs) if ((run.arm === 'typelatch' && run.task === 'pnpm') || (run.arm !== 'typelatch' && run.task === 'datefns')) run.correct = false
  assert.equal(evaluateDecision(value).anyCandidatePassed, false)
})
test('four-arm schedule reverses each task and balances every ordinal position', () => {
  const value = report(['typelatch', 'packet'])
  assert.equal(value.runs.length, 16)
  for (const arm of ['native', 'typelatch', 'competitor', 'packet']) assert.deepEqual(value.runs.flatMap((run, index) => run.arm === arm ? [index % 4] : []).toSorted(), [0, 1, 2, 3])
  for (const task of ['pnpm', 'datefns']) assert.deepEqual(value.runs.filter(run => run.task === task && run.repeat === 1).map(run => run.arm).reverse(), value.runs.filter(run => run.task === task && run.repeat === 2).map(run => run.arm))
  assert.equal(evaluateDecision(value).anyCandidatePassed, true)
})
test('packet win remains separate from a standard Typelatch loss', () => {
  const value = report(['typelatch', 'packet'])
  for (const run of value.runs.filter(run => run.arm === 'typelatch')) { run.usage.inputTokens = 190; run.usage.totalTokens = 200; run.elapsedMs = 200 }
  const result = evaluateDecision(value)
  assert.equal(result.candidateDecisions.typelatch.passed, false)
  assert.equal(result.candidateDecisions.packet.passed, true)
  assert.equal(result.candidateDecisions.packet.comparisons.native.metrics.totalTokens.candidate, 280)
  value.runs.pop()
  assert.equal(evaluateDecision(value).measurable, false)
})
test('two wrong arms cannot create a useful win and partial success is not qualified', () => {
  const value = report()
  for (const run of value.runs) run.correct = false
  assert.equal(evaluateDecision(value).anyCandidatePassed, false)
  for (const run of value.runs) run.correct = run.repeat === 1
  const result = evaluateDecision(value)
  assert.equal(result.anyCandidatePassed, true)
  assert.equal(result.anyQualifiedWin, false)
})
test('omitted native checks or a final failing check block a qualified win', () => {
  for (const mutate of [run => delete run.nativeValidation, run => run.nativeValidation.failingThenLaterCheckObserved = false, run => run.nativeValidation.checks.at(-1).passed = false]) {
    const value = report(); mutate(value.runs[0]); assert.equal(evaluateDecision(value).anyCandidatePassed, false)
  }
})
test('missing, reordered, duplicate, malformed and interrupted records cannot pass', () => {
  for (const mutate of [value => value.runs.pop(), value => value.runs.reverse(), value => value.runs[1].id = value.runs[0].id, value => value.runs[0].usage.totalTokens = 0, value => value.runs[0].providerStopped = false, value => value.preparationAttempts[0].status = 'preparing', value => value.complete = false, value => value.protocol.decisionGate = { ...decisionGate, minimumReductionPercent: 10 }]) {
    const value = report(); mutate(value); assert.equal(evaluateDecision(value).measurable, false)
  }
})
