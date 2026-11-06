import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { classifySearchCommand } from './paired-agent-evidence.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = value => Number.isSafeInteger(value) && value >= 0
const nullable = (value, check) => value === null || check(value)
const bool = value => typeof value === 'boolean'
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/u.test(value)
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, message)
const countNames = ['shellCalls', 'mcpCalls', 'mcpSucceeded', 'mcpFailed', 'fileEdits', 'grepShellCalls', 'contentSearchShellCalls', 'fileListingShellCalls', 'ambiguousSearchShellCalls']
const tokenNames = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'uncachedInputTokens']
export const monorepoArmOrder = ['native', 'competitor', 'typelatch', 'packet']
export const frozenMonorepoDecisionSha256 = '86f57a7fddd8dd1d636b1f6ff1ecc86ca8ea0aeb46cfab21db89edea7517a35c'

function verifyRun(run, task) {
  assert(safeId(run.id), 'Public run identity is a safe file name')
  assert(['completed', 'failed'].includes(run.status), 'Every scheduled session has a terminal state')
  assert(nullable(run.correct, bool), 'Correctness is boolean or explicitly unknown')
  assert(nullable(run.exitCode, Number.isInteger), 'Exit code is explicit or unknown')
  for (const name of ['timedOut', 'processGroupStopped', 'providerStopped']) assert(nullable(run[name], bool), `${name} is explicit or unknown`)
  for (const name of ['fixtureSetupMs', 'providerSetupMs', 'elapsedMs', 'teardownMs', 'gradingMs']) assert(nullable(run[name], finite), `${name} is finite or explicitly unknown`)
  for (const name of tokenNames) assert(nullable(run.usage?.[name], integer), `Token component is recorded or explicitly unknown: ${name}`)
  for (const name of countNames) assert(integer(run.counts?.[name]), `Observed action count is a nonnegative integer: ${name}`)
  const usage = run.usage
  if (integer(usage.inputTokens) && integer(usage.outputTokens)) equal(usage.totalTokens, usage.inputTokens + usage.outputTokens, 'Token total includes input and output exactly once')
  else assert.equal(usage.totalTokens, null, 'Missing input or output cannot produce a known total')
  if (integer(usage.cachedInputTokens) && integer(usage.inputTokens)) assert(usage.cachedInputTokens <= usage.inputTokens, 'Cached input is an included subset')
  if (integer(usage.uncachedInputTokens) && integer(usage.cachedInputTokens)) equal(usage.uncachedInputTokens + usage.cachedInputTokens, usage.inputTokens, 'Cached and uncached input reconcile')
  if (integer(usage.reasoningOutputTokens) && integer(usage.outputTokens)) assert(usage.reasoningOutputTokens <= usage.outputTokens, 'Reasoning is an included output subset')
  assert(bool(run.capture?.complete) && Array.isArray(run.capture.issues), 'Capture completeness and issues remain explicit')
  if (run.capture.complete) {
    assert.equal(run.capture.failedTurn, false, 'A failed turn is not a complete capture')
    assert.equal(run.capture.issues.length, 0, 'Complete captures have no unresolved capture issues')
  }
  if (run.status === 'completed') {
    assert.equal(run.exitCode, 0, 'Completed session has a zero exit code')
    assert.equal(run.timedOut, false, 'Completed session did not time out')
    assert.equal(run.capture.complete, true, 'Completed session has complete capture')
  }
  for (const name of ['fixtureSha256', 'preparedSha256', 'promptSha256', 'evidenceSha256']) assert(validHash(run[name]), `Recorded identity digest exists: ${name}`)
  assert.equal(run.promptSha256, task.promptSha256, 'Every arm uses the same frozen task prompt')
  if (run.rawSha256 !== undefined) assert(validHash(run.rawSha256), 'Raw capture digest is valid when present')
}

function verifyPublicRecord(record, run, task, config) {
  assert.equal(record.schemaVersion, 1, 'Known public run schema')
  const { evidence, evidenceSha256, ...measurements } = run
  equal(record.run, measurements, `Public measurements match report: ${run.id}`)
  equal(record.prompt, task.prompt, 'Public prompt matches its frozen task')
  equal(hash(record.prompt), task.promptSha256, 'Prompt bytes match their frozen digest')
  assert(Array.isArray(record.actions), 'Public actions are retained')
  assert.equal(new Set(record.actions.map(action => action.idSha256)).size, record.actions.length, 'Public actions have distinct identities')
  for (const action of record.actions) {
    assert(['command_execution', 'mcp_tool_call', 'file_change'].includes(action.type), 'Only allowlisted public action types are published')
    assert(validHash(action.idSha256), 'Each public action retains its identity hash')
    for (const name of ['startedMs', 'completedMs']) assert(nullable(action[name], finite), 'Action timing is known or explicitly absent')
    if (action.type === 'command_execution') equal(action.search, classifySearchCommand(action.command), 'Search classification is derived from the actual command')
  }
  const commands = record.actions.filter(action => action.type === 'command_execution')
  const calls = record.actions.filter(action => action.type === 'mcp_tool_call')
  const succeeded = calls.filter(action => action.status === 'completed' && action.hasResult && !action.hasError && !action.result?.isError).length
  equal(run.counts, {
    shellCalls: commands.length, mcpCalls: calls.length, mcpSucceeded: succeeded, mcpFailed: calls.length - succeeded,
    fileEdits: record.actions.filter(action => action.type === 'file_change').length,
    grepShellCalls: commands.filter(action => action.search.search).length,
    contentSearchShellCalls: commands.filter(action => action.search.contentSearch).length,
    fileListingShellCalls: commands.filter(action => action.search.fileListing).length,
    ambiguousSearchShellCalls: commands.filter(action => action.search.ambiguous).length,
  }, 'All observed action counts reconcile with public actions')
  if (record.requestedConfig !== null) for (const [key, value] of Object.entries(config)) equal(record.requestedConfig?.[key], value, `Shared model configuration matches: ${key}`)
  else assert.equal(run.capture.complete, false, 'Missing requested configuration cannot claim a complete capture')
  if (run.correct === null) {
    const interruptedGrade = run.status === 'failed' && run.error?.stage === 'grading' && record.grading?.fixtureGitUnchanged === undefined
    assert(record.grading === null || record.grading?.passed == null || interruptedGrade, 'Unknown correctness cannot hide a completed grade')
  }
  else {
    equal(record.grading?.passed, run.correct, 'Correctness matches the independent grade')
    if (run.correct) {
      for (const value of [record.grading.integrity?.passed, record.grading.stable, record.grading.fixtureGitUnchanged, record.grading.checks?.result?.passed]) assert.equal(value, true, 'A passing result requires all independent grade checks')
      assert.equal(record.grading.checks.exitCode, 0, 'Passing independent checks exit successfully')
    }
  }
  if (run.nativeValidation) {
    assert(Array.isArray(run.nativeValidation.checks) && bool(run.nativeValidation.failingThenLaterCheckObserved), 'Requested native validation observations remain explicit')
    for (const check of run.nativeValidation.checks) {
      const action = commands.find(value => value.idSha256 === check.actionIdSha256)
      assert(action, 'Observed native check belongs to a recorded public shell action')
      equal(check.outputSha256, action.outputSha256, 'Native validation retains its output identity')
      equal(check.commandExitCode, action.exitCode, 'Native validation retains the aggregate command exit')
      equal(check.cases, task.publicCases, 'Native validation uses the frozen public case count')
      assert(bool(check.passed), 'Observed native check has a known outcome')
    }
    if (run.nativeValidation.failingThenLaterCheckObserved) assert(run.nativeValidation.checks.length >= 2 && run.nativeValidation.checks[0].passed === false, 'Claimed failing check and later check were observed')
  }
}

export function verifyMonorepoReport(report, wrapper, gate) {
  assert.equal(report.schemaVersion, 1, 'Known agent study schema')
  assert.equal(report.complete, true, 'All scheduled sessions must finish before publication')
  assert.equal(wrapper.schemaVersion, 1, 'Known public protocol wrapper')
  assert(validHash(report.protocolSha256), 'Original frozen protocol digest is retained')
  equal(wrapper.privateProtocolSha256, report.protocolSha256, 'Report and public wrapper bind the same original protocol')
  equal(wrapper.protocol, report.protocol, 'Published protocol exactly matches the normalized report')
  const protocol = report.protocol
  equal(protocol.candidates, ['typelatch', 'packet'], 'Both preregistered candidates remain visible')
  assert.equal(protocol.tasks.length, 2, 'Frozen two task design')
  assert.equal(protocol.repeats, 2, 'Frozen two repeat design')
  assert.equal(protocol.runCount, 16, 'Frozen four arm study')
  const taskIds = protocol.tasks.map(task => task.id)
  for (const task of protocol.tasks) { assert(safeId(task.id)); assert.equal(hash(task.prompt), task.promptSha256, 'Frozen prompt is hash bound'); assert(integer(task.publicCases) && task.publicCases > 0) }
  equal(protocol.decisionGate, gate.decisionGate, 'The frozen gate cannot change after observing results')
  equal(protocol.schedule, gate.makeSchedule(taskIds, protocol.candidates), 'The counterbalanced schedule is preserved')
  equal(report.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm })), protocol.schedule, 'Every scheduled run is present once and in order')
  assert.equal(report.runs.length, 16)
  assert.equal(new Set(report.runs.map(run => run.id)).size, 16)
  assert.equal(report.preparationAttempts?.length, 16, 'Every preparation attempt remains recorded')
  const fixtures = new Map()
  for (const [index, run] of report.runs.entries()) {
    const task = protocol.tasks.find(value => value.id === run.task)
    verifyRun(run, task)
    const attempt = report.preparationAttempts[index]
    for (const key of ['id', 'task', 'repeat', 'arm']) equal(attempt[key], run[key], 'Preparation identity matches its scheduled run')
    assert(['ready', 'failed'].includes(attempt.status), 'Preparation state is terminal')
    equal(attempt.providerSetupMs, run.providerSetupMs, 'All provider preparation is charged')
    if (fixtures.has(run.task)) equal(run.fixtureSha256, fixtures.get(run.task), 'All arms and repeats start from matching task bytes')
    else fixtures.set(run.task, run.fixtureSha256)
  }
  equal(report.decision, gate.evaluateDecision(report), 'Displayed decisions are recomputed with the frozen implementation')
  return report.decision
}

export async function verifyMonorepoEvidence(reportBytes, protocolBytes, manifestBytes, readPublic) {
  const report = JSON.parse(reportBytes), wrapper = JSON.parse(protocolBytes), manifest = JSON.parse(manifestBytes)
  assert.equal(manifest.schemaVersion, 1, 'Known public evidence manifest')
  for (const run of report.runs) assert(safeId(run.id) && run.evidence === `runs/${run.id}.json`, 'Study evidence uses exact safe run paths')
  const pilotPath = 'infrastructure-attempt-001/report.json'
  const pilot = JSON.parse(readPublic(pilotPath))
  assert.equal(pilot.schemaVersion, 1, 'Known retained pilot schema')
  assert.equal(pilot.status, 'ineligible-infrastructure-failure', 'The interrupted pilot stays ineligible')
  assert.equal(pilot.comparativePerformanceEligible, false, 'Pilot timings are never pooled with the corrected study')
  assert.equal(pilot.runs.length, 5, 'All five launches from the retained pilot remain public')
  for (const run of pilot.runs) assert(safeId(run.id) && run.evidence === `runs/${run.id}.json`, 'Retained pilot evidence uses exact safe run paths')
  const required = ['report.json', 'protocol.json', 'decision.mjs', 'protocol-001.json', 'infrastructure-attempt-001.json', pilotPath, ...pilot.runs.map(run => `infrastructure-attempt-001/${run.evidence}`), ...report.runs.map(run => `runs/${run.id}.json`)]
  equal(manifest.files.map(file => file.path).sort(), required.toSorted(), 'Manifest contains exactly the study and retained attempt evidence')
  const files = new Map()
  for (const file of manifest.files) {
    const bytes = file.path === 'report.json' ? reportBytes : file.path === 'protocol.json' ? protocolBytes : readPublic(file.path)
    assert(validHash(file.sha256) && integer(file.bytes), 'Every exported file has a digest and size')
    equal(hash(bytes), file.sha256, `Public artifact digest matches: ${file.path}`)
    equal(Buffer.byteLength(bytes), file.bytes, `Public artifact size matches: ${file.path}`)
    files.set(file.path, bytes)
  }
  const decisionBytes = files.get('decision.mjs')
  equal(hash(decisionBytes), frozenMonorepoDecisionSha256, 'Use the exact frozen decision implementation')
  const decisionInput = report.protocol.inputs.filter(input => String(input.path).endsWith('/agent-trial/decision.mjs'))
  assert.equal(decisionInput.length, 1, 'Protocol binds one decision implementation')
  equal(decisionInput[0].sha256, frozenMonorepoDecisionSha256, 'Public protocol binds the same frozen gate source')
  const gate = await import(`data:text/javascript;base64,${Buffer.from(decisionBytes).toString('base64')}`)
  verifyMonorepoReport(report, wrapper, gate)
  for (const run of report.runs) {
    equal(run.evidence, `runs/${run.id}.json`, 'Each run links only its own public evidence file')
    const bytes = files.get(run.evidence)
    equal(hash(bytes), run.evidenceSha256, 'Exact public run bytes match the report')
    verifyPublicRecord(JSON.parse(bytes), run, report.protocol.tasks.find(task => task.id === run.task), report.protocol.config)
  }
  const pilotWrapper = JSON.parse(files.get('protocol-001.json'))
  equal(pilot.privateProtocolSha256, pilotWrapper.privateProtocolSha256, 'Retained pilot binds its original protocol')
  equal(pilot.protocol, '../protocol-001.json', 'Retained pilot links its original protocol')
  equal(pilot.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm })), pilotWrapper.protocol.schedule.slice(0, 5), 'Retained launches preserve the original schedule prefix')
  for (const run of pilot.runs) {
    const task = pilotWrapper.protocol.tasks.find(task => task.id === run.task)
    verifyRun(run, task)
    const bytes = files.get(`infrastructure-attempt-001/${run.evidence}`)
    equal(hash(bytes), run.evidenceSha256, 'Exact retained pilot bytes match its report')
    verifyPublicRecord(JSON.parse(bytes), run, task, pilotWrapper.protocol.config)
  }
  files.set('manifest.json', manifestBytes)
  return { report, wrapper, gate, files }
}

const escape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const number = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US').format(value)
const seconds = value => value === null ? 'Unknown' : `${(value / 1000).toFixed(1)} s`
const total = (runs, read) => { const values = runs.map(read); return values.every(finite) ? values.reduce((sum, value) => sum + value, 0) : null }
const charged = run => finite(run.elapsedMs) && finite(run.providerSetupMs) ? run.elapsedMs + run.providerSetupMs : null
const observedCount = (run, key) => run.capture.complete ? run.counts[key] : null
const grade = value => value === null ? 'Unknown' : value ? 'Pass' : 'Fail'

export function renderMonorepoBenchmark(verified) {
  const { report, wrapper, gate } = verified
  const decision = verifyMonorepoReport(report, wrapper, gate)
  const protocol = report.protocol, competitor = protocol.spec.competitorSelection
  const labels = { native: 'Native tools', competitor: `${competitor.name} ${competitor.version}`, typelatch: `Typelatch ${protocol.typelatchArchiveBinding.version} candidate`, packet: 'Typelatch source packet v2 prototype' }
  const byArm = Object.fromEntries(monorepoArmOrder.map(arm => [arm, report.runs.filter(run => run.arm === arm)]))
  const totals = monorepoArmOrder.map(arm => {
    const runs = byArm[arm], correct = runs.filter(run => run.correct === true).length, unknown = runs.filter(run => run.correct === null).length
    return `<tr data-monorepo-arm="${arm}"><th scope="row">${escape(labels[arm])}</th><td>${correct} / ${runs.length}${unknown ? ` <span>(${unknown} unknown)</span>` : ''}</td><td>${number(total(runs, run => run.usage.totalTokens))}</td><td>${seconds(total(runs, charged))}</td><td>${number(total(runs, run => observedCount(run, 'grepShellCalls')))}</td><td>${number(total(runs, run => observedCount(run, 'mcpCalls')))}</td></tr>`
  }).join('')
  const rows = report.runs.map((run, index) => `<tr data-monorepo-run="${escape(run.id)}"><td>${index + 1}</td><th scope="row"><a href="evidence/monorepo-agent-study/${escape(run.evidence)}">${escape(protocol.tasks.find(task => task.id === run.task).title)}</a><span>Repeat ${run.repeat} · ${escape(labels[run.arm])}</span></th><td>${grade(run.correct)}</td><td>${number(run.usage.totalTokens)}</td><td>${seconds(charged(run))}</td><td>${number(observedCount(run, 'grepShellCalls'))}</td><td>${number(observedCount(run, 'mcpCalls'))}</td><td>${escape(run.status)}${run.capture.complete ? '' : '; capture incomplete'}${run.processGroupStopped && run.providerStopped ? '' : '; cleanup unconfirmed'}</td></tr>`).join('')
  const accounting = [['Input tokens', run => run.usage.inputTokens, number], ['Cached input, already included', run => run.usage.cachedInputTokens, number], ['Output tokens', run => run.usage.outputTokens, number], ['Provider preparation', run => run.providerSetupMs, seconds], ['Agent time', run => run.elapsedMs, seconds], ['Common fixture preparation, excluded', run => run.fixtureSetupMs, seconds], ['Independent grading, excluded', run => run.gradingMs, seconds], ['Teardown, excluded', run => run.teardownMs, seconds], ['Successful MCP calls', run => observedCount(run, 'mcpSucceeded'), number], ['Failed MCP calls', run => observedCount(run, 'mcpFailed'), number]].map(([title, read, format]) => `<tr><th scope="row">${escape(title)}</th>${monorepoArmOrder.map(arm => `<td>${format(total(byArm[arm], read))}</td>`).join('')}</tr>`).join('')
  const candidateResults = ['typelatch', 'packet'].map(arm => {
    const result = decision.candidateDecisions?.[arm], runs = byArm[arm], adopted = runs.filter(run => run.counts.mcpCalls > 0).length
    const state = !decision.measurable ? 'Comparison ineligible' : result.qualifiedWin ? 'Met the qualifying gate' : result.passed ? 'Savings gate met; not every solution passed' : 'Did not meet the gate'
    const reasons = result?.reasons ?? decision.reasons
    return `<article class="monorepo-decision"><h3>${escape(labels[arm])}</h3><p><strong>${state}.</strong> Observed MCP use in ${adopted} of ${runs.length} sessions. Zero use remains in the results.${adopted === 0 ? ' No MCP calls were observed, so this condition does not demonstrate a retrieval benefit.' : ''}</p>${reasons.length ? `<details><summary>Recorded gate reasons</summary><ul>${reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></details>` : ''}</article>`
  }).join('')
  return `<section class="benchmark-section monorepo-benchmark" id="monorepo-benchmark" aria-labelledby="monorepo-benchmark-title"><div class="wrap"><div class="section-heading"><div><p class="eyebrow">REAL MAINTENANCE TASKS</p><h2 id="monorepo-benchmark-title">Four conditions.<br /><span>Every session counted.</span></h2></div><p>${protocol.tasks.length} public maintenance tasks, ${protocol.repeats} repeats per condition, ${report.runs.length} actual Codex sessions. Prompts are identical within each task. Tool choice is optional.</p></div><p class="benchmark-scroll-hint">Scroll the table to compare tokens, time and tool calls.</p><div class="benchmark-table-wrap" role="region" aria-label="All four maintenance study conditions" tabindex="0"><table class="benchmark-table"><caption>All four conditions, in a fixed order</caption><thead><tr><th scope="col">Condition</th><th scope="col">Correct</th><th scope="col">Total tokens</th><th scope="col">Charged time</th><th scope="col">Grep calls</th><th scope="col">MCP calls</th></tr></thead><tbody>${totals}</tbody></table></div><p class="benchmark-scope">Tokens include cached input and output, each counted once. Charged time includes provider preparation and the complete agent session. These are two localized repairs in an older pnpm snapshot with 198 packages. Each needs one implementation file; supplied failing checks give useful clues. This does not test scaling or establish an advantage on large repositories. These public tasks may appear in model training data.</p><div class="monorepo-decisions">${candidateResults}</div><details class="benchmark-details"><summary>Every session and its evidence <span aria-hidden="true">+</span></summary><div class="benchmark-table-wrap" role="region" aria-label="All sixteen maintenance study sessions" tabindex="0"><table class="benchmark-table monorepo-run-table"><caption>Frozen execution order, including failures and unknown results</caption><thead><tr><th scope="col">Order</th><th scope="col">Task and condition</th><th scope="col">Correctness</th><th scope="col">Tokens</th><th scope="col">Charged time</th><th scope="col">Grep</th><th scope="col">MCP</th><th scope="col">Capture state</th></tr></thead><tbody>${rows}</tbody></table></div></details><details class="benchmark-details"><summary>Accounting and the frozen decision gate <span aria-hidden="true">+</span></summary><p>Model: <code>${escape(protocol.config.model)}</code>. Reasoning: <code>${escape(protocol.config.model_reasoning_effort)}</code>. Each candidate is judged separately against native tools and ${escape(competitor.name)}. The gate requires at least 20% lower tokens and charged time in aggregate and in the median paired comparison, improvement in both repeats, and no correctness decline overall or per task. Every requested before and after native check must be observed. A qualifying win also requires all four candidate solutions to pass. Candidate results are never pooled.</p><p>Grep counts shell calls containing recorded search commands, not every possible way to search. MCP counts include failed calls. Incomplete captures show unknown comparable action counts; raw observed counts remain in the linked evidence. Unknown usage is not zero. Provider caches, host load and model sampling can affect results.</p><div class="benchmark-table-wrap" role="region" aria-label="Maintenance token and time accounting" tabindex="0"><table class="benchmark-table"><caption>Accounting totals</caption><thead><tr><th scope="col">Metric</th>${monorepoArmOrder.map(arm => `<th scope="col">${escape(labels[arm])}</th>`).join('')}</tr></thead><tbody>${accounting}</tbody></table></div></details><div class="benchmark-links"><a href="evidence/monorepo-agent-study/report.json">All results</a><a href="evidence/monorepo-agent-study/protocol.json">Frozen protocol</a><a href="evidence/monorepo-agent-study/decision.mjs">Exact decision implementation</a><a href="evidence/monorepo-agent-study/manifest.json">Evidence digests</a><a href="evidence/monorepo-agent-study/infrastructure-attempt-001/report.json">Five earlier launches, ineligible for comparison</a><a href="#benchmark">Earlier authored task comparison</a></div></div></section>`
}
