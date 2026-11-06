import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { summarizePairedRuns } from './paired-agent-evidence.mjs'
import { evaluateDecision } from './paired-agent-decision.mjs'

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const number = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
const seconds = value => value === null ? 'Unknown' : `${(value / 1000).toFixed(1)} s`
const arms = ['baseline', 'typelatch']
const armLabel = arm => arm === 'baseline' ? 'Without Typelatch' : 'With Typelatch'
const finite = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
const count = value => value === null || (Number.isSafeInteger(value) && value >= 0)
const metricNames = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens', 'uncachedInputTokens']
const countNames = ['shellCalls', 'mcpCalls', 'mcpSucceeded', 'mcpFailed', 'fileEdits', 'grepShellCalls', 'contentSearchShellCalls', 'fileListingShellCalls', 'ambiguousSearchShellCalls']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export function verifySiteBenchmark(report) {
  assert.equal(report.schemaVersion, 1, 'Known paired benchmark schema')
  assert(report.protocol && typeof report.protocol.model === 'string' && report.protocol.model, 'The requested model is recorded')
  assert(typeof report.protocol.reasoningEffort === 'string' && report.protocol.reasoningEffort, 'Reasoning setting is recorded')
  assert(typeof report.protocol.toolPackage === 'string' && /^typelatch@\d+\.\d+\.\d+$/.test(report.protocol.toolPackage), 'Exact benchmark package identity is recorded')
  assert(Number.isInteger(report.protocol.repeats) && report.protocol.repeats > 0, 'Repeat count is recorded')
  assert(Array.isArray(report.tasks) && report.tasks.length > 0, 'Task inventory is recorded')
  const tasks = new Map(report.tasks.map(task => [task.id, task]))
  assert.equal(tasks.size, report.tasks.length, 'Task identities are unique')
  for (const task of tasks.values()) {
    assert(typeof task.id === 'string' && /^[a-z0-9-]+$/.test(task.id), 'Task identity is safe')
    assert(typeof task.title === 'string' && task.title, 'Task title exists')
  }
  assert(Array.isArray(report.runs), 'Run inventory exists')
  assert.equal(report.runs.length, tasks.size * report.protocol.repeats * 2, 'Every planned session remains in the report')
  const ids = new Set()
  const pairKeys = new Set()
  for (const run of report.runs) {
    assert(typeof run.id === 'string' && /^[a-z0-9-]+$/.test(run.id) && !ids.has(run.id), 'Run identities are unique and safe')
    ids.add(run.id)
    assert(tasks.has(run.task) && arms.includes(run.arm), 'Run belongs to a planned task and arm')
    assert(Number.isInteger(run.repeat) && run.repeat >= 1 && run.repeat <= report.protocol.repeats, 'Run belongs to a planned repeat')
    const pairKey = `${run.task}:${run.repeat}:${run.arm}`
    assert(!pairKeys.has(pairKey), 'A planned run cannot be counted twice')
    pairKeys.add(pairKey)
    assert(run.correct === true || run.correct === false || run.correct === null, 'Correctness remains explicit')
    assert(finite(run.elapsedMs), 'Agent time is a nonnegative duration or unknown')
    assert(finite(run.setupMs) && finite(run.indexSetupMs), 'Preparation time remains separate and explicit')
    assert(run.usage && run.counts, 'Usage and action counts remain explicit')
    for (const key of metricNames) assert(count(run.usage[key]), `Token count is explicit: ${key}`)
    for (const key of countNames) assert(count(run.counts[key]), `Action count is explicit: ${key}`)
    if (run.usage.inputTokens !== null && run.usage.outputTokens !== null) assert.equal(run.usage.totalTokens, run.usage.inputTokens + run.usage.outputTokens, 'Token total excludes double counting cache and reasoning')
    if (run.usage.cachedInputTokens !== null && run.usage.inputTokens !== null) {
      assert(run.usage.cachedInputTokens <= run.usage.inputTokens, 'Cached input is a subset of input')
      assert.equal(run.usage.uncachedInputTokens, run.usage.inputTokens - run.usage.cachedInputTokens, 'Uncached input reconciles')
    }
  }
  const summary = summarizePairedRuns(report.runs)
  assert.deepEqual(report.summary, summary, 'Displayed benchmark summary matches every recorded run')
  if (report.protocol.candidate) assert.deepEqual(report.decision, evaluateDecision(report), 'Displayed candidate decision matches the recorded runs')
  return summary
}

export function verifySiteBenchmarkEvidence(report, protocolBytes, readRun) {
  verifySiteBenchmark(report)
  verifySiteBenchmarkFixtures(report)
  assert.equal(report.complete, true, 'All planned benchmark sessions have finished')
  assert.equal(hash(protocolBytes), report.protocolSha256, 'Frozen protocol bytes match the report')
  const protocol = JSON.parse(protocolBytes)
  assert.equal(protocol.schemaVersion, 1, 'Known frozen protocol schema')
  assert.deepEqual(protocol, report.protocol, 'Published protocol matches the captured settings')
  assert.equal(report.package.identity, protocol.toolPackage, 'Captured package identity matches the protocol')
  assert.equal(protocol.runCount, report.runs.length, 'Frozen schedule has every recorded session')
  assert.equal(protocol.taskCount, report.tasks.length, 'Frozen task count matches the report')
  assert.deepEqual(protocol.tasks.map(({ id, title }) => ({ id, title })), report.tasks, 'Published task identities match the frozen protocol')
  assert.deepEqual(protocol.schedule, report.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm })), 'Captured run order matches the frozen schedule')
  const tasks = new Map(protocol.tasks.map(task => [task.id, task]))
  for (const task of tasks.values()) assert.equal(hash(task.prompt), task.promptSha256, 'Frozen task prompt matches its digest')
  const files = new Map([['paired-agent-protocol.json', protocolBytes]])
  for (const run of report.runs) {
    const path = `paired-agent-runs/${run.id}.json`
    assert.equal(run.evidence, path, 'Run evidence stays under its exact public identity')
    const bytes = readRun(path)
    assert.equal(hash(bytes), run.evidenceSha256, `Run evidence bytes match the report: ${run.id}`)
    const record = JSON.parse(bytes)
    assert.equal(record.schemaVersion, 1, 'Known public run evidence schema')
    const { evidenceSha256, ...recordedRun } = run
    assert.deepEqual(record.run, recordedRun, `Public run measurements match the summary: ${run.id}`)
    const task = tasks.get(run.task)
    assert.equal(run.promptSha256, task.promptSha256, 'Each run uses its frozen task prompt')
    assert.equal(hash(record.prompt), task.promptSha256, 'Public prompt bytes match the frozen task')
    assert.equal(record.prompt, task.prompt, 'Public prompt matches the recorded task')
    files.set(path, bytes)
  }
  return files
}

export function verifySiteBenchmarkFixtures(report) {
  const comparisons = report.fixtureComparisons
  assert(comparisons && typeof comparisons === 'object', 'Fixture comparison identities are recorded')
  assert.deepEqual(Object.keys(comparisons).sort(), report.runs.map(run => run.id).sort(), 'Every run has exactly one fixture comparison')
  const taskHashes = new Map()
  const allowedPaths = new Set(['node_modules/better-sqlite3/build/Makefile', 'node_modules/better-sqlite3/build/config.gypi'])
  for (const run of report.runs) {
    const comparison = comparisons[run.id]
    assert(validHash(comparison.rawManifestSha256) && validHash(comparison.comparisonSha256), 'Raw and comparison fixture digests are explicit')
    assert.equal(comparison.rawManifestSha256, run.fixtureSha256, 'Comparison retains the original captured fixture identity')
    assert(Array.isArray(comparison.normalizations), 'Fixture normalization inventory is explicit')
    const seen = new Set()
    for (const row of comparison.normalizations) {
      assert(allowedPaths.has(row.path) && !seen.has(row.path), 'Only the two generated native build files may normalize workspace paths')
      seen.add(row.path)
      assert(validHash(row.rawSha256) && validHash(row.comparisonSha256), 'Normalized file retains both byte identities')
      assert(Number.isSafeInteger(row.replacements) && row.replacements > 0, 'Normalization records actual path replacements')
      assert(Array.isArray(row.aliasReplacementCounts) && row.aliasReplacementCounts.every(value => Number.isSafeInteger(value) && value > 0), 'Normalization records path alias counts')
      assert.equal(row.aliasReplacementCounts.reduce((total, value) => total + value, 0), row.replacements, 'Normalization replacement counts reconcile')
    }
    if (comparison.normalizations.length === 0) assert.equal(comparison.comparisonSha256, comparison.rawManifestSha256, 'Unnormalized inventory keeps its exact byte identity')
    if (taskHashes.has(run.task)) assert.equal(comparison.comparisonSha256, taskHashes.get(run.task), 'All conditions and repeats start from matching task inputs')
    else taskHashes.set(run.task, comparison.comparisonSha256)
  }
}

export function verifySiteBenchmarkAnimation(report, animation, readAsset, source) {
  assert.equal(animation.schemaVersion, 1, 'Known benchmark animation schema')
  assert(source?.reportBytes && source?.rendererBytes, 'Replay report and renderer source bytes are required')
  assert.equal(hash(source.reportBytes), animation.reportSha256, 'Animation is bound to the exact published report bytes')
  assert.deepEqual(JSON.parse(source.reportBytes), report, 'Animation report bytes match the displayed measurements')
  assert.equal(hash(source.rendererBytes), animation.rendererSha256, 'Animation is bound to its renderer source bytes')
  assert.equal(animation.task, 'sqlite-rollback', 'Animation uses the first selected task, independent of outcome')
  assert.equal(animation.repeat, 1, 'Animation uses the first selected repeat')
  const runs = arms.map(arm => report.runs.find(run => run.task === animation.task && run.repeat === animation.repeat && run.arm === arm))
  assert(runs.every(Boolean), 'Both replayed sessions are recorded')
  assert.deepEqual(animation.runs, runs.map(({ id, evidenceSha256 }) => ({ id, evidenceSha256 })), 'Animation is bound to the exact public run evidence')
  const paths = { gif: 'assets/codex-comparison.gif', poster: 'assets/codex-comparison.png' }
  for (const [kind, path] of Object.entries(paths)) {
    assert.equal(animation.assets?.[kind]?.path, path, 'Animation asset has its exact public path')
    const bytes = readAsset(path)
    assert.equal(hash(bytes), animation.assets[kind].sha256, `Animation ${kind} bytes match its manifest`)
    if (kind === 'gif') assert.match(Buffer.from(bytes).subarray(0, 6).toString(), /^GIF8[79]a$/, 'Replay asset is a GIF')
    else assert.equal(Buffer.from(bytes).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Reduced motion poster is a PNG')
  }
  return animation
}

const changeText = (baseline, typelatch, formatter) => {
  if (baseline === null || typelatch === null) return 'Difference unknown'
  if (baseline === typelatch) return 'No measured difference'
  const direction = typelatch < baseline ? 'lower' : 'higher'
  return baseline === 0 ? `${formatter(Math.abs(typelatch - baseline))} ${direction}` : `${(Math.abs(typelatch - baseline) / baseline * 100).toFixed(1)}% ${direction}`
}
const resultLabel = correct => correct === null ? 'Unknown' : correct ? 'Pass' : 'Fail'
const resultClass = correct => correct === null ? 'unknown' : correct ? 'pass' : 'fail'
const sum = (summary, arm, field) => summary.arms[arm].metrics[field].sum

function adoption(report) {
  const enabled = report.runs.filter(run => run.arm === 'typelatch')
  const unknown = enabled.filter(run => run.capture?.complete === false || run.counts.mcpCalls === null).length
  const observed = enabled.filter(run => run.counts.mcpCalls > 0).length
  return `${observed} of ${enabled.length} Typelatch enabled sessions called its tools${unknown ? `; ${unknown} capture${unknown === 1 ? '' : 's'} incomplete` : ''}.`
}

export function renderAutomaticBenchmark(report) {
  verifySiteBenchmark(report)
  assert.notEqual(report.protocol.study, 'explicit-tool-use', 'Automatic choice results have their own scope')
  return `<aside class="benchmark-automatic" aria-labelledby="automatic-title"><div><p class="small-label">AUTOMATIC TOOL CHOICE</p><h3 id="automatic-title">Also recorded. Kept separate.</h3></div><div><p>In the earlier ${report.runs.length} session study, the agent chose its own tools. ${escape(adoption(report))} These results are not pooled with the instructed workflow comparison above.</p><div class="benchmark-links"><a href="evidence/automatic/paired-agent.json">All automatic choice results <span aria-hidden="true">↗</span></a><a href="evidence/automatic/paired-agent-protocol.json">Original protocol <span aria-hidden="true">↗</span></a></div></div></aside>`
}

export function renderHistoricalBenchmark(report) {
  const summary = verifySiteBenchmark(report)
  const version = report.protocol.toolPackage.replace('typelatch@', '')
  const rows = [['Grep shell calls', 'grepShellCalls', number], ['Model tokens', 'totalTokens', number], ['Agent time', 'elapsedMs', seconds]].map(([title, field, format]) => `<tr><th scope="row">${title}</th>${arms.map(arm => `<td>${format(sum(summary, arm, field))}</td>`).join('')}</tr>`).join('')
  const correctness = `<tr><th scope="row">Correct solutions</th>${arms.map(arm => `<td>${summary.arms[arm].correct} / ${summary.arms[arm].runs}</td>`).join('')}</tr>`
  return `<details class="benchmark-details"><summary>Earlier ${escape(version)} comparison <span aria-hidden="true">+</span></summary><p>Original recorded study, kept separate. Model token use was ${changeText(sum(summary, 'baseline', 'totalTokens'), sum(summary, 'typelatch', 'totalTokens'), number)} and agent time was ${changeText(sum(summary, 'baseline', 'elapsedMs'), sum(summary, 'typelatch', 'elapsedMs'), seconds)} with Typelatch.</p><div class="benchmark-table-wrap" role="region" aria-label="Earlier benchmark totals" tabindex="0"><table class="benchmark-table"><caption>Original ${escape(version)} study totals</caption><thead><tr><th scope="col">Metric</th><th scope="col">Without Typelatch</th><th scope="col">With Typelatch</th></tr></thead><tbody>${rows}${correctness}</tbody></table></div><div class="benchmark-links"><a href="evidence/typelatch-030/paired-agent.json">Original results and every run</a><a href="evidence/typelatch-030/paired-agent-protocol.json">Original protocol</a><a href="evidence/typelatch-030/assets/codex-comparison.gif">Original recorded action replay</a><a href="evidence/typelatch-030/benchmark-animation.json">Replay evidence manifest</a></div></details>`
}

export function renderSiteBenchmark(report, animation = null, automaticArchive = '') {
  const summary = verifySiteBenchmark(report)
  const candidate = Boolean(report.protocol.candidate)
  const totalFor = (arm, field) => {
    if (field !== 'chargedTimeMs') return sum(summary, arm, field)
    const runs = report.runs.filter(run => run.arm === arm)
    return runs.every(run => run.elapsedMs !== null && run.indexSetupMs !== null) ? runs.reduce((total, run) => total + run.elapsedMs + run.indexSetupMs, 0) : null
  }
  const metricCard = (title, field, formatter, note) => {
    const baseline = totalFor('baseline', field)
    const typelatch = totalFor('typelatch', field)
    return `<article class="benchmark-metric"><h3>${escape(title)}</h3><dl>${arms.map(arm => `<div class="benchmark-arm benchmark-arm-${arm}"><dt>${armLabel(arm)}</dt><dd>${formatter(totalFor(arm, field))}</dd></div>`).join('')}</dl><p class="benchmark-change">${changeText(baseline, typelatch, formatter)}</p><p class="benchmark-unit">${escape(note)}</p></article>`
  }
  const correctness = `<article class="benchmark-metric"><h3>Correct solutions</h3><dl>${arms.map(arm => `<div class="benchmark-arm benchmark-arm-${arm}"><dt>${armLabel(arm)}</dt><dd>${summary.arms[arm].correct}<span> / ${summary.arms[arm].runs}</span></dd></div>`).join('')}</dl><p class="benchmark-change">Independent checks after each session</p><p class="benchmark-unit">${arms.map(arm => `${armLabel(arm)}: ${summary.arms[arm].incorrect} failed, ${summary.arms[arm].unknownCorrectness} unknown`).join('. ')}.</p></article>`
  const timeMetric = candidate ? ['Time including indexing', 'chargedTimeMs', seconds, 'Agent time plus Typelatch index preparation.'] : ['Agent time', 'elapsedMs', seconds, 'Sum of session durations. Preparation shown separately.']
  const cards = metricCard('Grep shell calls', 'grepShellCalls', number, 'Includes content search and file listing.') + metricCard('Model tokens', 'totalTokens', number, 'Reported input plus output. Cached input included.') + metricCard(...timeMetric) + correctness
  const observation = [['Model token use', 'totalTokens', number], timeMetric].map(([label, field, formatter]) => {
    const baseline = totalFor('baseline', field), typelatch = totalFor('typelatch', field)
    if (baseline === null || typelatch === null) return `${label} could not be compared.`
    if (baseline === typelatch) return `${label} was unchanged.`
    return `${label} was ${changeText(baseline, typelatch, formatter)} with Typelatch.`
  }).join(' ')
  const pairs = report.tasks.flatMap(task => Array.from({ length: report.protocol.repeats }, (_, index) => {
    const repeat = index + 1
    return arms.map((arm, armIndex) => {
      const run = report.runs.find(value => value.task === task.id && value.repeat === repeat && value.arm === arm)
      return `<tr data-benchmark-run="${escape(run.id)}" class="benchmark-row-${arm}">${armIndex === 0 ? `<th scope="rowgroup" rowspan="2">${escape(task.title)}<span>Repeat ${repeat}</span></th>` : ''}<th scope="row"><a href="evidence/paired-agent-runs/${escape(run.id)}.json">${armLabel(arm)}</a></th><td>${number(run.capture?.complete === false ? null : run.counts.grepShellCalls)}</td><td>${number(run.usage.totalTokens)}</td><td>${seconds(run.elapsedMs)}</td><td><span class="benchmark-result benchmark-result-${resultClass(run.correct)}">${resultLabel(run.correct)}</span></td></tr>`
    }).join('')
  })).join('')
  const breakdownMetrics = [
    ['Agent time, excluding index preparation', 'elapsedMs', seconds],
    ['Content search shell calls', 'contentSearchShellCalls', number],
    ['File listing shell calls', 'fileListingShellCalls', number],
    ['Ambiguous search shell calls', 'ambiguousSearchShellCalls', number],
    ['All shell calls', 'shellCalls', number],
    ['MCP calls', 'mcpCalls', number],
    ['MCP calls with errors', 'mcpFailed', number],
    ['Input tokens', 'inputTokens', number],
    ['Cached input tokens, already included', 'cachedInputTokens', number],
    ['Uncached input tokens', 'uncachedInputTokens', number],
    ['Output tokens', 'outputTokens', number],
    ['Reasoning output tokens, already included', 'reasoningOutputTokens', number],
  ]
  const breakdown = breakdownMetrics.map(([label, field, formatter]) => `<tr><th scope="row">${label}</th>${arms.map(arm => `<td>${formatter(sum(summary, arm, field))}</td>`).join('')}</tr>`).join('')
  const preparation = [['Fixture preparation', 'setupMs'], ['Typelatch index preparation', 'indexSetupMs']].map(([label, field]) => `<tr><th scope="row">${label}</th>${arms.map(arm => { const values = report.runs.filter(run => run.arm === arm).map(run => run[field]); return `<td>${seconds(values.every(value => value !== null) ? values.reduce((total, value) => total + value, 0) : null)}</td>` }).join('')}</tr>`).join('')
  const date = report.capturedAt ?? report.finishedAt ?? report.generatedAt ?? report.protocol.finishedAt
  assert(typeof date === 'string' && Number.isFinite(Date.parse(date)), 'Benchmark capture date is recorded')
  const recordedDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(date))
  const explicitUse = report.protocol.study === 'explicit-tool-use'
  const scope = explicitUse
    ? 'Both conditions receive identical task and workflow instructions: use Typelatch when available and native tools otherwise.'
    : 'Identical task prompts and starting files in both conditions. Typelatch was available in one condition; using it was optional.'
  const candidateLabel = candidate ? `<span>${escape(report.protocol.candidate.version)} candidate</span>` : ''
  const candidateGate = candidate ? `<p class="benchmark-scope">This candidate ${report.decision.passed ? 'met' : 'did not meet'} the recorded performance gate. Both token use and time including indexing must improve by at least 10%, without worse correctness.</p>` : ''
  const candidateTiming = candidate ? ' The candidate time comparison adds index preparation to agent time. Common fixture preparation, final grading and shared runtime installation remain excluded.' : ''
  const replay = animation ? `<figure class="benchmark-replay"><picture><source media="(prefers-reduced-motion: reduce)" srcset="${escape(animation.assets.poster.path)}" /><img id="comparison-replay" data-comparison-image data-gif="${escape(animation.assets.gif.path)}" data-poster="${escape(animation.assets.poster.path)}" src="${escape(animation.assets.poster.path)}" width="1080" height="680" loading="lazy" alt="Side by side replay of actual Codex actions on the same SQLite rollback task, without Typelatch and with Typelatch." /></picture><div class="benchmark-replay-controls"><button type="button" data-comparison-play aria-controls="comparison-replay" aria-pressed="false" hidden>Play comparison</button><a href="${escape(animation.assets.gif.path)}">Open GIF <span aria-hidden="true">↗</span></a><a href="evidence/paired-agent-runs/${escape(animation.runs[0].id)}.json">Without Typelatch: recorded actions</a><a href="evidence/paired-agent-runs/${escape(animation.runs[1].id)}.json">With Typelatch: recorded actions</a></div><figcaption>Recorded Codex actions, replayed side by side. Separate sessions aligned at start; playback accelerated. This is an action replay, not a screen recording.${explicitUse ? ' The shared prompt requests Typelatch when available and native tools otherwise.' : ''}</figcaption></figure>` : ''
  return `<section class="benchmark-section" id="benchmark" aria-labelledby="benchmark-title"><div class="wrap"><div class="section-heading"><div><p class="eyebrow">THE PAIRED AGENT BENCHMARK</p><h2 id="benchmark-title">Same tasks.<br /><span>Measured differences.</span></h2></div><p>Actual Codex sessions, with and without Typelatch. Same workflow instructions. Every result stays in the comparison.</p></div><p class="benchmark-protocol"><span>${report.tasks.length} tasks</span><span>${report.protocol.repeats} repeats per condition</span><span>${report.runs.length} sessions</span><span>${escape(recordedDate)}</span>${candidateLabel}</p>${replay}<div class="benchmark-metrics">${cards}</div><p class="benchmark-observation">${escape(observation)}</p>${candidateGate}<p class="benchmark-scope">Small authored task set, not a general performance ranking. ${scope} All sessions are included, regardless of correctness. ${escape(adoption(report))}</p><div class="benchmark-table-wrap" role="region" aria-label="Every paired agent result" tabindex="0"><table class="benchmark-table"><caption>Every paired result</caption><thead><tr><th scope="col">Task</th><th scope="col">Condition</th><th scope="col">Grep calls</th><th scope="col">Tokens</th><th scope="col">Agent time</th><th scope="col">Correctness</th></tr></thead><tbody>${pairs}</tbody></table></div><details class="benchmark-details"><summary>Accounting and method <span aria-hidden="true">+</span></summary><div class="benchmark-method"><div><h3>What the numbers mean</h3><p>Requested model: <code>${escape(report.protocol.model)}</code>. Reasoning: <code>${escape(report.protocol.reasoningEffort)}</code>. The same Codex CLI and native tools were available in both conditions. Package: <code>${escape(report.protocol.toolPackage)}</code>, adding its local MCP tools.</p><p>Grep calls count recorded shell calls that invoke <code>rg</code>, <code>grep</code>, <code>egrep</code> or <code>fgrep</code>. A compound shell call counts once, not once per process. File listing and content search are separated below. These counts do not cover every way to search text.</p><p>Tokens are the Codex CLI usage totals. Input includes cached input and repeated context; output includes reasoning when reported. Component counts are not added twice. Unknown data stays unknown.</p><p>Agent time runs from process launch to exit, including MCP startup. Fixture preparation includes dependency installation and the initial grader check. Typelatch index preparation is measured separately. Both preparation totals and final independent grading are outside agent time.${candidateTiming} Fixture comparison normalizes workspace paths in two generated native build files; original hashes remain recorded. Provider caching, service load and run order can affect time and usage.</p><p>Correctness comes from independent assertions after the agent stops, including protected file checks. Passing this fixture does not establish general coding success.</p></div><div class="benchmark-table-wrap" role="region" aria-label="Token and action accounting totals" tabindex="0"><table class="benchmark-table benchmark-breakdown"><caption>Totals across all sessions</caption><thead><tr><th scope="col">Recorded metric</th><th scope="col">Without Typelatch</th><th scope="col">With Typelatch</th></tr></thead><tbody>${breakdown}${preparation}</tbody></table></div></div></details><div class="benchmark-links"><a href="evidence/paired-agent.json">Download every run and its evidence <span aria-hidden="true">↗</span></a><a href="evidence/paired-agent-protocol.json">Frozen protocol <span aria-hidden="true">↗</span></a><a href="https://github.com/eDimka/typelatch/blob/main/docs/BENCHMARKS.md#paired-agent-comparison">Methodology and reproduction <span aria-hidden="true">↗</span></a></div>${automaticArchive}</div></section>`
}
