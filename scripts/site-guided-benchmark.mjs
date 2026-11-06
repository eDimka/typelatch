import assert from 'node:assert/strict'

export const guidedArmOrder = ['native', 'competitor', 'packet']
const escape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const total = (runs, read) => { const values = runs.map(read); return values.every(finite) ? values.reduce((sum, value) => sum + value, 0) : null }
const number = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US').format(value)
const seconds = value => value === null ? 'Unknown' : `${(value / 1000).toFixed(1)} s`
const charged = run => finite(run.providerSetupMs) && finite(run.elapsedMs) ? run.providerSetupMs + run.elapsedMs : null
const count = (run, name) => run.capture.complete ? run.counts[name] : null
const grade = value => value === null ? 'Unknown' : value ? 'Pass' : 'Fail'
const metric = (title, value, large = false) => `<div${large ? ' class="guided-metric-large"' : ''}><dt>${escape(title)}</dt><dd>${escape(value)}</dd></div>`
const href = path => `evidence/monorepo-guided-study/${escape(path)}`

export function renderGuidedAnimation(animation) {
  const poster = animation.assets.poster, gif = animation.assets.gif
  return `<figure class="benchmark-replay guided-replay"><picture><source media="(prefers-reduced-motion: reduce)" srcset="${escape(poster.path)}" /><img id="guided-comparison-replay" data-guided-comparison-image data-gif="${escape(gif.path)}" data-poster="${escape(poster.path)}" src="${escape(poster.path)}" width="${poster.width}" height="${poster.height}" loading="lazy" alt="Recorded Codex actions side by side for the preselected maintenance task, using native tools and the experimental Typelatch source packet, followed by their measured totals." /></picture><div class="benchmark-replay-controls"><button type="button" data-guided-comparison-play aria-controls="guided-comparison-replay" aria-pressed="false" hidden>Play recorded comparison</button><a href="${escape(gif.path)}">Open GIF <span aria-hidden="true">↗</span></a><a href="${escape(animation.runs[0].evidence)}">Native actions</a><a href="${escape(animation.runs[1].evidence)}">Packet actions</a><a href="evidence/guided-animation.json">Replay evidence</a></div><figcaption>Recorded public Codex actions from the preselected pair. Experimental source packet. Separate sessions aligned at the start; playback accelerated. Shared task and workflow policy with explicit provider inventories.</figcaption></figure>`
}

export function renderGuidedBenchmark(verified, animation = '') {
  verified.verify()
  const { report, adjudication, audit, workflowReview } = verified
  assert.equal(report.complete, true, 'Do not render a partial guided study')
  assert.equal(report.runs.length, 12, 'Retain every guided session')
  const protocol = report.protocol, decision = adjudication.decision
  const competitor = protocol.spec.competitorSelection
  const labels = { native: 'Native tools', competitor: `${competitor.name} ${competitor.version}`, packet: 'Experimental source packet' }
  const arms = Object.fromEntries(guidedArmOrder.map(arm => [arm, report.runs.filter(run => run.arm === arm)]))
  for (const runs of Object.values(arms)) assert.equal(runs.length, 4, 'Each arm retains four sessions')
  const nativeTokens = total(arms.native, run => run.usage.totalTokens), packetTokens = total(arms.packet, run => run.usage.totalTokens)
  const nativeTime = total(arms.native, charged), packetTime = total(arms.packet, charged)
  const nativeGrep = total(arms.native, run => count(run, 'grepShellCalls')), packetGrep = total(arms.packet, run => count(run, 'grepShellCalls'))
  const comparable = [nativeTokens, packetTokens, nativeTime, packetTime].every(finite) && nativeTokens > 0 && nativeTime > 0
  const fewerGrep = finite(nativeGrep) && finite(packetGrep) && packetGrep < nativeGrep
  const headline = comparable && packetTokens > nativeTokens && packetTime > nativeTime
    ? `${fewerGrep ? 'Fewer grep calls.' : 'Recorded tool use.'}<br /><span>More tokens and time.</span>`
    : 'Measured tool use.<br /><span>Every outcome retained.</span>'
  const relative = (native, packet, label) => native === packet ? `the same ${label}` : `${(Math.abs(packet - native) / native * 100).toFixed(1)}% ${packet > native ? 'more' : 'less'} ${label}`
  const correctCounts = guidedArmOrder.map(arm => arms[arm].filter(run => run.correct === true).length)
  const allKnown = report.runs.every(run => typeof run.correct === 'boolean')
  const correctnessSummary = allKnown && new Set(correctCounts).size === 1 ? ` All three conditions were correct in ${correctCounts[0]} of 4 sessions.` : ' Every correctness result is shown below.'
  const outcomeSummary = comparable ? `Compared with native tools, the experimental packet used ${relative(nativeTokens, packetTokens, 'tokens')} and ${relative(nativeTime, packetTime, 'charged time')}.${fewerGrep ? ` Grep calls fell from ${number(nativeGrep)} to ${number(packetGrep)}.` : ''}${correctnessSummary}` : 'Token or time measurements are incomplete. Unknowns remain visible, and all sessions are retained.'
  const reviewed = id => workflowReview.runs.find(row => row.id === id)
  const auditRow = id => audit.runs.find(row => row.id === id)
  const cards = guidedArmOrder.map(arm => {
    const runs = arms[arm], correct = runs.filter(run => run.correct === true).length, unknown = runs.filter(run => run.correct === null).length
    const compliance = runs.filter(run => reviewed(run.id)?.passed === true).length
    const unknownCompliance = runs.filter(run => !reviewed(run.id) || auditRow(run.id)?.instructionFollowed === 'unknown').length
    return `<article class="guided-arm-card" data-guided-arm="${arm}"><h3>${escape(labels[arm])}</h3><dl class="guided-metrics">${metric('Total tokens', number(total(runs, run => run.usage.totalTokens)), true)}${metric('Charged time', seconds(total(runs, charged)), true)}${metric('Correct solutions', `${correct} / ${runs.length}${unknown ? ` (${unknown} unknown)` : ''}`)}${metric('Workflow followed', `${compliance} / ${runs.length}${unknownCompliance ? ` (${unknownCompliance} unknown)` : ''}`)}${metric('Grep calls', number(total(runs, run => count(run, 'grepShellCalls'))))}${metric('MCP calls', number(total(runs, run => count(run, 'mcpCalls'))))}</dl></article>`
  }).join('')
  const candidate = decision.candidateDecisions?.packet
  const outcome = !decision.measurable ? 'Comparison ineligible' : candidate?.qualifiedWin ? 'Met the qualifying gate' : 'Did not meet the qualifying gate'
  const measured = !decision.measurable ? 'Unknown' : candidate?.economicGatePassed ? 'Passed' : 'Failed'
  const compliance = workflowReview.passed ? 'Passed' : 'Failed or unresolved'
  const reasons = candidate?.reasons ?? decision.reasons
  const comparisons = candidate ? ['native', 'competitor'].map(arm => {
    const metrics = candidate.comparisons[arm].metrics
    const change = value => value === 0 ? 'unchanged' : `${Math.abs(value).toFixed(1)}% ${value > 0 ? 'lower' : 'higher'}`
    return `<p><strong>Packet versus ${escape(labels[arm])}:</strong> ${change(metrics.totalTokens.aggregateReductionPercent)} total tokens; ${change(metrics.chargedTimeMs.aggregateReductionPercent)} charged time.</p>`
  }).join('') : ''
  const runCards = report.runs.map((run, index) => {
    const task = protocol.tasks.find(task => task.id === run.task), row = reviewed(run.id), review = auditRow(run.id)
    return `<article class="guided-run-card" data-guided-run="${escape(run.id)}"><h4>${index + 1}. ${escape(task.title)}</h4><p>Repeat ${run.repeat} · ${escape(labels[run.arm])}</p><dl class="guided-metrics">${metric('Correctness', grade(run.correct))}${metric('Workflow', row?.passed ? 'Pass' : review?.instructionFollowed === 'unknown' || !row ? 'Unknown' : 'Fail')}${metric('Total tokens', number(run.usage.totalTokens))}${metric('Charged time', seconds(charged(run)))}${metric('Grep calls', number(count(run, 'grepShellCalls')))}${metric('MCP calls', number(count(run, 'mcpCalls')))}</dl><p class="guided-capture-state">${escape(run.status)}${run.capture.complete ? '' : '; capture incomplete'}${run.processGroupStopped && run.providerStopped ? '' : '; cleanup unconfirmed'}</p><div class="benchmark-links"><a href="${href(run.evidence)}">Actions and grade</a><a href="${href(run.toolOutputs ?? run.unavailableToolOutputs)}">${run.toolOutputs === null ? 'Output unavailable receipt' : 'Returned tool evidence'}</a></div></article>`
  }).join('')
  const accounting = guidedArmOrder.map(arm => `<article class="guided-account-card"><h4>${escape(labels[arm])}</h4><dl class="guided-metrics">${[
    ['Input tokens', run => run.usage.inputTokens, number],
    ['Cached input, included above', run => run.usage.cachedInputTokens, number],
    ['Output tokens', run => run.usage.outputTokens, number],
    ['Provider preparation, charged', run => run.providerSetupMs, seconds],
    ['Agent session, charged', run => run.elapsedMs, seconds],
    ['Common fixture preparation, excluded', run => run.fixtureSetupMs, seconds],
    ['Independent grading, excluded', run => run.gradingMs, seconds],
    ['Teardown, excluded', run => run.teardownMs, seconds],
    ['Failed MCP calls, included above', run => count(run, 'mcpFailed'), number],
  ].map(([title, read, format]) => metric(title, format(total(arms[arm], read)))).join('')}</dl></article>`).join('')
  return `<section class="benchmark-section guided-benchmark" id="guided-benchmark" aria-labelledby="guided-benchmark-title"><div class="wrap">
    <div class="section-heading"><div><p class="eyebrow">GUIDED TOOL USE · TWELVE CODEX SESSIONS</p><h2 id="guided-benchmark-title">${headline}</h2></div><p>${outcomeSummary}</p></div>
    <p class="benchmark-scope">Two localized repairs in an older pnpm snapshot with 198 packages. Each needs one implementation file, and supplied failing checks give useful clues. This does not establish scaling or general superiority on large repositories. The source packet is an unpublished Typelatch prototype. The task and workflow policy are shared. Each condition names its available provider and tools.</p>
    ${animation}
    <div class="guided-arm-cards">${cards}</div>
    <p class="guided-account-note">Total tokens include cached input and output once. Charged time includes provider preparation and the complete agent session.</p>
    <div class="guided-verdict"><h3>${outcome}</h3><p><strong>Measured token, time and correctness thresholds: ${measured}.</strong> Independent workflow review: ${compliance}. Both controls must be beaten under the frozen rules. All sessions and costs remain included.</p>${comparisons}${reasons?.length ? `<details><summary>Exact decision reasons</summary><ul>${reasons.map(reason => `<li>${escape(reason)}</li>`).join('')}</ul></details>` : ''}</div>
    <details class="benchmark-details guided-runs"><summary>Every session, grade and returned evidence <span aria-hidden="true">+</span></summary><div class="guided-run-cards">${runCards}</div></details>
    <details class="benchmark-details"><summary>Accounting, workflow review and limits <span aria-hidden="true">+</span></summary><p>Model: <code>${escape(protocol.config.model)}</code>. Reasoning: <code>${escape(protocol.config.model_reasoning_effort)}</code>. The protocol requires every condition to run the supplied failing native check before its first investigation. Provider conditions must attempt that investigation through the declared provider, then choose tools freely. Startup instructions alone do not qualify.</p><p>The gate requires at least 20% lower total tokens and charged time against each control, both in aggregate and in the median paired comparison. Both repeats must improve, correctness must not decline, and all four packet solutions must pass. A qualifying result also requires an independent review of first investigation order and relevant provider use. Empty results, tool errors and unknown compliance remain distinct.</p><p>Public action evidence supports the workflow review; matching hashes alone do not prove relevance or ordering inside compound shell commands. Returned tool output replaces private path prefixes while retaining original payload hashes. Grep counts shell calls with recorded search commands. Unknown usage is not zero. Common corpus preparation, grading and teardown are reported separately. Public upstream repairs may appear in model training data; caches and model sampling can affect results.</p><div class="guided-account-cards">${accounting}</div></details>
    <div class="benchmark-links"><a href="${href('report.json')}">All twelve sessions</a><a href="${href('protocol.json')}">Frozen protocol</a><a href="${href('workflow-audit.json')}">Independent workflow review</a><a href="${href('adjudication.json')}">Final decision</a><a href="${href('manifest.json')}">Evidence digests</a><a href="${href('pilot-001/report.json')}">Retained three session pilot</a></div>
    <nav class="guided-history" aria-label="Earlier recorded comparisons"><p>Earlier results remain available.</p><a href="#monorepo-benchmark">Optional tool choice: all sixteen sessions</a><a href="#benchmark">Typelatch 0.4.0 candidate: original losses and replay</a></nav>
  </div></section>`
}
