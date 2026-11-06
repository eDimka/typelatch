import { isDeepStrictEqual } from 'node:util'

export const controls = ['native', 'competitor']
export const arms = ['native', 'typelatch', 'competitor']
export const decisionGate = Object.freeze({
  minimumReductionPercent: 20,
  tokenMetric: 'Terminal inputTokens + outputTokens, including cached input; cached/reasoning subsets are not added twice.',
  timeMetric: 'providerSetupMs + elapsedMs; common corpus preparation, independent grading and teardown excluded and separately reported.',
  rule: 'Assess EACH preregistered candidate independently against EACH control. Both total tokens and charged time must improve by at least20% in aggregate and in the median of four task/repeat paired percentage reductions. Both repeat aggregates must improve on both metrics. Correctness must not decline overall or for any task, and each candidate must solve each task at least once. Every capture, grade and requested native validation observation must complete; no replacements or candidate pooling. A qualified win additionally requires all four candidate runs correct.',
  nativeValidation: 'Observe a failing supplied native check followed by a later supplied check, whose last returned result passes. Multiple checks in one command count; shell exit is aggregate, not an individual check exit. This observable gate does not prove the timing of every shell-embedded source write.',
  adoption: 'Tool use is optional. Zero Typelatch calls remains an observed condition; it is not a failed tool policy and is never removed.',
  scope: 'Two public real maintenance tasks and two repeats per arm. This is a bounded decision, not general superiority or a statistical confidence interval.',
})

export function makeSchedule(taskIds, candidates = ['typelatch']) {
  if (taskIds.length !== 2 || new Set(taskIds).size !== 2) throw new Error('Exactly two distinct tasks are required')
  if (!isDeepStrictEqual(candidates, ['typelatch']) && !isDeepStrictEqual(candidates, ['typelatch', 'packet'])) throw new Error('Freeze either Typelatch alone or Typelatch plus the packet candidate')
  const orders = candidates.length === 2
    ? [['native', 'typelatch', 'competitor', 'packet'], ['typelatch', 'native', 'packet', 'competitor'], ['competitor', 'packet', 'native', 'typelatch'], ['packet', 'competitor', 'typelatch', 'native']]
    : [['native', 'typelatch', 'competitor'], ['typelatch', 'competitor', 'native'], ['native', 'competitor', 'typelatch'], ['competitor', 'typelatch', 'native']]
  const blocks = [
    { task: taskIds[0], repeat: 1 },
    { task: taskIds[1], repeat: 1 },
    { task: taskIds[1], repeat: 2 },
    { task: taskIds[0], repeat: 2 },
  ]
  return blocks.flatMap((block, index) => orders[index].map(arm => ({ id: `${block.task}-r${block.repeat}-${arm}`, task: block.task, repeat: block.repeat, arm })))
}

const sum = rows => rows.reduce((a, b) => a + b, 0)
const reduction = (control, candidate) => 100 * (control - candidate) / control
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const median = values => { const sorted = values.toSorted((a, b) => a - b); return (sorted[1] + sorted[2]) / 2 }

export function evaluateDecision(report) {
  const reasons = [], runs = report.runs ?? [], protocol = report.protocol ?? {}, tasks = protocol.tasks ?? []
  const taskIds = tasks.map(task => task.id)
  const candidates = protocol.candidates ?? ['typelatch']
  let schedule = []
  try { schedule = makeSchedule(taskIds, candidates) } catch { reasons.push('The design requires exactly two distinct tasks and a fixed candidate set.') }
  if (!isDeepStrictEqual(protocol.decisionGate, decisionGate) || protocol.repeats !== 2 || !isDeepStrictEqual(protocol.schedule, schedule)) reasons.push('Protocol does not match the frozen gate and counterbalanced schedule.')
  const runCount = 2 * 2 * (2 + candidates.length)
  if (report.complete !== true || runs.length !== runCount || schedule.length !== runCount || new Set(runs.map(run => run.id)).size !== runCount) reasons.push('The fixed session study is incomplete.')
  for (const [index, run] of runs.entries()) {
    const expected = schedule[index]
    if (!expected || ['id', 'task', 'repeat', 'arm'].some(key => run[key] !== expected[key])) reasons.push(`Run does not match the schedule: ${run.id}`)
    if (run.status !== 'completed' || run.exitCode !== 0 || run.timedOut !== false || run.processGroupStopped !== true || run.providerStopped !== true || run.capture?.complete !== true || typeof run.correct !== 'boolean') reasons.push(`Incomplete capture, cleanup or grade: ${run.id}`)
    if (run.nativeValidation?.failingThenLaterCheckObserved !== true || run.nativeValidation?.checks?.at(-1)?.passed !== true) reasons.push(`Requested native validation was not observed: ${run.id}`)
    const usage = run.usage
    if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || usage.totalTokens !== usage.inputTokens + usage.outputTokens || !finite(run.elapsedMs) || !finite(run.providerSetupMs)) reasons.push(`Missing or invalid token/time measurement: ${run.id}`)
  }
  const attempts = report.preparationAttempts
  if (!Array.isArray(attempts) || attempts.length !== runs.length || attempts.some((attempt, index) => attempt.status !== 'ready' || attempt.id !== runs[index]?.id)) reasons.push('Preparation failed, was interrupted, or lacks its retained run.')
  if (reasons.length) return { anyCandidatePassed: false, measurable: false, gate: decisionGate, reasons: [...new Set(reasons)], candidateDecisions: null }
  const candidateDecisions = {}
  for (const candidate of candidates) {
    const candidateReasons = [], comparisons = {}
    for (const control of ['native', 'competitor']) {
      const pairs = tasks.flatMap(task => [1, 2].map(repeat => ({ task: task.id, repeat, control: runs.find(run => run.task === task.id && run.repeat === repeat && run.arm === control), candidate: runs.find(run => run.task === task.id && run.repeat === repeat && run.arm === candidate) })))
      const metrics = {}
      for (const [name, read] of Object.entries({ totalTokens: run => run.usage.totalTokens, chargedTimeMs: run => run.elapsedMs + run.providerSetupMs })) {
        const values = pairs.map(pair => ({ task: pair.task, repeat: pair.repeat, control: read(pair.control), candidate: read(pair.candidate) }))
        if (values.some(pair => pair.control <= 0)) return { anyCandidatePassed: false, measurable: false, gate: decisionGate, reasons: [`Zero control denominator for ${control}/${name}`], candidateDecisions: null }
        const controlTotal = sum(values.map(pair => pair.control)), candidateTotal = sum(values.map(pair => pair.candidate))
        const aggregateReductionPercent = reduction(controlTotal, candidateTotal)
        const medianPairedReductionPercent = median(values.map(pair => reduction(pair.control, pair.candidate)))
        const repeats = [1, 2].map(repeat => { const selected = values.filter(pair => pair.repeat === repeat), a = sum(selected.map(pair => pair.control)), b = sum(selected.map(pair => pair.candidate)); return { repeat, control: a, candidate: b, reductionPercent: reduction(a, b) } })
        metrics[name] = { control: controlTotal, candidate: candidateTotal, aggregateReductionPercent, medianPairedReductionPercent, repeats, pairs: values.map(pair => ({ ...pair, reductionPercent: reduction(pair.control, pair.candidate) })) }
        if (aggregateReductionPercent < 20 || medianPairedReductionPercent < 20) candidateReasons.push(`${control}/${name}: aggregate or median reduction is below20%.`)
        if (repeats.some(row => row.reductionPercent <= 0)) candidateReasons.push(`${control}/${name}: a repeat fails to improve.`)
      }
      const correctness = { control: pairs.filter(pair => pair.control.correct).length, candidate: pairs.filter(pair => pair.candidate.correct).length, tasks: tasks.map(task => ({ task: task.id, control: pairs.filter(pair => pair.task === task.id && pair.control.correct).length, candidate: pairs.filter(pair => pair.task === task.id && pair.candidate.correct).length })) }
      if (correctness.candidate < correctness.control || correctness.tasks.some(row => row.candidate < row.control)) candidateReasons.push(`${control}: correctness declined overall or for a task.`)
      comparisons[control] = { metrics, correctness }
    }
    const candidateRuns = runs.filter(run => run.arm === candidate)
    if (tasks.some(task => !candidateRuns.some(run => run.task === task.id && run.correct))) candidateReasons.push('Candidate must solve each task at least once; two wrong arms cannot establish a useful win.')
    const allCorrect = candidateRuns.every(run => run.correct)
    candidateDecisions[candidate] = { passed: candidateReasons.length === 0, allCorrect, qualifiedWin: candidateReasons.length === 0 && allCorrect, reasons: candidateReasons, comparisons, adoption: candidateRuns.map(run => ({ id: run.id, mcpCalls: run.counts?.mcpCalls ?? null, mcpSucceeded: run.counts?.mcpSucceeded ?? null })) }
  }
  return { anyCandidatePassed: Object.values(candidateDecisions).some(result => result.passed), anyQualifiedWin: Object.values(candidateDecisions).some(result => result.qualifiedWin), measurable: true, gate: decisionGate, reasons, candidateDecisions }
}
