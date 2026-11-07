import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const confirmationEvaluatorDigests = Object.freeze({
  'decision.mjs': '4a5516b7742afafe5ab14f15607ec2e86710625157f7e0af288824a2824e3142',
  'review.mjs': 'c2b48a629796ca45bf0a4a17c5332d8864d55413728c7d78912ecf9e7e30fe0a',
  'codegraph-challenge.mjs': '3b0958c7127daa2ed9cc73d5377b866f1a8e20374baf7bb0824945d351f6b501',
})

export const confirmationProtocols = Object.freeze({
  'confirmation-001': Object.freeze({
    id: 'confirmation-001',
    publicProtocolSha256: '549b16b76d396e4a633b3ae5308443d17b6134ba470e89ca7d494e9f574695be',
    privateProtocolSha256: '24d3eaed5f4c197c949ea2631c27e86c7b99feb7e6d69d8d8aa9dbdbfef5c1dc',
    eligibleForOutcomes: false,
    failureFiles: ['failure-manifest.json', 'preparation-failure.json', 'preparation-report.json'],
  }),
  'confirmation-002': Object.freeze({
    id: 'confirmation-002',
    publicProtocolSha256: '2464bdb2404b1247d4aeea9aecec5b24e9b8702fffd709cda00eb3afb8262e8c',
    privateProtocolSha256: 'cb597d1d19d5f813ce8327f74b34bdfa74cbea42e6cfa24e363b355e31b1ea63',
    eligibleForOutcomes: true,
    amendment: 'preparation-amendment.json',
  }),
})
export const impactConfirmation = Object.freeze({
  ...confirmationProtocols['confirmation-002'],
  privateReportSha256: '9fd41ac1513350eed0977df17cec9f40066d4ba01f15785b36925a7b7628b7ce',
  occurrenceAssessmentSha256: '11772608865210b5fc2f1651ef9432a365da45abddf4b1c572888cf2b1064611',
  scope: 'Two change impact analyses in the same Vue snapshot, repeated twice in each condition. This tests guided use of the frozen experimental impact query.',
  limitation: 'Any qualifying result applies to these tasks, repository snapshot, model and workflow. It does not establish a general advantage across repositories or default autonomous adoption.',
})


// The legacy evaluator treats CodeGraph as a candidate. The public comparison treats it as a control.
export const confirmationConditions = Object.freeze([
  Object.freeze({ id: 'native', label: 'Native tools', role: 'control' }),
  Object.freeze({ id: 'impact', label: 'Experimental impact query', role: 'candidate' }),
  Object.freeze({ id: 'competitor', label: 'Serena', role: 'control' }),
  Object.freeze({ id: 'codegraph', label: 'CodeGraph', role: 'control' }),
])

export function verifyConfirmationProtocol(protocolBytes, freezeBytes, id = impactConfirmation.id) {
  const known = confirmationProtocols[id]
  assert(known, 'Unknown confirmation protocol')
  const protocol = JSON.parse(protocolBytes), freeze = JSON.parse(freezeBytes)
  const digest = createHash('sha256').update(protocolBytes).digest('hex')
  assert.equal(digest, known.publicProtocolSha256)
  assert.equal(freeze.publicProtocolSha256, digest)
  assert.equal(freeze.privateProtocolSha256, known.privateProtocolSha256)
  assert.equal(protocol.phase, 'confirmation')
  assert.equal(protocol.repeats, 2)
  assert.equal(protocol.runCount, 16)
  assert.deepEqual(protocol.arms, confirmationConditions.map(condition => condition.id))
  assert.equal(protocol.tasks.length, 2)
  assert(protocol.tasks.every(task => task.split === 'heldout' && task.category === 'impact' && task.mode === 'analysis'))
  assert.equal(protocol.schedule.length, 16)
  assert.equal(new Set(protocol.schedule.map(run => run.id)).size, 16)
  for (const task of protocol.tasks) for (const repeat of [1, 2]) for (const arm of protocol.arms) {
    assert.equal(protocol.schedule.filter(run => run.task === task.id && run.repeat === repeat && run.arm === arm).length, 1)
  }
  assert.equal(protocol.replaySelection.task, protocol.tasks[0].id)
  assert.equal(protocol.replaySelection.repeat, 1)
  assert.deepEqual(protocol.replaySelection.arms, ['native', 'impact'])
  return protocol
}

const hash = value => createHash('sha256').update(value).digest('hex')
const parse = bytes => JSON.parse(bytes.toString())
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const safePath = value => typeof value === 'string' && /^[a-zA-Z0-9._/-]+$/u.test(value) && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..')
const escape = value => String(value).replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const equal = (a, b, message) => assert.deepEqual(a, b, message)
const dataModule = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

async function loadEvaluators(files, protocol) {
  const source = {}
  for (const [name, expected] of Object.entries(confirmationEvaluatorDigests)) {
    const bytes = files.get(`results/evaluator/${name}`)
    assert(bytes, `Frozen evaluator is included: ${name}`)
    equal(hash(bytes), expected, 'Only the original frozen gate is executed')
    assert(protocol.inputs.some(input => input.kind === 'file' && input.path.endsWith(`/trial/${name}`) && input.sha256 === expected))
    source[name] = bytes.toString()
  }
  const decision = dataModule(source['decision.mjs'])
  const review = dataModule(source['review.mjs'].replace("'./decision.mjs'", JSON.stringify(decision)))
  const challenge = dataModule(source['codegraph-challenge.mjs'].replace("'./review.mjs'", JSON.stringify(review)))
  return { decision: await import(decision), review: await import(review), challenge: await import(challenge) }
}

function verifyCopy(run, preparation, load, entry, protocol) {
  const path = `runs/${run.id}/fixture-copy.json`, copy = load(path), expected = protocol.spec.fixtureCopy
  equal(run.fixtureCopy, preparation.fixtureCopy)
  equal(run.fixtureCopy.receipt, 'fixture-copy.json')
  equal(run.fixtureCopy.sha256, entry(path).originalSha256, 'The normalized receipt retains its original identity')
  equal(copy.helperSha256, expected.helperSha256)
  equal(run.fixtureCopy.helperSha256, expected.helperSha256)
  equal(copy.python, expected.python)
  equal(run.fixtureCopy.pythonSha256, expected.python.sha256)
  equal(copy.exitCode, 0)
  for (const key of ['signal', 'error', 'parseError']) equal(copy[key], null)
  equal(copy.native, JSON.parse(copy.stdout))
  equal(copy.native.mechanism, 'macOS clonefile(2) per file and symlink, CLONE_NOFOLLOW=1, no copy fallback')
  for (const key of ['source', 'destination']) equal(copy[key], copy.native[key])
  for (const key of ['clonedFiles', 'clonedSymlinks']) {
    assert(Number.isSafeInteger(copy.native[key]) && copy.native[key] >= 0)
    equal(run.fixtureCopy[key], copy.native[key])
  }
  equal(run.fixtureCopy.excludedGit, copy.native.excludedGit)
  equal(run.fixtureCopy.elapsedMs, copy.elapsedMs)
  assert(finite(copy.elapsedMs) && finite(copy.native.elapsedMs))
  const git = load(`runs/${run.id}/fixture-git.json`)
  assert(/^[a-f0-9]{40}$/u.test(git.head))
  assert(Number.isSafeInteger(git.trackedFiles) && git.trackedFiles > 0)
  equal(git.root, copy.destination)
  assert(Array.isArray(load(`runs/${run.id}/preparation.json`)))
  equal(load(`runs/${run.id}/cleanup.json`).stopped, run.providerStopped)
}

function verifyOccurrenceAssessment(assessment, report, records, manifest, entry) {
  equal(assessment.schemaVersion, 1)
  equal(assessment.reportSha256, manifest.privateReportSha256)
  equal(assessment.protocolSha256, report.protocolSha256)
  equal(assessment.originalGradesUnchanged, true)
  equal(assessment.originalDecisionsUnchanged, true)
  equal(assessment.noPrivateReasoningOrMessages, true)
  equal(assessment.runs.length, report.runs.length)
  equal(new Set(assessment.runs.map(row => row.id)), new Set(report.runs.map(run => run.id)))
  for (const row of assessment.runs) {
    const run = report.runs.find(run => run.id === row.id), record = records.get(row.id)
    equal(row.evidenceSha256, run.evidenceSha256)
    equal(row.toolOutputsSha256, run.toolOutputsSha256)
    const answer = record.taskArtifacts.find(artifact => artifact.path === 'impact-answer.json')
    assert(answer, 'The occurrence audit binds the actual submitted answer')
    equal(row.answerSha256, answer.sha256)
    equal(row.originalCorrect, run.correct)
    const { integrity, answerPresent, fixtureGitUnchanged, ...originalGrade } = record.grading
    equal(row.assessment.originalGrade, originalGrade)
    assert(typeof row.assessedCorrect === 'boolean')
    equal(row.assessedCorrect, row.assessment.assessedCorrect)
    equal(row.changedByErratum, row.assessment.changedByErratum)
    equal(row.changedByErratum, row.originalCorrect !== row.assessedCorrect)
    if (row.changedByErratum) {
      equal(row.originalCorrect, false)
      equal(row.assessedCorrect, true)
      equal(row.classification, 'distinct-occurrence-collision-only')
      equal(row.assessment.integrityPassed, true)
      equal(row.assessment.otherFrozenChecksPass, true)
      assert(row.assessment.groups.length > 0)
      for (const group of row.assessment.groups) {
        equal(group.state, 'distinct-occurrences')
        assert(group.proof.length > 1)
        for (const proof of group.proof) {
          equal(proof.state, 'unique-occurrence')
          assert(digest(proof.sourceSha256))
          assert(proof.quoteStart <= proof.start && proof.start < proof.end && proof.end <= proof.quoteEnd)
        }
        const ranges = group.proof.toSorted((a, b) => a.start - b.start)
        for (let i = 1; i < ranges.length; i++) assert(ranges[i - 1].end <= ranges[i].start, 'Repeated occurrences cannot be exonerated')
      }
    } else equal(row.classification, row.assessedCorrect ? 'strict-pass-confirmed' : 'substantive-error-retained')
  }
  equal(assessment.summary, {
    answers: report.runs.length,
    originalStrictPass: report.runs.filter(run => run.correct === true).length,
    assessedPass: assessment.runs.filter(row => row.assessedCorrect).length,
    occurrenceOnlyExonerations: assessment.runs.filter(row => row.changedByErratum).length,
    substantiveFailuresRetained: assessment.runs.filter(row => !row.assessedCorrect).length,
  })
  for (const original of assessment.preservedOriginals) {
    const path = original.path === 'report-private.json' ? 'report.json' : original.path
    equal(original.sha256, path === 'protocol.json' ? report.protocolSha256 : entry(path).originalSha256)
  }
  for (const source of assessment.frozenBindings) assert(report.protocol.inputs.some(input => input.path.endsWith(`/cross-package/${source.path}`) && input.sha256 === source.sha256))
  for (const source of assessment.implementation) assert(safePath(source.path) && digest(source.sha256))
}

export async function verifyConfirmationEvidence(read) {
  const protocolBytes = read('protocol.json'), freezeBytes = read('freeze.json')
  const protocol = verifyConfirmationProtocol(protocolBytes, freezeBytes)
  const amendment = read(impactConfirmation.amendment)
  const manifestBytes = read('results/manifest.json'), manifest = parse(manifestBytes)
  equal(manifest.schemaVersion, 1)
  equal(manifest.originalResultsUnchanged, true)
  equal(manifest.privateProtocolSha256, impactConfirmation.privateProtocolSha256)
  equal(manifest.privateReportSha256, impactConfirmation.privateReportSha256, 'The completed study identity is fixed')
  const files = new Map([['protocol.json', protocolBytes], ['freeze.json', freezeBytes], [impactConfirmation.amendment, amendment], ['results/manifest.json', manifestBytes]])
  const entries = new Map()
  for (const file of manifest.files) {
    assert(safePath(file.path))
    assert(!entries.has(file.path), 'Evidence paths are unique')
    const bytes = read(`results/${file.path}`)
    equal(hash(bytes), file.sha256, `Evidence digest matches: ${file.path}`)
    equal(bytes.length, file.bytes)
    assert(digest(file.originalSha256))
    entries.set(file.path, file)
    files.set(`results/${file.path}`, bytes)
  }
  const entry = path => { assert(entries.has(path), `Manifest includes ${path}`); return entries.get(path) }
  const load = path => { entry(path); return parse(files.get(`results/${path}`)) }
  const report = load('report.json')
  equal(entry('report.json').originalSha256, manifest.privateReportSha256)
  equal(report.schemaVersion, 1)
  equal(report.complete, true)
  equal(report.protocol, protocol)
  equal(report.protocolSha256, impactConfirmation.privateProtocolSha256)
  equal(report.runs.map(({ id, task, repeat, arm }) => ({ id, task, repeat, arm })), protocol.schedule)
  equal(report.preparationAttempts.length, report.runs.length)
  const { verifyRecord, verifyOutputs } = await import('./site-cross-package.mjs')
  const { verifyAgentRun } = await import('./site-monorepo-benchmark.mjs')
  const records = new Map(), recordBytes = new Map(), outputsBytes = new Map(), fixtures = new Map()
  for (const [index, run] of report.runs.entries()) {
    const prompt = protocol.prompts.find(prompt => prompt.task === run.task && prompt.arm === run.arm)
    assert(prompt)
    equal(hash(prompt.prompt), prompt.promptSha256)
    verifyAgentRun(run, prompt)
    const preparation = report.preparationAttempts[index]
    for (const key of ['id', 'task', 'repeat', 'arm', 'providerSetupMs']) equal(preparation[key], run[key])
    equal(preparation.status, 'ready')
    if (fixtures.has(run.task)) equal(run.fixtureSha256, fixtures.get(run.task), 'All conditions start with identical source and dependency bytes')
    else fixtures.set(run.task, run.fixtureSha256)
    const recordPath = `runs/${run.id}/public-evidence.json`, outputsPath = `runs/${run.id}/tool-outputs.json`
    equal(entry(recordPath).sha256, run.evidenceSha256)
    equal(entry(recordPath).originalSha256, run.evidenceSha256)
    equal(entry(outputsPath).sha256, run.toolOutputsSha256)
    equal(entry(outputsPath).originalSha256, run.toolOutputsSha256)
    const record = load(recordPath)
    verifyRecord(record, run, prompt, protocol.config)
    verifyOutputs(load(outputsPath), run, record)
    verifyCopy(run, preparation, load, entry, protocol)
    records.set(run.id, record)
    recordBytes.set(run.id, files.get(`results/${recordPath}`))
    outputsBytes.set(run.id, files.get(`results/${outputsPath}`))
  }
  const audit = load('workflow-audit.json'), adjudication = load('adjudicated-result.json'), challenge = load('codegraph-challenge.json')
  equal(hash(JSON.stringify(audit)), manifest.publicParsedAuditSha256)
  assert(digest(manifest.originalParsedAuditSha256))
  for (const value of [audit, adjudication, challenge]) {
    equal(value.reportSha256, manifest.privateReportSha256)
    equal(value.protocolSha256, report.protocolSha256)
  }
  for (const value of [adjudication, challenge]) equal(value.auditSha256, manifest.originalParsedAuditSha256)
  const evaluators = await loadEvaluators(files, protocol)
  equal(report.decision, evaluators.decision.evaluateDecision(report), 'Original automatic decision is preserved')
  // Rebind only exported identity fields. Costs, grades, prompts and judgments remain unchanged.
  const publicReport = { ...report, protocolSha256: hash(protocolBytes) }
  const publicReportBytes = Buffer.from(JSON.stringify(publicReport))
  const publicAudit = { ...audit, reportSha256: hash(publicReportBytes), protocolSha256: publicReport.protocolSha256 }
  const reviewed = evaluators.review.adjudicate({ reportBytes: publicReportBytes, protocolBytes, audit: publicAudit, records: recordBytes, outputs: outputsBytes })
  for (const field of ['rules', 'decision', 'review']) equal(adjudication[field], reviewed[field], 'Public evidence reproduces the frozen review gate')
  const policy = load('codegraph-challenge-policy.json')
  equal(policy, evaluators.challenge.challengePolicy)
  equal(challenge.policySha256, entry('codegraph-challenge-policy.json').sha256)
  assert(protocol.inputs.some(input => input.path.endsWith('/codegraph-challenge-policy.json') && input.sha256 === challenge.policySha256))
  const comparison = evaluators.challenge.compareCodegraph(report, reviewed)
  for (const [key, value] of Object.entries(comparison)) equal(challenge[key], value, 'Every measured control participates in the final gate')
  const assessment = load('occurrence-assessment-v1.json')
  equal(entry('occurrence-assessment-v1.json').sha256, impactConfirmation.occurrenceAssessmentSha256, 'The independent occurrence assessment is the reviewed final source')
  verifyOccurrenceAssessment(assessment, report, records, manifest, entry)
  const seal = hash(JSON.stringify({ report, audit, adjudication, challenge, assessment }))
  return { report, audit, adjudication, challenge, assessment, files, records,
    verify() { equal(hash(JSON.stringify({ report, audit, adjudication, challenge, assessment })), seal, 'Displayed results remain identical to verified evidence') },
  }
}

export function verifyConfirmationPreparationFailure(read) {
  const protocolBytes = read('protocol.json'), freezeBytes = read('freeze.json')
  verifyConfirmationProtocol(protocolBytes, freezeBytes, 'confirmation-001')
  const manifestBytes = read('failure-manifest.json'), manifest = parse(manifestBytes)
  equal(manifest.status, 'retained-failed-preparation')
  equal(manifest.completedModelSessions, 0)
  const files = new Map([['failure-manifest.json', manifestBytes]])
  for (const item of manifest.files) {
    assert(safePath(item.path) && !files.has(item.path))
    const bytes = read(item.path)
    equal(hash(bytes), item.sha256)
    equal(bytes.length, item.bytes)
    files.set(item.path, bytes)
  }
  for (const path of ['protocol.json', 'freeze.json', 'preparation-report.json', 'preparation-failure.json']) assert(files.has(path))
  equal(parse(files.get('preparation-report.json')).runs.length, 0)
  return { files }
}

const sum = (runs, read) => { const values = runs.map(read); return values.every(finite) ? values.reduce((a, b) => a + b, 0) : null }
const charged = run => finite(run.providerSetupMs) && finite(run.elapsedMs) ? run.providerSetupMs + run.elapsedMs : null
const format = value => value === null ? 'Unknown' : new Intl.NumberFormat('en-US').format(value)
const time = value => value === null ? 'Unknown' : `${(value / 1000).toFixed(2)} s`
const change = (control, candidate) => control > 0 && candidate !== null ? `${(Math.abs(candidate / control - 1) * 100).toFixed(2)}% ${candidate < control ? 'lower' : candidate > control ? 'higher' : 'unchanged'}` : 'Unknown'
const href = path => `evidence/cross-package/${impactConfirmation.id}/${path}`
const metric = (name, value, large = false) => `<div${large ? ' class="guided-metric-large"' : ''}><dt>${escape(name)}</dt><dd>${escape(value)}</dd></div>`

export function renderConfirmationBenchmark(verified, animation = '') {
  verified.verify()
  const { report, audit, assessment, challenge } = verified
  const selected = arm => report.runs.filter(run => run.arm === arm)
  const candidate = selected('impact'), native = selected('native')
  const cost = (runs, read) => sum(runs, read)
  const tokenChange = change(cost(native, run => run.usage.totalTokens), cost(candidate, run => run.usage.totalTokens))
  const timeChange = change(cost(native, charged), cost(candidate, charged))
  const passed = challenge.qualifiedAcrossMeasuredControls
  const cards = confirmationConditions.map(condition => {
    const runs = selected(condition.id), reviews = runs.map(run => audit.runs.find(row => row.id === run.id))
    const strict = runs.filter(run => run.correct === true).length
    const assessed = runs.filter(run => assessment.runs.find(row => row.id === run.id).assessedCorrect).length
    return `<article class="guided-arm-card" data-confirmation-arm="${condition.id}"><p class="confirmation-role">${condition.role === 'candidate' ? 'UNPUBLISHED PROTOTYPE' : 'CONTROL'}</p><h3>${condition.label}</h3><dl class="guided-metrics">${metric('Total tokens', format(cost(runs, run => run.usage.totalTokens)), true)}${metric('Charged time', time(cost(runs, charged)), true)}${metric('Audited correctness', `${assessed} / ${runs.length}`)}${metric('Original machine grade', `${strict} / ${runs.length}`)}${metric('Workflow reviewed', `${reviews.filter(row => row.workflow === 'pass').length} / ${runs.length} pass`)}${metric('Grep calls', format(cost(runs, run => run.capture.complete ? run.counts.grepShellCalls : null)))}${metric('MCP calls', format(cost(runs, run => run.capture.complete ? run.counts.mcpCalls : null)))}</dl></article>`
  }).join('')
  const pairs = report.protocol.tasks.flatMap((task, index) => [1, 2].map(repeat => {
    const runs = report.runs.filter(run => run.task === task.id && run.repeat === repeat)
    const baseline = runs.find(run => run.arm === 'native'), result = runs.find(run => run.arm === 'impact')
    return `<article class="confirmation-pair"><h4>${index === 0 ? 'Type contract impact' : 'Runtime contract impact'} · repetition ${repeat}</h4><p>Prototype versus native: <strong>${change(baseline.usage.totalTokens, result.usage.totalTokens)} tokens</strong>; <strong>${change(charged(baseline), charged(result))} charged time</strong>.</p><ul>${confirmationConditions.map(condition => { const run = runs.find(run => run.arm === condition.id); return `<li data-confirmation-run="${escape(run.id)}"><strong>${condition.label}</strong><span>${format(run.usage.totalTokens)} tokens · ${time(charged(run))} · ${run.counts.grepShellCalls} grep · ${run.counts.mcpCalls} MCP</span><span>Machine grade: ${run.correct === true ? 'pass' : run.correct === false ? 'fail' : 'unknown'}; audited: ${assessment.runs.find(row => row.id === run.id).assessedCorrect ? 'pass' : 'fail'}</span><a href="${href(`results/runs/${run.id}/public-evidence.json`)}">Actions and grade</a><a href="${href(`results/runs/${run.id}/tool-outputs.json`)}">Returned evidence</a></li>` }).join('')}</ul></article>`
  })).join('')
  const repeats = [1, 2].map(repeat => { const a = native.filter(run => run.repeat === repeat), b = candidate.filter(run => run.repeat === repeat); return `Repetition ${repeat}: ${change(cost(a, run => run.usage.totalTokens), cost(b, run => run.usage.totalTokens))} tokens and ${change(cost(a, charged), cost(b, charged))} charged time.` }).join(' ')
  const links = [['results/report.json', 'All 16 sessions'], ['protocol.json', 'Frozen protocol'], ['results/manifest.json', 'Evidence digests'], ['results/workflow-audit.json', 'Workflow review'], ['results/occurrence-assessment-v1.json', 'Correctness erratum'], ['results/adjudicated-result.json', 'Original reviewed gate'], ['results/codegraph-challenge.json', 'All control gate'], ['preparation-amendment.json', 'Preparation correction']]
  return `<section class="benchmark-section confirmation-benchmark" id="confirmation-benchmark" aria-labelledby="confirmation-title"><div class="wrap"><div class="section-heading"><div><p class="eyebrow">HELD OUT IMPACT ANALYSIS · 16 CODEX SESSIONS</p><h2 id="confirmation-title">${passed ? 'A result within' : 'Lower cost.'}<br /><span>${passed ? 'a narrow scope.' : 'The gate still failed.'}</span></h2></div><p>Against native tools, the experimental impact query used <strong>${tokenChange} total tokens</strong> and <strong>${timeChange} charged time</strong>. ${passed ? 'The frozen comparison qualified within this task scope.' : 'It did not meet the prespecified joint requirement.'}</p></div><p class="confirmation-verdict" data-confirmation-gate="${passed ? 'passed' : 'failed'}">${passed ? 'Qualified within the measured scope.' : 'No qualified advantage.'} The gate requires at least 20% aggregate and median paired savings in both metrics against native tools, Serena and CodeGraph, plus improvement in both repetition totals, correct answers and reviewed workflows.</p><p class="benchmark-scope">${impactConfirmation.scope} The first relevant investigation must use the advertised provider; later choices are free. The prototype is not part of published Typelatch 0.3.0. ${impactConfirmation.limitation}</p><div class="guided-arm-cards confirmation-cards">${cards}</div><p class="cross-package-caveat">${assessment.summary.occurrenceOnlyExonerations} original failures came from a grader defect that treated separate cited occurrences as duplicates. The uniform audit corrects these separately. ${assessment.summary.substantiveFailuresRetained} substantive answer error${assessment.summary.substantiveFailuresRetained === 1 ? '' : 's'} remain${assessment.summary.substantiveFailuresRetained === 1 ? 's' : ''}. Original grades and the failed frozen gate are preserved.</p><p class="confirmation-repeats">${repeats} Every task pair appears below, including losses.</p>${animation}<details class="benchmark-details" open><summary>Every task and repetition <span aria-hidden="true">+</span></summary><div class="confirmation-pairs">${pairs}</div></details><p class="guided-account-note">Tokens include cached input and output once. Charged time includes provider preparation and the full agent session, including failed calls. Common fixture copying, independent grading and cleanup are recorded separately. All sessions remain in the totals.</p><div class="benchmark-links">${links.map(([path, label]) => `<a href="${href(path)}">${label}</a>`).join('')}<a href="https://github.com/eDimka/typelatch/blob/main/docs/research/cross-package/heldout-audit-source/README.md">Source and independent audit receipts</a><a href="evidence/cross-package/confirmation-001/preparation-failure.json">Retained preparation failure before any model session</a></div><nav class="guided-history" aria-label="Earlier results"><p>Earlier development wins, losses and actual replays remain visible.</p><a href="#cross-package-benchmark">Development studies</a><a href="#guided-benchmark">Guided source packet study</a><a href="#benchmark">Original candidate losses</a></nav></div></section>`
}

export function verifyConfirmationAnimation(verified, animation, readAsset, rendererBytes) {
  verified.verify()
  const { report, files, records, challenge, assessment, adjudication } = verified
  const selection = report.protocol.replaySelection
  equal(animation.schemaVersion, 1)
  equal(animation.kind, 'cross-package-confirmation-action-replay')
  equal(animation.task, selection.task); equal(animation.repeat, selection.repeat); equal(animation.arms, selection.arms)
  equal(animation.protocolSha256, report.protocolSha256)
  for (const [key, path] of [
    ['report', 'results/report.json'], ['adjudication', 'results/adjudicated-result.json'], ['protocol', 'protocol.json'],
    ['workflowAudit', 'results/workflow-audit.json'], ['exportManifest', 'results/manifest.json'],
    ['codegraphChallenge', 'results/codegraph-challenge.json'], ['codegraphChallengePolicy', 'results/codegraph-challenge-policy.json'],
    ['occurrenceAssessment', 'results/occurrence-assessment-v1.json'], ['controlAudit', 'results/control-audit.json'],
  ]) {
    equal(animation[key].path, href(path))
    equal(animation[key].sha256, hash(files.get(path)), 'The replay binds the complete reviewed study')
  }
  equal(animation.renderer.path, 'scripts/cross-package-confirmation-gif.py')
  equal(animation.renderer.sha256, hash(rendererBytes))
  const runs = selection.arms.map(arm => report.runs.find(run => run.task === selection.task && run.repeat === selection.repeat && run.arm === arm))
  assert(runs.every(Boolean))
  equal(animation.runs.map(run => run.id), runs.map(run => run.id), 'The positive first pair cannot be substituted after outcomes')
  for (const [index, binding] of animation.runs.entries()) {
    const run = runs[index], record = records.get(run.id)
    equal(binding.evidence, href(`results/runs/${run.id}/public-evidence.json`))
    equal(binding.toolOutputs, href(`results/runs/${run.id}/tool-outputs.json`))
    equal(binding.evidenceSha256, run.evidenceSha256); equal(binding.toolOutputsSha256, run.toolOutputsSha256)
    equal(animation.playback.renderedActionIds[run.id], record.actions.map(action => action.idSha256))
    assert(record.actions.every(action => finite(action.completedMs)))
  }
  const times = [...new Set([0, Math.max(...runs.map(run => run.elapsedMs)), ...runs.flatMap(run => records.get(run.id).actions.map(action => action.completedMs))])].sort((a, b) => a - b)
  equal(animation.playback.eventTimes, times)
  equal(animation.playback.durationMs, 32000); equal(animation.playback.durationSeconds, 32)
  equal(animation.playback.accelerated, true); equal(animation.playback.separateSessionsAlignedAtStart, true)
  const full = animation.fullStudy
  equal(full.sessionCount, report.runs.length); equal(full.taskCount, report.protocol.tasks.length); equal(full.repeats, report.protocol.repeats)
  equal(full.qualifiedEdge, challenge.qualifiedAcrossMeasuredControls, 'A selected pair does not replace the failed full study gate')
  equal(full.minimumReductionPercent, report.protocol.decisionGate.minimumReductionPercent)
  equal(Object.keys(full.arms), confirmationConditions.map(condition => condition.id))
  for (const condition of confirmationConditions) {
    const selected = report.runs.filter(run => run.arm === condition.id)
    equal(full.arms[condition.id], { sessions: selected.length, totalTokens: sum(selected, run => run.usage.totalTokens), chargedTimeMs: sum(selected, charged), originalStrictPass: selected.filter(run => run.correct === true).length })
  }
  for (const control of ['native', 'competitor', 'codegraph']) {
    const a = full.arms[control], b = full.arms.impact
    equal(full.comparisons[control], { totalTokenReductionPercent: 100 * (1 - b.totalTokens / a.totalTokens), chargedTimeReductionPercent: 100 * (1 - b.chargedTimeMs / a.chargedTimeMs) })
  }
  const nativeTokens = adjudication.decision.candidates.impact.categories.impact.comparisons.native.metrics.totalTokens
  const paired = nativeTokens.pairs.map(pair => 100 * (1 - pair.candidate / pair.control)).toSorted((a, b) => a - b)
  const median = (paired[1] + paired[2]) / 2
  equal(full.nativeTokenGate, { aggregateReductionPercent: full.comparisons.native.totalTokenReductionPercent, medianPairedReductionPercent: median, passed: nativeTokens.aggregateReductionPercent >= full.minimumReductionPercent && nativeTokens.medianPairedReductionPercent >= full.minimumReductionPercent })
  equal(full.originalStrictPass, assessment.summary.originalStrictPass); equal(full.occurrenceAssessedPass, assessment.summary.assessedPass)
  for (const [name, extension] of [['gif', 'gif'], ['poster', 'png']]) {
    const asset = animation.assets[name]
    equal(asset.path, `assets/cross-package-confirmation.${extension}`)
    equal(asset.width, 1080); equal(asset.height, 680)
    const bytes = readAsset(asset.path)
    equal(hash(bytes), asset.sha256); equal(bytes.length, asset.bytes)
    assert(bytes.length <= 1_000_000)
    assert(name === 'gif' ? bytes.subarray(0, 3).toString() === 'GIF' : bytes.subarray(1, 4).toString() === 'PNG')
  }
  return animation
}

export function renderConfirmationAnimation(animation) {
  const { poster, gif } = animation.assets
  return `<figure class="benchmark-replay"><picture><source media="(prefers-reduced-motion: reduce)" srcset="${escape(poster.path)}" /><img id="confirmation-comparison-replay" data-confirmation-comparison-image data-gif="${escape(gif.path)}" data-poster="${escape(poster.path)}" src="${escape(poster.path)}" width="${poster.width}" height="${poster.height}" loading="lazy" alt="Actual public Codex actions from the preselected first native and experimental impact sessions. The overall failed confirmation gate stays visible throughout this selected pair replay." /></picture><div class="benchmark-replay-controls"><button type="button" data-confirmation-comparison-play aria-controls="confirmation-comparison-replay" aria-pressed="false" hidden>Play recorded comparison</button><a href="${escape(gif.path)}">Open GIF</a><a href="${escape(animation.runs[0].evidence)}">Native actions</a><a href="${escape(animation.runs[1].evidence)}">Prototype actions</a><a href="evidence/cross-package-confirmation-animation.json">Replay evidence</a></div><figcaption><strong>The overall 16 session gate failed.</strong> This is the first task and repetition, selected before outcomes, not the aggregate result. Actual public Codex action replay of the experimental impact query. Separate sessions aligned at the start; playback accelerated. Only final measured token totals are shown.</figcaption></figure>`
}
