import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { classifySearchCommand } from './paired-agent-evidence.mjs'
import { frozenMonorepoDecisionSha256, monorepoArmOrder, renderMonorepoBenchmark, verifyMonorepoEvidence } from './site-monorepo-benchmark.mjs'

const root = resolve(import.meta.dirname, '..')
const publicDecision = resolve(root, 'docs/benchmarks/monorepo-agent-study/decision.mjs')
const decisionBytes = readFileSync(existsSync(publicDecision) ? publicDecision : resolve(root, 'artifacts/research/large-monorepo/agent-trial/decision.mjs'))
const gate = await import(`data:text/javascript;base64,${decisionBytes.toString('base64')}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')

function fixture({ changeRun = () => {}, changeRecord = () => {} } = {}) {
  const tasks = ['example-a', 'example-b'].map(id => ({ id, title: id === 'example-a' ? 'Example <A>' : 'Example B', publicCases: 1, prompt: `Inspect and repair ${id}.`, promptSha256: hash(`Inspect and repair ${id}.`) }))
  const protocol = { schemaVersion: 1, tasks, candidates: ['typelatch', 'packet'], repeats: 2, runCount: 16, decisionGate: gate.decisionGate, schedule: gate.makeSchedule(tasks.map(task => task.id), ['typelatch', 'packet']), config: { model: 'test-model', model_reasoning_effort: 'medium' }, inputs: [{ path: '$REPOSITORY/artifacts/research/large-monorepo/agent-trial/decision.mjs', kind: 'file', sha256: frozenMonorepoDecisionSha256 }], spec: { competitorSelection: { name: 'Test control', version: '1.0.0' } }, typelatchArchiveBinding: { version: '0.4.0' } }
  const report = { schemaVersion: 1, complete: true, protocol, protocolSha256: hash('synthetic private protocol fixture'), preparationAttempts: [], runs: [] }
  const files = new Map()
  for (const [index, slot] of protocol.schedule.entries()) {
    const task = tasks.find(task => task.id === slot.task)
    const actions = [false, true].map((passed, i) => ({ type: 'command_execution', idSha256: hash(`${slot.id}:${i}`), status: 'completed', command: 'npm run test:typelatch-benchmark', outputBytes: 10, outputSha256: hash(`check:${passed}`), exitCode: passed ? 0 : 1, search: classifySearchCommand('npm run test:typelatch-benchmark'), startedMs: i * 10, completedMs: i * 10 + 1 }))
    const run = { ...slot, status: 'completed', fixtureSetupMs: 40, providerSetupMs: 10, elapsedMs: 100, teardownMs: 2, gradingMs: 10, exitCode: 0, timedOut: false, processGroupStopped: true, providerStopped: true, correct: true, capture: { complete: true, issues: [], failedTurn: false }, usage: { inputTokens: 1000, cachedInputTokens: 600, uncachedInputTokens: 400, cacheWriteInputTokens: null, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1100 }, counts: { shellCalls: 2, mcpCalls: 0, mcpSucceeded: 0, mcpFailed: 0, fileEdits: 0, grepShellCalls: 0, contentSearchShellCalls: 0, fileListingShellCalls: 0, ambiguousSearchShellCalls: 0 }, fixtureSha256: hash(task.id), preparedSha256: hash(slot.id), promptSha256: task.promptSha256, nativeValidation: { failingThenLaterCheckObserved: true, checks: actions.map((action, i) => ({ actionIdSha256: action.idSha256, outputSha256: action.outputSha256, commandExitCode: action.exitCode, cases: 1, passed: i === 1 })) } }
    changeRun(run, index)
    const record = { schemaVersion: 1, run: structuredClone(run), prompt: task.prompt, actions, requestedConfig: protocol.config, grading: run.correct === null ? null : { passed: run.correct, integrity: { passed: true }, stable: true, fixtureGitUnchanged: true, checks: { exitCode: run.correct ? 0 : 1, result: { passed: run.correct } } } }
    changeRecord(record, index)
    const evidence = `runs/${run.id}.json`, recordBytes = bytes(record)
    files.set(evidence, recordBytes)
    report.runs.push({ ...run, evidence, evidenceSha256: hash(recordBytes) })
    report.preparationAttempts.push({ ...slot, status: 'ready', providerSetupMs: run.providerSetupMs })
  }
  report.decision = gate.evaluateDecision(report)
  const wrapper = { schemaVersion: 1, privateProtocolSha256: report.protocolSha256, protocol }
  files.set('report.json', bytes(report)); files.set('protocol.json', bytes(wrapper)); files.set('decision.mjs', decisionBytes)
  const pilotHash = hash('synthetic pilot protocol fixture')
  files.set('protocol-001.json', bytes({ schemaVersion: 1, privateProtocolSha256: pilotHash, protocol })); files.set('infrastructure-attempt-001.json', bytes({ status: 'ineligible-infrastructure-failure' }))
  files.set('infrastructure-attempt-001/report.json', bytes({ schemaVersion: 1, status: 'ineligible-infrastructure-failure', comparativePerformanceEligible: false, privateProtocolSha256: pilotHash, protocol: '../protocol-001.json', runs: report.runs.slice(0, 5) }))
  for (const run of report.runs.slice(0, 5)) files.set(`infrastructure-attempt-001/${run.evidence}`, files.get(run.evidence))
  const manifest = { schemaVersion: 1, files: [...files].map(([path, value]) => ({ path, sha256: hash(value), bytes: value.length })) }
  return { report, wrapper, files, manifest, verify: () => verifyMonorepoEvidence(files.get('report.json'), files.get('protocol.json'), bytes(manifest), path => { assert(files.has(path), `Missing evidence file: ${path}`); return files.get(path) }) }
}

test('four fixed conditions and every session render with zero optional MCP adoption', async () => {
  const data = fixture(), verified = await data.verify(), html = renderMonorepoBenchmark(verified)
  assert.deepEqual([...html.matchAll(/data-monorepo-arm="([^"]+)"/gu)].map(match => match[1]), monorepoArmOrder)
  assert.equal((html.match(/data-monorepo-run="/gu) ?? []).length, 16)
  assert.match(html, /4,400/)
  assert.match(html, /0\.4 s/)
  assert.match(html, /does not demonstrate a retrieval benefit/)
  assert.match(html, /does not test scaling/)
  assert.match(html, /Example &lt;A&gt;/)
  assert.equal(verified.report.decision.measurable, true)
  assert.equal(verified.report.decision.anyCandidatePassed, false)
})

test('all sixteen results remain publishable when a capture or grade is unknown', async () => {
  const data = fixture({ changeRun: (run, index) => { if (index === 1) { run.status = 'failed'; run.correct = null; run.capture = { complete: false, issues: [{ code: 'missing-usage' }], failedTurn: true }; run.usage = Object.fromEntries(Object.keys(run.usage).map(key => [key, null])); run.exitCode = 1 } } })
  const verified = await data.verify(), html = renderMonorepoBenchmark(verified)
  assert.equal(verified.report.decision.measurable, false)
  assert.equal((html.match(/data-monorepo-run="/gu) ?? []).length, 16)
  assert.match(html, /Comparison ineligible/)
  assert.match(html, /Unknown/)
  assert.match(html, /capture incomplete/)
})

test('missing or changed public records fail closed', async () => {
  const missing = fixture(); missing.files.delete(missing.report.runs[0].evidence)
  await assert.rejects(missing.verify(), /Missing evidence/)
  const changed = fixture(), path = changed.report.runs[0].evidence
  changed.files.set(path, Buffer.concat([changed.files.get(path), Buffer.from(' ')]))
  await assert.rejects(changed.verify(), /artifact digest/)
})

test('an interrupted independent grading stage preserves unknown correctness', async () => {
  const data = fixture({ changeRun: (run, index) => { if (index === 1) { run.status = 'failed'; run.correct = null; run.error = { stage: 'grading', message: 'Fixture integrity check interrupted' } } }, changeRecord: (record, index) => { if (index === 1) record.grading = { passed: true, integrity: { passed: true }, stable: true, checks: { exitCode: 0, result: { passed: true } } } } })
  const verified = await data.verify()
  assert.equal(verified.report.runs[1].correct, null)
  assert.equal(verified.report.decision.measurable, false)
  assert.match(renderMonorepoBenchmark(verified), /Unknown/)
})

test('unknown correctness cannot conceal a finished independent grade', async () => {
  const data = fixture({ changeRun: (run, index) => { if (index === 1) { run.status = 'failed'; run.correct = null; run.error = { stage: 'grading' } } }, changeRecord: (record, index) => { if (index === 1) record.grading = { passed: true, fixtureGitUnchanged: true } } })
  await assert.rejects(data.verify(), /cannot hide a completed grade/)
})

test('retained infrastructure launches cannot disappear or become comparative results', async () => {
  const missing = fixture(); missing.files.delete('infrastructure-attempt-001/' + missing.report.runs[0].evidence)
  await assert.rejects(missing.verify(), /Missing evidence/)
  const eligible = fixture(), path = 'infrastructure-attempt-001/report.json'
  const pilot = JSON.parse(eligible.files.get(path)); pilot.comparativePerformanceEligible = true
  eligible.files.set(path, bytes(pilot))
  await assert.rejects(eligible.verify(), /never pooled/)
})

test('failed correctness and unconfirmed cleanup stay visible without qualifying the comparison', async () => {
  const data = fixture({ changeRun: (run, index) => { if (index === 1) { run.correct = false; run.providerStopped = false } } })
  const verified = await data.verify(), html = renderMonorepoBenchmark(verified)
  assert.equal(verified.report.decision.measurable, false)
  assert.equal((html.match(/data-monorepo-run="/gu) ?? []).length, 16)
  assert.match(html, /3 \/ 4/)
  assert.match(html, /cleanup unconfirmed/)
  assert.match(html, /Comparison ineligible/)
})

test('a summary cannot invent search calls or a passing grade', async () => {
  await assert.rejects(fixture({ changeRun: (run, index) => { if (index === 0) run.counts.grepShellCalls = 1 } }).verify(), /action counts reconcile/)
  await assert.rejects(fixture({ changeRecord: (record, index) => { if (index === 0) record.grading.passed = false } }).verify(), /independent grade/)
})

test('a changed schedule, incomplete study, or altered decision is rejected', async () => {
  for (const mutate of [report => { report.complete = false }, report => { report.runs.pop() }, report => { report.decision.anyCandidatePassed = true }]) {
    const data = fixture(); mutate(data.report); data.files.set('report.json', bytes(data.report)); const entry = data.manifest.files.find(file => file.path === 'report.json'); entry.sha256 = hash(data.files.get('report.json')); entry.bytes = data.files.get('report.json').length
    await assert.rejects(data.verify())
  }
})

test('the decision implementation is bound independently of a mutable export manifest', async () => {
  const data = fixture(), changed = Buffer.from(decisionBytes.toString() + '\n// altered\n')
  data.files.set('decision.mjs', changed); const entry = data.manifest.files.find(file => file.path === 'decision.mjs'); entry.sha256 = hash(changed); entry.bytes = changed.length
  await assert.rejects(data.verify(), /exact frozen decision/)
})
