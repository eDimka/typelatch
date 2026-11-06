import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decisionGate, evaluateDecision } from './paired-agent-decision.mjs'

function study() {
  const tasks = ['one', 'two', 'three'].map(id => ({ id }))
  const schedule = tasks.flatMap(task => [1, 2].flatMap(repeat => ['baseline', 'typelatch'].map(arm => ({ id: `${task.id}-${repeat}-${arm}`, task: task.id, repeat, arm }))))
  return { complete: true, protocol: { tasks, schedule, repeats: 2 }, runs: schedule.map(row => ({ ...row, status: 'completed', exitCode: 0, timedOut: false, processGroupStopped: true, capture: { complete: true }, correct: true, toolPolicyFollowed: true, elapsedMs: row.arm === 'baseline' ? 100 : 60, indexSetupMs: row.arm === 'baseline' ? 0 : 10, usage: { inputTokens: row.arm === 'baseline' ? 90 : 60, outputTokens: 10, totalTokens: row.arm === 'baseline' ? 100 : 70 } })) }
}

test('a consistent improvement passes and charges indexing time', () => {
  const result = evaluateDecision(study())
  assert.equal(result.passed, true)
  assert.equal(result.metrics.totalTokens.aggregateReductionPercent, 30)
  assert.equal(result.metrics.chargedTimeMs.aggregateReductionPercent, 30)
  assert.equal(result.metrics.chargedTimeMs.medianPairedReductionPercent, 30)
})

test('the preserved original study fails the token and time gate', () => {
  const original = JSON.parse(readFileSync(new URL('../docs/benchmarks/typelatch-use/paired-agent.json', import.meta.url)))
  const result = evaluateDecision(original)
  assert.equal(result.measurable, true)
  assert.equal(result.passed, false)
  assert(result.metrics.totalTokens.aggregateReductionPercent < -98)
  assert(result.metrics.chargedTimeMs.aggregateReductionPercent < -50)
})

test('faster agent time fails when indexing erases the saving', () => {
  const report = study()
  report.runs.filter(run => run.arm === 'typelatch').forEach(run => { run.indexSetupMs = 45 })
  assert.equal(evaluateDecision(report).passed, false)
})

test('a large outlier cannot compensate for median paired losses', () => {
  const report = study()
  report.runs.forEach(run => { run.usage = { inputTokens: run.arm === 'baseline' ? 90 : 100, outputTokens: 10, totalTokens: run.arm === 'baseline' ? 100 : 110 } })
  report.runs.find(run => run.arm === 'baseline').usage = { inputTokens: 9990, outputTokens: 10, totalTokens: 10000 }
  const result = evaluateDecision(report)
  assert(result.metrics.totalTokens.aggregateReductionPercent > 10)
  assert(result.metrics.totalTokens.medianPairedReductionPercent < 0)
  assert.equal(result.passed, false)
})

test('aggregate savings do not pass if either repeat loses', () => {
  const report = study()
  report.runs.filter(run => run.arm === 'typelatch').forEach(run => {
    const total = run.repeat === 1 ? 20 : 110
    run.usage = { inputTokens: total - 10, outputTokens: 10, totalTokens: total }
  })
  const result = evaluateDecision(report)
  assert(result.metrics.totalTokens.aggregateReductionPercent > 10)
  assert.equal(result.passed, false)
})

test('equal overall correctness cannot hide a task regression', () => {
  const report = study()
  report.runs.find(run => run.task === 'one' && run.arm === 'baseline').correct = false
  report.runs.find(run => run.task === 'two' && run.arm === 'typelatch').correct = false
  const result = evaluateDecision(report)
  assert.equal(result.correctness.baseline, result.correctness.typelatch)
  assert.equal(result.passed, false)
})

test('unknown, missing, duplicated, nonadopting or interrupted attempts cannot pass', () => {
  for (const change of [report => { report.runs[0].correct = null }, report => { report.runs[0].usage.totalTokens = null }, report => { report.runs[0].capture.complete = false }, report => { report.runs[0].timedOut = true }, report => { report.runs.pop() }, report => { report.runs[1] = report.runs[0] }, report => { report.complete = false }, report => { report.runs[0].toolPolicyFollowed = false }]) {
    const report = study(); change(report)
    const result = evaluateDecision(report)
    assert.equal(result.measurable, false)
    assert.equal(result.passed, false)
  }
})

test('a malformed task or schedule cannot omit a run from paired totals', () => {
  for (const change of [report => { report.protocol.tasks[1] = report.protocol.tasks[0] }, report => { report.protocol.schedule[1] = report.protocol.schedule[0] }]) {
    const report = study(); change(report)
    assert.equal(evaluateDecision(report).measurable, false)
  }
})

test('candidate setup failures, interrupted setup and mismatched ledger entries cannot pass', () => {
  const candidate = () => {
    const report = study()
    report.protocol.candidate = { name: 'typelatch', version: '0.4.0' }
    report.protocol.decisionGate = decisionGate
    report.preparationAttempts = report.runs.map(run => ({ id: run.id, status: 'ready' }))
    return report
  }
  assert.equal(evaluateDecision(candidate()).passed, true)
  for (const change of [report => { delete report.preparationAttempts }, report => { report.preparationAttempts[0].status = 'failed' }, report => { report.preparationAttempts[0].status = 'preparing' }, report => { report.preparationAttempts[0].id = 'other' }, report => { report.preparationAttempts.push({ id: 'extra', status: 'failed' }) }, report => { report.protocol.decisionGate = { ...decisionGate, minimumReductionPercent: 1 } }]) {
    const report = candidate(); change(report)
    const result = evaluateDecision(report)
    assert.equal(result.passed, false)
    assert.equal(result.measurable, false)
  }
})
