import assert from 'node:assert/strict'
import test from 'node:test'
import { makeSchedule, evaluateDecision, decisionGate } from './decision.mjs'

function sample({ phase = 'confirmation', categories = ['impact', 'impact'], repeats = 2 } = {}) {
  const tasks = categories.map((category, i) => ({ id: `task${i}`, category, mode: 'analysis', split: phase === 'confirmation' ? 'heldout' : 'development' }))
  const protocol = { phase, tasks, repeats, arms: ['native', 'typelatch', 'competitor'], candidates: ['typelatch'], decisionGate }
  protocol.schedule = makeSchedule(tasks, protocol.arms, repeats)
  const runs = protocol.schedule.map(slot => ({ ...slot, status: 'completed', exitCode: 0, timedOut: false, processGroupStopped: true, providerStopped: true, capture: { complete: true }, correct: true, usage: { inputTokens: slot.arm === 'typelatch' ? 600 : 900, outputTokens: 100, totalTokens: slot.arm === 'typelatch' ? 700 : 1000 }, elapsedMs: slot.arm === 'typelatch' ? 650 : 1000, providerSetupMs: slot.arm === 'typelatch' ? 50 : 0, providerUsed: slot.arm !== 'native', providerEvidenceUsable: slot.arm !== 'native', workflowReviewed: true }))
  return { complete: true, protocol, runs, preparationAttempts: runs.map(run => ({ id: run.id, status: 'ready' })) }
}

test('each second repetition reverses the first arm order for that task', () => {
  const report = sample({ categories: ['maintenance', 'migration', 'impact'] })
  for (const task of report.protocol.tasks) assert.deepEqual(report.protocol.schedule.filter(s => s.task === task.id && s.repeat === 2).map(s => s.arm), report.protocol.schedule.filter(s => s.task === task.id && s.repeat === 1).map(s => s.arm).toReversed())
})

test('replicated held-out category wins require both controls and setup-inclusive cost', () => {
  const report = sample()
  assert.equal(evaluateDecision(report).candidates.typelatch.categories.impact.qualifiedEdge, true)
  report.runs.find(r => r.arm === 'typelatch').providerSetupMs = 2000
  assert.equal(evaluateDecision(report).candidates.typelatch.categories.impact.qualifiedEdge, false)
})

test('development results and one held-out task cannot establish an edge', () => {
  assert.equal(evaluateDecision(sample({ phase: 'development' })).candidates.typelatch.categories.impact.qualifiedEdge, false)
  const result = evaluateDecision(sample({ categories: ['impact'] })).candidates.typelatch.categories.impact
  assert.equal(result.savingsObserved, true)
  assert.equal(result.qualifiedEdge, false)
  assert.equal(result.needsIndependentTaskReplication, true)
})

test('partial correctness, unreviewed use and unused providers cannot qualify', () => {
  for (const field of ['correct', 'workflowReviewed', 'providerUsed', 'providerEvidenceUsable']) {
    const report = sample(); report.runs.find(r => r.arm === 'typelatch')[field] = false
    assert.equal(evaluateDecision(report).candidates.typelatch.categories.impact.qualifiedEdge, false)
  }
})

test('unknown usage, changed threshold, interrupted setup and duplicate runs are ineligible', () => {
  for (const mutate of [r => { r.runs[0].usage.totalTokens = null }, r => { r.protocol.decisionGate = { ...decisionGate, minimumReductionPercent: 0 } }, r => { r.preparationAttempts[0].status = 'failed' }, r => { r.runs[1] = r.runs[0] }, r => { r.runs[0].timedOut = true }]) {
    const report = sample(); mutate(report); assert.equal(evaluateDecision(report).measurable, false)
  }
})

test('a losing repeat and one bad control comparison remain disqualifying', () => {
  const report = sample()
  for (const run of report.runs.filter(r => r.repeat === 2 && r.arm === 'typelatch')) { run.usage.inputTokens = 1000; run.usage.totalTokens = 1100 }
  assert.equal(evaluateDecision(report).candidates.typelatch.categories.impact.qualifiedEdge, false)
  const fasterCompetitor = sample()
  for (const run of fasterCompetitor.runs.filter(r => r.arm === 'competitor')) run.elapsedMs = 300
  assert.equal(evaluateDecision(fasterCompetitor).candidates.typelatch.categories.impact.qualifiedEdge, false)
})

test('success in a category cannot erase failures in another category', () => {
  const report = sample({ categories: ['impact', 'impact', 'migration', 'migration'] })
  for (const run of report.runs.filter(r => r.task.startsWith('task') && ['task2', 'task3'].includes(r.task) && r.arm === 'typelatch')) { run.correct = false; run.elapsedMs = 2000 }
  const result = evaluateDecision(report).candidates.typelatch
  assert.equal(result.categories.impact.qualifiedEdge, true)
  assert.equal(result.categories.migration.qualifiedEdge, false)
  assert.equal(result.overall.qualifiedEdge, false)
})
