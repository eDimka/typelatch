import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { classifySearchCommand } from './paired-agent-evidence.mjs'
import { verifyAgentRun } from './site-monorepo-benchmark.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const parse = bytes => JSON.parse(bytes.toString())
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const safePath = value => typeof value === 'string' && /^[a-zA-Z0-9._/-]+$/u.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')
const equal = (a, b, message) => assert.deepEqual(a, b, message)
const escape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])

// New studies require an explicit review of scope and protocol before appearing here.
export const crossPackageStudies = Object.freeze([
  { id: 'impact-002', title: 'Package impact analysis', candidate: 'impact', label: 'Experimental impact query', protocolSha256: '55f4f80df225b22df8dfeb26881aa464405bb3c6c7c2dff16199f705279a9bcb' },
  { id: 'impact-003', title: 'Impact analysis with a report writer', candidate: 'impact', label: 'Experimental query plus writer', protocolSha256: '6e3bf82021674ba0b1673fdbd38a35d1cbf8c0d48cdf614b095acbe3ae4016f0' },
  { id: 'maintenance-002', title: 'Catalog consistency repair with native validation', candidate: 'typelatch', label: 'Typelatch 0.4.0 candidate', protocolSha256: '85feb2502f876bea6592356ebd7ffbd84580e2302334bb892ebe268cae40fed3' },
  { id: 'maintenance-001', title: 'Catalog consistency repair', candidate: 'typelatch', label: 'Typelatch 0.4.0 candidate', protocolSha256: '9d3aa4945cbc094f627ab281ee93d0d13de0f9fdc933e05652e7d174c4882a59' },
  { id: 'development-001', title: 'Initial migration and impact baseline', candidate: 'typelatch', label: 'Typelatch 0.4.0 candidate', protocolSha256: 'ecf8115a01f1be08047671d96fa2ba1387390b15c2239358bb9b37858a08808e' },
])

export function verifyRecord(record, run, prompt, config) {
  const { evidenceSha256, toolOutputsSha256, ...measurements } = run
  equal(record.run, measurements, 'Public measurements match the report exactly')
  equal(record.schemaVersion, 1)
  equal(record.prompt, prompt.prompt, 'Each condition receives its frozen inventory prompt')
  equal(hash(record.prompt), run.promptSha256)
  assert(Array.isArray(record.actions))
  equal(new Set(record.actions.map(action => action.idSha256)).size, record.actions.length)
  for (const action of record.actions) {
    assert(digest(action.idSha256))
    assert(['command_execution', 'mcp_tool_call', 'file_change'].includes(action.type))
    for (const name of ['startedMs', 'completedMs']) assert(action[name] === null || finite(action[name]))
    if (action.type === 'command_execution') {
      const classified = classifySearchCommand(action.command)
      // This exact exported temp path replacement removed an escaped quote. Counts were recorded before normalization.
      const normalizedQuote = run.id === 'pnpm-catalog-consistency-r1-typelatch'
        && action.idSha256 === 'b40ee9c64c8028e7786be4b1266661a398dfa60613358262a0ce9e36bddd365d'
        && hash(action.command) === '9a91dc9a85d967c15888aae2c8f90be67cd63ebb1eeba1c37590101094a9ec4f'
      if (normalizedQuote) {
        equal(action.search, { search: false, contentSearch: false, fileListing: false, ambiguous: false })
        equal(classified, { search: false, contentSearch: false, fileListing: false, ambiguous: true })
      } else equal(action.search, classified)
    }
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
  }, 'Recorded search and MCP counts reconcile with every public action')
  if (record.requestedConfig) for (const [key, value] of Object.entries(config)) equal(record.requestedConfig[key], value)
  else assert.equal(run.capture.complete, false)
  if (run.correct !== null) equal(record.grading?.passed, run.correct, 'Keep independent repair grades separate from workflow review')
  else assert(record.grading?.passed == null || run.error?.stage === 'grading', 'Unknown grade needs an absent or interrupted independent check')
  if (run.correct) {
    equal(record.grading.fixtureGitUnchanged, true)
    assert(record.grading.integrity?.passed === true || record.grading.integrity?.changed?.length === 0, 'Passing repairs retain their allowed source boundary')
  }
  for (const artifact of record.taskArtifacts ?? []) {
    assert(safePath(artifact.path))
    equal(hash(artifact.text), artifact.sha256)
    equal(Buffer.byteLength(artifact.text), artifact.bytes)
  }
}

export function verifyOutputs(output, run, record) {
  equal(output.schemaVersion, 1)
  equal(output.runId, run.id)
  equal(output.rawCaptureSha256, run.rawSha256)
  equal(output.publicRecordSha256, run.evidenceSha256)
  const actions = record.actions.filter(action => ['command_execution', 'mcp_tool_call'].includes(action.type))
  equal(output.actions.map(action => action.idSha256), actions.map(action => action.idSha256), 'Returned tool evidence preserves every completed action')
  for (const [index, returned] of output.actions.entries()) {
    const source = actions[index]
    for (const name of source.type === 'command_execution'
      ? ['type', 'status', 'outputSha256', 'outputBytes', 'exitCode']
      : ['type', 'status', 'server', 'tool', 'resultSha256', 'resultBytes']) equal(returned[name], source[name])
  }
}

export function verifyCrossPackageEvidence(id, read) {
  const study = crossPackageStudies.find(study => study.id === id)
  assert(study, 'Unreviewed studies cannot silently become public claims')
  const protocolBytes = read('protocol.json'), protocol = parse(protocolBytes), freezeBytes = read('freeze.json'), freeze = parse(freezeBytes)
  equal(hash(protocolBytes), study.protocolSha256, 'Cross package protocol is the reviewed frozen source')
  equal(freeze.publicProtocolSha256, study.protocolSha256)
  equal(protocol.phase, 'development', 'These studies do not establish a held out advantage')
  equal(protocol.repeats, 1)
  equal(protocol.decisionGate.minimumReductionPercent, 20)
  equal(protocol.arms, ['native', study.candidate, 'competitor'])
  equal(protocol.candidates, [study.candidate])
  const manifestBytes = read('results/manifest.json'), manifest = parse(manifestBytes)
  equal(manifest.schemaVersion, 1)
  equal(manifest.originalResultsUnchanged, true)
  equal(manifest.privateProtocolSha256, freeze.privateProtocolSha256)
  assert(Array.isArray(manifest.files))
  const files = new Map([['protocol.json', protocolBytes], ['freeze.json', freezeBytes], ['results/manifest.json', manifestBytes]])
  for (const file of manifest.files) {
    assert(safePath(file.path), 'Evidence stays within its public bundle')
    assert(!files.has(`results/${file.path}`), 'Manifest paths are unique')
    const bytes = read(`results/${file.path}`)
    equal(hash(bytes), file.sha256, `Evidence digest matches: ${file.path}`)
    equal(bytes.length, file.bytes, `Evidence length matches: ${file.path}`)
    assert(digest(file.originalSha256), 'Export retains each original file identity')
    files.set(`results/${file.path}`, bytes)
  }
  const load = path => { assert(files.has(`results/${path}`), `Public evidence is listed in its manifest: ${path}`); return parse(files.get(`results/${path}`)) }
  const report = load('report.json')
  equal(manifest.files.find(file => file.path === 'report.json').originalSha256, manifest.privateReportSha256)
  equal(report.schemaVersion, 1)
  equal(report.complete, true, 'Only a complete scheduled result bundle can be displayed')
  equal(report.protocol, protocol)
  equal(report.protocolSha256, freeze.privateProtocolSha256)
  equal(report.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm })), protocol.schedule, 'Every scheduled run stays in its frozen order')
  equal(report.runs.length, protocol.runCount)
  equal(report.preparationAttempts.length, report.runs.length)
  const records = new Map(), fixtures = new Map()
  for (const [index, run] of report.runs.entries()) {
    const prompt = protocol.prompts.find(prompt => prompt.task === run.task && prompt.arm === run.arm)
    assert(prompt, 'Every condition has a frozen prompt')
    equal(hash(prompt.prompt), prompt.promptSha256)
    verifyAgentRun(run, prompt)
    const preparation = report.preparationAttempts[index]
    for (const key of ['id', 'task', 'repeat', 'arm', 'providerSetupMs']) equal(preparation[key], run[key], 'Provider setup is charged to the matching run')
    if (fixtures.has(run.task)) equal(run.fixtureSha256, fixtures.get(run.task), 'Every condition starts with identical fixture bytes')
    else fixtures.set(run.task, run.fixtureSha256)
    const recordPath = `runs/${run.id}/public-evidence.json`, outputsPath = `runs/${run.id}/tool-outputs.json`
    const record = load(recordPath)
    equal(hash(files.get(`results/${recordPath}`)), run.evidenceSha256)
    equal(hash(files.get(`results/${outputsPath}`)), run.toolOutputsSha256)
    verifyRecord(record, run, prompt, protocol.config)
    verifyOutputs(load(outputsPath), run, record)
    records.set(run.id, record)
  }
  const optional = path => files.has(`results/${path}`) ? load(path) : null
  const audit = optional('workflow-audit.json')
  if (audit) {
    equal(audit.reportSha256, manifest.privateReportSha256)
    equal(audit.protocolSha256, report.protocolSha256)
    equal(audit.noPrivateReasoningOrMessages, true)
    equal(new Set(audit.runs.map(row => row.id)), new Set(report.runs.map(run => run.id)), 'Every run receives an explicit workflow review')
    equal(audit.runs.length, report.runs.length)
    for (const row of audit.runs) {
      const run = report.runs.find(run => run.id === row.id), record = records.get(row.id)
      equal(row.evidenceSha256, run.evidenceSha256)
      equal(row.toolOutputsSha256, run.toolOutputsSha256)
      assert(['pass', 'fail', 'unknown'].includes(row.workflow), 'Workflow failure and uncertainty remain distinct')
      for (const id of [...row.basisActionIds, ...row.providerActionIds]) assert(record.actions.some(action => action.idSha256 === id), 'Review cites recorded public actions')
    }
  }
  const adjudication = optional('adjudicated-result.json')
  let adjudicationCurrent = false
  if (adjudication) {
    equal(adjudication.reportSha256, manifest.privateReportSha256)
    equal(adjudication.protocolSha256, report.protocolSha256)
    adjudicationCurrent = !!audit && adjudication.auditSha256 === hash(JSON.stringify(audit))
  }
  const nativeAudit = optional('native-validation-audit.json'), correctnessAudit = optional('correctness-audit.json')
  for (const audit of [nativeAudit, correctnessAudit].filter(Boolean)) {
    equal(audit.reportSha256, manifest.privateReportSha256)
    equal(audit.protocolSha256, report.protocolSha256)
  }
  const seal = hash(JSON.stringify({ report, audit, adjudication, nativeAudit, correctnessAudit }))
  return { study, report, audit, adjudication, adjudicationCurrent, nativeAudit, correctnessAudit, files,
    verify() { equal(hash(JSON.stringify({ report, audit, adjudication, nativeAudit, correctnessAudit })), seal, 'Rendered cross package data has not changed since verification') },
  }
}

const sum = (runs, read) => { const values = runs.map(read); return values.every(finite) ? values.reduce((a, b) => a + b, 0) : null }
const charged = run => finite(run.providerSetupMs) && finite(run.elapsedMs) ? run.providerSetupMs + run.elapsedMs : null
const format = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US').format(value)
const time = value => value === null ? 'Unknown' : `${(value / 1000).toFixed(2)} s`
const metric = (name, value, large = false) => `<div${large ? ' class="guided-metric-large"' : ''}><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`
const href = (id, path) => `evidence/cross-package/${id}/${escape(path)}`
const names = { impact: 'Package impact analysis', maintenance: 'Catalog consistency repair', migration: 'Five package migration' }

function renderStudy(verified) {
  verified.verify()
  const { study, report, audit, correctnessAudit } = verified, order = ['native', study.candidate, 'competitor']
  const labels = { native: 'Native tools', [study.candidate]: study.label, competitor: 'Serena' }
  const auditFor = id => audit?.runs.find(row => row.id === id)
  const tasks = report.protocol.tasks.map(task => {
    const runs = report.runs.filter(run => run.task === task.id)
    const eligible = report.decision.measurable === true && runs.every(run => run.capture.complete && run.processGroupStopped && run.providerStopped && run.correct === true && auditFor(run.id)?.workflow === 'pass')
    const candidate = runs.filter(run => run.arm === study.candidate)
    const comparison = (control, label) => {
      const controls = runs.filter(run => run.arm === control)
      const percent = read => { const baseline = sum(controls, read), result = sum(candidate, read); return baseline > 0 && result !== null ? `${(Math.abs(result / baseline - 1) * 100).toFixed(2)}% ${result < baseline ? 'lower' : result > baseline ? 'higher' : 'unchanged'}` : 'Unknown' }
      return `<p><strong>Candidate versus ${escape(label)}:</strong> ${percent(run => run.usage.totalTokens)} total tokens; ${percent(charged)} charged time.</p>`
    }
    const cards = order.map(arm => {
      const selected = runs.filter(run => run.arm === arm)
      const passed = selected.filter(run => run.correct === true).length, unknown = selected.filter(run => run.correct === null).length
      const workflow = !audit ? 'Pending review' : selected.map(run => auditFor(run.id).workflow).join(', ')
      const observedFinal = selected.map(run => run.nativeValidation?.checks?.at(-1)?.completePassingCheck === true ? 'Observed' : run.nativeValidation?.checks?.length ? 'Not observed' : task.mode === 'analysis' ? 'Analysis task' : 'Unknown')
      return `<article class="guided-arm-card" data-cross-package-arm="${escape(arm)}"><h4>${escape(labels[arm])}</h4><dl class="guided-metrics">${metric('Total tokens', format(sum(selected, run => run.usage.totalTokens)), true)}${metric('Charged time', time(sum(selected, charged)), true)}${metric(correctnessAudit && study.id === 'development-001' && task.category === 'impact' ? 'Original machine grade, disputed' : 'Independent correctness', `${passed} / ${selected.length}${unknown ? ` (${unknown} unknown)` : ''}`)}${metric('Workflow review', workflow)}${metric('Complete public validation', observedFinal.join(', '))}${metric('Grep calls', format(sum(selected, run => run.capture.complete ? run.counts.grepShellCalls : null)))}${metric('MCP calls', format(sum(selected, run => run.capture.complete ? run.counts.mcpCalls : null)))}</dl>${selected.map(run => `<div class="benchmark-links" data-cross-package-run="${escape(run.id)}"><a href="${href(study.id, `results/runs/${run.id}/public-evidence.json`)}">Actions and independent grade</a><a href="${href(study.id, `results/runs/${run.id}/tool-outputs.json`)}">Returned evidence</a></div>`).join('')}</article>`
    }).join('')
    const lower = ['native', 'competitor'].every(arm => { const controls = runs.filter(run => run.arm === arm); return [run => run.usage.totalTokens, charged].every(read => { const control = sum(controls, read), result = sum(candidate, read); return control !== null && result !== null && result < control }) })
    const threshold = report.protocol.decisionGate.minimumReductionPercent
    const jointThreshold = ['native', 'competitor'].every(arm => {
      const controls = runs.filter(run => run.arm === arm)
      return [run => run.usage.totalTokens, charged].every(read => {
        const control = sum(controls, read), result = sum(candidate, read)
        return control > 0 && result !== null && (1 - result / control) * 100 >= threshold
      })
    })
    const thresholdNote = eligible ? `<p class="cross-package-caveat">${jointThreshold ? 'Both cost thresholds were observed in this development trial.' : 'Did not meet both cost thresholds.'} The requirement is at least ${threshold}% lower total tokens and charged time against each control. Confirmation on unseen tasks is still required.</p>` : ''
    const summary = eligible && study.id === 'impact-002' && lower ? 'Lower measured cost on one development task.' : report.decision.measurable === false ? 'Environment or workflow limits prevent a complete comparison.' : 'Recorded development results.'
    return `<div class="cross-package-task"><h3>${escape(report.protocol.tasks.length === 1 ? study.title : names[task.category] ?? study.title)}</h3><p>${summary} One repetition per condition. ${task.scope?.productionPackages ? `${task.scope.productionPackages} production packages in scope.` : ''}</p>${eligible ? comparison('native', 'Native tools') + comparison('competitor', 'Serena') : ''}${thresholdNote}<div class="guided-arm-cards">${cards}</div></div>`
  }).join('')
  const notes = [
    !audit ? 'Independent workflow review is pending. Correctness alone does not establish compliant tool use.' : null,
    study.id === 'maintenance-001' ? 'Independent repair checks and the agent’s public validation are separate. This environment limited study cannot establish a complete workflow comparison. See the native validation audit for the exact failure and execution boundaries.' : null,
    correctnessAudit && study.id === 'development-001' ? 'The initial impact grader had errors. Original machine grades remain visible and are not a correctness ranking. The separate correctness audit records the evidence and correction.' : null,
    verified.adjudication && !verified.adjudicationCurrent ? 'The retained decision predates the exported workflow audit. Its workflow conclusion is not used here.' : null,
  ].filter(Boolean)
  const links = [['results/report.json', 'Every session'], ['protocol.json', 'Frozen protocol'], ['results/manifest.json', 'Evidence digests']]
  for (const [path, label] of [['workflow-audit.json', 'Workflow review'], ['correctness-audit.json', 'Correctness audit'], ['native-validation-audit.json', 'Native validation audit'], ['adjudicated-result.json', 'Retained decision']]) if (verified.files.has(`results/${path}`)) links.push([`results/${path}`, label])
  return `<article class="cross-package-study" data-cross-package-study="${study.id}">${tasks}${notes.map(note => `<p class="cross-package-caveat">${escape(note)}</p>`).join('')}<div class="benchmark-links">${links.map(([path, label]) => `<a href="${href(study.id, path)}">${label}</a>`).join('')}</div></article>`
}

export function renderCrossPackageBenchmark(studies, animation = '') {
  if (!studies.length) return ''
  for (const study of studies) study.verify()
  const current = studies.filter(value => value.study.id !== 'development-001'), history = studies.filter(value => value.study.id === 'development-001')
  return `<section class="benchmark-section cross-package-benchmark" id="cross-package-benchmark" aria-labelledby="cross-package-title"><div class="wrap"><div class="section-heading"><div><p class="eyebrow">CROSS PACKAGE RESEARCH · DEVELOPMENT ONLY</p><h2 id="cross-package-title">A narrower question.<br /><span>A measured answer.</span></h2></div><p>Can focused package evidence reduce the work of tracing a change across real consumers? These are development trials. A repeatable advantage on unseen tasks has not been established.</p></div><p class="benchmark-scope">Pinned pnpm source, native TypeScript and package tools available in every condition, and independent checks. The impact query is an unpublished prototype. Each provider condition must use its advertised tool for the first relevant investigation, then may choose freely. These trials measure guided use; default autonomous adoption is untested. One repetition cannot establish a general speed or token advantage.</p>${animation}${current.map(renderStudy).join('')}${history.length ? `<details class="benchmark-details"><summary>Initial migration and impact baseline, with its grading audit <span aria-hidden="true">+</span></summary>${history.map(renderStudy).join('')}</details>` : ''}<p class="guided-account-note">Total tokens include cached input and output once. Charged time includes provider preparation and the complete agent session, including failed calls. Common fixture preparation, independent grading and teardown are separate in the raw records. Unknown measurements are never zero.</p><nav class="guided-history" aria-label="Earlier recorded comparisons"><p>Earlier losses and actual replays remain available.</p><a href="#guided-benchmark">Guided source packet comparison</a><a href="#monorepo-benchmark">Optional tool choice comparison</a><a href="#benchmark">Original Typelatch candidate comparison</a></nav></div></section>`
}

export function verifyCrossPackageAnimation(verified, animation, readAsset, rendererBytes) {
  verified.verify()
  const { study, report, files } = verified
  equal(study.id, 'impact-002')
  equal(animation.schemaVersion, 1)
  equal(animation.kind, 'cross-package-development-action-replay')
  const selection = report.protocol.replaySelection
  equal(animation.task, selection.task)
  equal(animation.repeat, selection.repeat)
  equal(animation.arms, selection.arms)
  equal(animation.protocolSha256, report.protocolSha256)
  for (const [key, path] of [
    ['report', 'results/report.json'], ['adjudication', 'results/adjudicated-result.json'],
    ['protocol', 'protocol.json'], ['workflowAudit', 'results/workflow-audit.json'], ['exportManifest', 'results/manifest.json'],
  ]) {
    equal(animation[key].path, href(study.id, path))
    equal(animation[key].sha256, hash(files.get(path)), 'Replay keeps the exact published report and review identities')
  }
  equal(animation.renderer.path, 'scripts/cross-package-gif.py')
  equal(animation.renderer.sha256, hash(rendererBytes), 'Replay renderer identity remains frozen')
  const runs = selection.arms.map(arm => report.runs.find(run => run.task === selection.task && run.repeat === selection.repeat && run.arm === arm))
  assert(runs.every(Boolean))
  equal(animation.runs.map(run => run.id), runs.map(run => run.id), 'Replay never substitutes another pair')
  for (const [index, binding] of animation.runs.entries()) {
    const run = runs[index], record = parse(files.get(`results/runs/${run.id}/public-evidence.json`))
    equal(binding.evidence, href(study.id, `results/runs/${run.id}/public-evidence.json`))
    equal(binding.toolOutputs, href(study.id, `results/runs/${run.id}/tool-outputs.json`))
    equal(binding.evidenceSha256, run.evidenceSha256)
    equal(binding.toolOutputsSha256, run.toolOutputsSha256)
    equal(animation.playback.renderedActionIds[run.id], record.actions.map(action => action.idSha256), 'Every recorded public action remains in the replay')
    assert(record.actions.every(action => finite(action.completedMs)))
  }
  const times = [...new Set([0, Math.max(...runs.map(run => run.elapsedMs)), ...runs.flatMap(run => parse(files.get(`results/runs/${run.id}/public-evidence.json`)).actions.map(action => action.completedMs))])].sort((a, b) => a - b)
  equal(animation.playback.eventTimes, times, 'Replay uses only observed completion times')
  equal(animation.playback.durationMs, 32000)
  equal(animation.playback.durationSeconds, 32)
  equal(animation.playback.accelerated, true)
  equal(animation.playback.separateSessionsAlignedAtStart, true)
  for (const [name, extension] of [['gif', 'gif'], ['poster', 'png']]) {
    const asset = animation.assets[name]
    equal(asset.path, `assets/codex-impact-development.${extension}`)
    equal(asset.width, 1080); equal(asset.height, 680)
    const bytes = readAsset(asset.path)
    equal(hash(bytes), asset.sha256); equal(bytes.length, asset.bytes)
    assert(bytes.length <= 1_000_000)
    assert(name === 'gif' ? bytes.subarray(0, 3).toString() === 'GIF' : bytes.subarray(1, 4).toString() === 'PNG')
  }
  return animation
}

export function renderCrossPackageAnimation(animation) {
  const { poster, gif } = animation.assets
  return `<figure class="benchmark-replay"><picture><source media="(prefers-reduced-motion: reduce)" srcset="${escape(poster.path)}" /><img id="impact-comparison-replay" data-impact-comparison-image data-gif="${escape(gif.path)}" data-poster="${escape(poster.path)}" src="${escape(poster.path)}" width="${poster.width}" height="${poster.height}" loading="lazy" alt="Recorded Codex actions from the preselected native and experimental package impact sessions, followed by their measured time, token counts, correctness and workflow review." /></picture><div class="benchmark-replay-controls"><button type="button" data-impact-comparison-play aria-controls="impact-comparison-replay" aria-pressed="false" hidden>Play recorded comparison</button><a href="${escape(gif.path)}">Open GIF</a><a href="${escape(animation.runs[0].evidence)}">Native actions</a><a href="${escape(animation.runs[1].evidence)}">Prototype actions</a><a href="evidence/impact-animation.json">Replay evidence</a></div><figcaption>Recorded public Codex actions. Experimental impact query, one development task. Separate sessions aligned at the start; playback accelerated. Final measured totals only. A repeatable advantage on unseen tasks has not been established.</figcaption></figure>`
}
