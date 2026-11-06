import { isDeepStrictEqual } from 'node:util'

export const decisionGate = {
  minimumReductionPercent: 10,
  tokenMetric: 'inputTokens + outputTokens, including cached input',
  timeMetric: 'elapsedMs + indexSetupMs; common fixture preparation and independent grading excluded',
  rule: 'Both metrics must improve by at least 10% in aggregate and in the median of six paired percentage reductions. Both repeat aggregates must improve on both metrics. Correctness must not decline overall or for any task. All twelve scheduled captures and grades must complete. No replacement runs.',
  scope: 'A decision on these three known tasks with two repeats, not a general performance claim or a statistical confidence interval.',
}

const sum = values => values.reduce((total, value) => total + value, 0)
const reduction = (baseline, typelatch) => 100 * (baseline - typelatch) / baseline
const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function evaluateDecision(report) {
  const reasons = []
  const runs = report.runs ?? []
  const schedule = report.protocol?.schedule ?? []
  const tasks = report.protocol?.tasks ?? []
  const ids = new Set(runs.map(run => run.id))
  const pairs = []
  const taskIds = new Set(tasks.map(task => task.id))
  const scheduleIds = new Set(schedule.map(run => run.id))
  const pairKey = run => JSON.stringify([run.task, run.repeat, run.arm])
  const expectedSlots = new Set(tasks.flatMap(task => [1, 2].flatMap(repeat => ['baseline', 'typelatch'].map(arm => pairKey({ task: task.id, repeat, arm })))))
  const actualSlots = new Set(schedule.map(pairKey))
  if (taskIds.size !== 3 || tasks.some(task => typeof task.id !== 'string' || !task.id) || scheduleIds.size !== 12 || actualSlots.size !== 12 || [...actualSlots].some(slot => !expectedSlots.has(slot))) reasons.push('Tasks and schedule must form the exact three by two by two design.')
  if (runs.some((run, index) => run.id !== schedule[index]?.id)) reasons.push('Recorded runs do not follow the frozen schedule.')
  if (report.protocol?.decisionGate !== undefined && !isDeepStrictEqual(report.protocol.decisionGate, decisionGate)) reasons.push('The report declares a different decision gate.')
  if (report.protocol?.candidate) {
    const attempts = report.preparationAttempts
    if (!isDeepStrictEqual(report.protocol.decisionGate, decisionGate) || !Array.isArray(attempts) || attempts.length !== runs.length || attempts.some((attempt, index) => attempt.status !== 'ready' || attempt.id !== runs[index]?.id)) reasons.push('Candidate preparation is missing, failed, interrupted or unmatched.')
  }
  if (!report.complete || schedule.length !== 12 || runs.length !== 12 || ids.size !== 12 || tasks.length !== 3 || report.protocol?.repeats !== 2) reasons.push('The fixed twelve run study is incomplete.')
  for (const expected of schedule) {
    const run = runs.find(run => run.id === expected.id)
    if (!run || ['task', 'repeat', 'arm'].some(key => run[key] !== expected[key])) reasons.push(`Missing or mismatched scheduled run: ${expected.id}`)
  }
  for (const run of runs) {
    if (run.status !== 'completed' || run.exitCode !== 0 || run.timedOut !== false || run.processGroupStopped !== true || run.capture?.complete !== true || typeof run.correct !== 'boolean' || run.toolPolicyFollowed !== true) reasons.push(`Incomplete capture, grade or tool policy: ${run.id}`)
    const usage = run.usage
    if (!usage || !Number.isSafeInteger(usage.inputTokens) || !Number.isSafeInteger(usage.outputTokens) || !finite(usage.inputTokens) || !finite(usage.outputTokens) || usage.totalTokens !== usage.inputTokens + usage.outputTokens || !finite(run.elapsedMs) || !finite(run.indexSetupMs)) reasons.push(`Invalid token or time measurement: ${run.id}`)
  }
  for (const task of tasks) {
    for (const repeat of [1, 2]) {
      const matching = runs.filter(run => run.task === task.id && run.repeat === repeat)
      const baseline = matching.find(run => run.arm === 'baseline')
      const typelatch = matching.find(run => run.arm === 'typelatch')
      if (matching.length !== 2 || !baseline || !typelatch) reasons.push(`Incomplete pair: ${task.id}-${repeat}`)
      else pairs.push({ task: task.id, repeat, baseline, typelatch })
    }
  }
  if (reasons.length) return { passed: false, measurable: false, gate: decisionGate, reasons: [...new Set(reasons)], metrics: null, correctness: null }
  const metrics = {}
  for (const [name, value] of Object.entries({ totalTokens: run => run.usage.totalTokens, chargedTimeMs: run => run.elapsedMs + run.indexSetupMs })) {
    const measuredPairs = pairs.map(pair => ({ task: pair.task, repeat: pair.repeat, baseline: value(pair.baseline), typelatch: value(pair.typelatch) }))
    if (measuredPairs.some(pair => pair.baseline <= 0)) return { passed: false, measurable: false, gate: decisionGate, reasons: [`Zero baseline for ${name}`], metrics: null, correctness: null }
    const baseline = sum(measuredPairs.map(pair => pair.baseline))
    const typelatch = sum(measuredPairs.map(pair => pair.typelatch))
    const aggregateReductionPercent = reduction(baseline, typelatch)
    const medianPairedReductionPercent = median(measuredPairs.map(pair => reduction(pair.baseline, pair.typelatch)))
    const repeats = [1, 2].map(repeat => {
      const selected = measuredPairs.filter(pair => pair.repeat === repeat)
      const baseline = sum(selected.map(pair => pair.baseline)), typelatch = sum(selected.map(pair => pair.typelatch))
      return { repeat, baseline, typelatch, reductionPercent: reduction(baseline, typelatch) }
    })
    metrics[name] = { baseline, typelatch, aggregateReductionPercent, medianPairedReductionPercent, repeats, pairs: measuredPairs.map(pair => ({ ...pair, reductionPercent: reduction(pair.baseline, pair.typelatch) })) }
    if (aggregateReductionPercent < decisionGate.minimumReductionPercent) reasons.push(`${name}: aggregate reduction is below 10%.`)
    if (medianPairedReductionPercent < decisionGate.minimumReductionPercent) reasons.push(`${name}: median paired reduction is below 10%.`)
    if (repeats.some(repeat => repeat.reductionPercent <= 0)) reasons.push(`${name}: at least one repeat does not improve.`)
  }
  const correctness = { baseline: runs.filter(run => run.arm === 'baseline' && run.correct).length, typelatch: runs.filter(run => run.arm === 'typelatch' && run.correct).length, tasks: tasks.map(task => ({ task: task.id, baseline: runs.filter(run => run.task === task.id && run.arm === 'baseline' && run.correct).length, typelatch: runs.filter(run => run.task === task.id && run.arm === 'typelatch' && run.correct).length })) }
  if (correctness.typelatch < correctness.baseline || correctness.tasks.some(task => task.typelatch < task.baseline)) reasons.push('Correctness declined overall or for a task.')
  return { passed: reasons.length === 0, measurable: true, gate: decisionGate, reasons, metrics, correctness }
}
