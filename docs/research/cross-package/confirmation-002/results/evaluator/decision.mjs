import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'

export const decisionGate = Object.freeze({
  minimumReductionPercent: 20,
  controls: ['native', 'competitor'],
  categories: ['maintenance', 'migration', 'impact'],
  minimumHeldoutTasksPerClaimedCategory: 2,
  minimumRepeats: 2,
  rule: 'Compare each frozen candidate with both native tools and Serena. Require at least 20% aggregate and median paired reduction in total tokens and provider setup plus agent time, improvement in both repeat aggregates, all candidate answers correct, complete captures and cleanup, relevant usable candidate evidence and independent workflow review. A category edge requires two distinct held-out tasks and two repetitions. Development measurements and a single held-out task can only justify replication. Keep all categories, failures and costs visible; do not pool old studies or replace attempts.',
  scope: 'Prespecified category comparisons are exploratory multiple hypotheses, not statistical confidence bounds or universal superiority. A narrow claim names its exact held-out tasks, repository snapshots, model and treatment.',
})

export function makeSchedule(tasks, arms, repeats) {
  assert(tasks.length && new Set(tasks.map(t => t.id)).size === tasks.length, 'Distinct tasks required')
  assert(arms.length >= 3 && new Set(arms).size === arms.length && arms.includes('native') && arms.includes('competitor'), 'Both controls and a candidate required')
  assert([1, 2].includes(repeats), 'One exploratory or two confirming repetitions required')
  return Array.from({ length: repeats }, (_, i) => i + 1).flatMap(repeat => (repeat === 1 ? tasks : tasks.toReversed()).flatMap(task => {
    const offset = tasks.findIndex(t => t.id === task.id) % arms.length
    const first = [...arms.slice(offset), ...arms.slice(0, offset)]
    return (repeat === 1 ? first : first.toReversed()).map(arm => ({ id: `${task.id}-r${repeat}-${arm}`, task: task.id, repeat, arm }))
  }))
}

const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const sum = rows => rows.reduce((a, b) => a + b, 0)
const median = values => { const sorted = values.toSorted((a, b) => a - b), middle = sorted.length >> 1; return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 }
const reduction = (control, candidate) => 100 * (control - candidate) / control

function evaluateSubset(report, candidate, tasks) {
  const reasons = [], comparisons = {}, protocol = report.protocol
  const taskIds = new Set(tasks.map(t => t.id)), selected = report.runs.filter(r => taskIds.has(r.task))
  for (const control of decisionGate.controls) {
    const metrics = {}
    for (const [metric, read] of Object.entries({ totalTokens: r => r.usage.totalTokens, chargedTimeMs: r => r.providerSetupMs + r.elapsedMs })) {
      const pairs = tasks.flatMap(task => Array.from({ length: protocol.repeats }, (_, n) => {
        const repeat = n + 1, native = selected.find(r => r.task === task.id && r.repeat === repeat && r.arm === control), treatment = selected.find(r => r.task === task.id && r.repeat === repeat && r.arm === candidate)
        return { task: task.id, repeat, control: read(native), candidate: read(treatment), reductionPercent: read(native) > 0 ? reduction(read(native), read(treatment)) : null }
      }))
      const controlTotal = sum(pairs.map(p => p.control)), candidateTotal = sum(pairs.map(p => p.candidate))
      const aggregateReductionPercent = controlTotal > 0 ? reduction(controlTotal, candidateTotal) : null
      const medianPairedReductionPercent = pairs.every(p => p.reductionPercent !== null) ? median(pairs.map(p => p.reductionPercent)) : null
      const repeats = Array.from({ length: protocol.repeats }, (_, n) => {
        const subset = pairs.filter(p => p.repeat === n + 1), a = sum(subset.map(p => p.control)), b = sum(subset.map(p => p.candidate))
        return { repeat: n + 1, control: a, candidate: b, reductionPercent: a > 0 ? reduction(a, b) : null }
      })
      metrics[metric] = { control: controlTotal, candidate: candidateTotal, aggregateReductionPercent, medianPairedReductionPercent, repeats, pairs }
      if (aggregateReductionPercent === null || medianPairedReductionPercent === null || aggregateReductionPercent < 20 || medianPairedReductionPercent < 20) reasons.push(`${control}/${metric}: aggregate or median savings below 20%.`)
      if (repeats.some(r => r.reductionPercent === null || r.reductionPercent <= 0)) reasons.push(`${control}/${metric}: a repetition did not improve.`)
    }
    comparisons[control] = { metrics, correctness: { control: selected.filter(r => r.arm === control && r.correct).length, candidate: selected.filter(r => r.arm === candidate && r.correct).length, perTask: tasks.map(t => ({ task: t.id, control: selected.filter(r => r.task === t.id && r.arm === control && r.correct).length, candidate: selected.filter(r => r.task === t.id && r.arm === candidate && r.correct).length })) } }
  }
  const candidateRuns = selected.filter(r => r.arm === candidate)
  if (candidateRuns.some(r => !r.correct)) reasons.push('Every candidate result must pass the independent grader.')
  const savingsObserved = reasons.length === 0
  if (selected.some(r => r.workflowReviewed !== true)) reasons.push('Independent workflow review is pending or failed.')
  if (candidateRuns.some(r => r.providerUsed !== true)) reasons.push('A candidate session did not use its task relevant provider.')
  if (candidateRuns.some(r => r.providerEvidenceUsable !== true)) reasons.push('Candidate evidence was not independently judged usable in every session.')
  if (selected.some(r => r.arm === 'competitor' && r.providerUsed !== true)) reasons.push('A Serena session did not use its task relevant provider.')
  const categories = [...new Set(tasks.map(t => t.category))]
  const enoughTasks = categories.every(category => tasks.filter(t => t.category === category && t.split === 'heldout').length >= decisionGate.minimumHeldoutTasksPerClaimedCategory)
  const needsIndependentTaskReplication = protocol.phase === 'confirmation' && !enoughTasks
  if (protocol.phase !== 'confirmation' || tasks.some(t => t.split !== 'heldout')) reasons.push('Development outcomes cannot establish a held-out edge.')
  if (!enoughTasks) reasons.push('Each claimed category needs two distinct held-out tasks.')
  if (protocol.repeats < 2) reasons.push('Two repetitions are required.')
  return { qualifiedEdge: reasons.length === 0, savingsObserved, needsIndependentTaskReplication, reasons, comparisons }
}

export function evaluateDecision(report) {
  const reasons = [], protocol = report.protocol ?? {}, tasks = protocol.tasks ?? [], runs = report.runs ?? []
  let schedule = []
  try { schedule = makeSchedule(tasks, protocol.arms, protocol.repeats) } catch (error) { reasons.push(error.message) }
  if (!isDeepStrictEqual(protocol.decisionGate, decisionGate) || !isDeepStrictEqual(protocol.schedule, schedule)) reasons.push('Protocol does not match the frozen gate and schedule.')
  if (!['development', 'confirmation'].includes(protocol.phase) || !Array.isArray(protocol.candidates) || !protocol.candidates.length || protocol.candidates.some(c => decisionGate.controls.includes(c)) || !isDeepStrictEqual([...decisionGate.controls, ...protocol.candidates].toSorted(), [...(protocol.arms ?? [])].toSorted())) reasons.push('Unknown phase or candidate set.')
  if (tasks.some(t => !decisionGate.categories.includes(t.category) || !['edit', 'analysis'].includes(t.mode) || t.split !== (protocol.phase === 'development' ? 'development' : 'heldout'))) reasons.push('Task category, mode or split is inconsistent.')
  if (report.complete !== true || runs.length !== schedule.length || !runs.length || new Set(runs.map(r => r.id)).size !== runs.length) reasons.push('The scheduled study is incomplete.')
  for (const [i, run] of runs.entries()) {
    if (!schedule[i] || ['id', 'task', 'repeat', 'arm'].some(key => run[key] !== schedule[i][key])) reasons.push(`Unexpected run ${run.id}.`)
    if (run.status !== 'completed' || run.exitCode !== 0 || run.timedOut !== false || run.processGroupStopped !== true || run.providerStopped !== true || run.capture?.complete !== true || typeof run.correct !== 'boolean') reasons.push(`Incomplete capture, cleanup or grading: ${run.id}.`)
    if (tasks.find(t => t.id === run.task)?.mode === 'edit' && (run.nativeValidation?.failingThenLaterCheckObserved !== true || run.nativeValidation.checks?.at(-1)?.completePassingCheck !== true)) reasons.push(`Required native validation is incomplete: ${run.id}.`)
    const usage = run.usage
    if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || usage.totalTokens !== usage.inputTokens + usage.outputTokens || !finite(run.elapsedMs) || !finite(run.providerSetupMs)) reasons.push(`Unknown or invalid cost: ${run.id}.`)
  }
  if (!Array.isArray(report.preparationAttempts) || report.preparationAttempts.length !== runs.length || report.preparationAttempts.some((a, i) => a.id !== runs[i]?.id || a.status !== 'ready')) reasons.push('Preparation failed or lacks its retained run.')
  if (reasons.length) return { measurable: false, anyQualifiedEdge: false, reasons: [...new Set(reasons)] }
  const candidates = Object.fromEntries(protocol.candidates.map(candidate => [candidate, { overall: evaluateSubset(report, candidate, tasks), categories: Object.fromEntries([...new Set(tasks.map(t => t.category))].map(category => [category, evaluateSubset(report, candidate, tasks.filter(t => t.category === category))])) }]))
  return { measurable: true, anyQualifiedEdge: Object.values(candidates).some(c => Object.values(c.categories).some(v => v.qualifiedEdge)), candidates, reasons: [] }
}
