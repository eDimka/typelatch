import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform, arch, cpus, totalmem, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { tasks, prepareTask, gradeTask } from './paired-agent-fixtures.mjs'
import { extractPairedEvents, summarizePairedRuns } from './paired-agent-evidence.mjs'
import { normalizeDemo } from './demo-evidence.mjs'
import { hash, pairedConfig, runAgent, writeJson } from './paired-agent-runner.mjs'
import { freezeInputs, verifyFrozenInputs } from './paired-agent-integrity.mjs'
import { comparisonManifest, assertComparableFixtures } from './paired-agent-comparison.mjs'

const root = resolve(import.meta.dirname, '..')
const extra = process.argv.slice(3)
assert(extra.length === 0 || (extra.length === 2 && extra[0] === '--output-directory'), 'Optional argument: --output-directory PATH')
const studyDirectory = extra.length ? resolve(extra[1]) : join(root, 'docs/benchmarks')
mkdirSync(studyDirectory, { recursive: true })
const protocolPath = join(studyDirectory, 'paired-agent-protocol.json')
const reportPath = join(studyDirectory, 'paired-agent.json')
const runtime = join(root, 'artifacts/paired-agent/runtime/node_modules/typelatch')
const frozenPath = join(root, `artifacts/paired-agent/frozen-inputs-${hash(studyDirectory).slice(0, 12)}.json`)
const commonPrompt = '\n\nWork only in this isolated project. Inspect the available source and dependency APIs using whichever available tools you judge useful. Make a minimal fix in existing implementation source files. Do not change tests, dependencies, package files, configuration, or documentation, and do not add files. You may run the existing npm test and npm run build commands. Check the result with the existing tests. Do not access files outside this project, use the network, install packages, make commits, or delegate work. Report the fix and any remaining failures.'

function command(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000, ...options })
  assert.equal(result.status, 0, `${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}
const publicComparison = comparison => ({ rawManifestSha256: comparison.rawManifestSha256, comparisonSha256: comparison.comparisonSha256, normalizations: comparison.normalizations.map(({ aliases, ...row }) => ({ ...row, aliasReplacementCounts: aliases.map(alias => alias.replacements) })) })

function makeProtocol() {
  const schedule = []
  for (let repeat = 1; repeat <= 2; repeat++) {
    for (const [taskIndex, task] of tasks.entries()) {
      const arms = (taskIndex + repeat) % 2 ? ['baseline', 'typelatch'] : ['typelatch', 'baseline']
      for (const arm of arms) schedule.push({ id: `${task.id}-${repeat}-${arm}`, task: task.id, repeat, arm })
    }
  }
  return {
    schemaVersion: 1, frozenAt: new Date().toISOString(), model: pairedConfig.model, reasoningEffort: pairedConfig.model_reasoning_effort,
    repeats: 2, taskCount: tasks.length, runCount: schedule.length, toolPackage: 'typelatch@0.3.0', timeoutMs: 600_000,
    conditions: { baseline: 'Native Codex tools without any MCP server', typelatch: 'The same native tools plus all seven Typelatch MCP tools; use is optional' },
    promptPolicy: 'Identical task prompt in both conditions. No instruction to use Typelatch, avoid grep, or prefer a particular tool.',
    tasks: tasks.map(task => ({ ...task, prompt: task.prompt + commonPrompt, promptSha256: hash(task.prompt + commonPrompt) })),
    schedule, config: pairedConfig,
    timing: 'Sequential sessions on one machine. Monotonic time from spawning Codex to process close, including MCP startup and tool execution. Fixture installation, baseline qualification, Typelatch sync, and independent grading are outside task time and reported separately.',
    preparation: 'Fresh workspace and own installed dependencies each run. Fresh Typelatch home and package indexes prepared with sync only for the Typelatch condition. Source search cache starts cold. Dependency download and OS caches may be warm. Provider prompt caching is not disabled; cached input is reported.',
    correctness: 'Independent grader after the agent exits, using protected fixture checks and trusted tests outside the agent workspace. A self reported success does not count as correctness.',
    selection: 'Three authored, known exercises selected before any scored run: the existing SQLite showcase plus two larger Parcel Desk tasks. Two repeats per condition. Fixed counterbalanced order, no session reuse. No run is removed for a poor result or lack of MCP adoption. No performance tuning after scored runs begin.',
    failurePolicy: 'Every scheduled launch is retained. No automatic replacement or selective rerun. Missing usage is unknown, not zero. Infrastructure preflights contain no benchmark task and are excluded. A run interrupted before metrics complete remains visible.',
    limits: ['A small authored local sample, not an unseen production benchmark or a causal estimate for all coding work.', 'Requested model alias and reasoning setting are pinned; an immutable served model snapshot and sampling seed are not available.', 'Input tokens include cached input and repeated context. Total tokens are input plus output; cached and reasoning tokens are subsets, not extra tokens.', 'Search counts describe recorded native shell tool calls, not every operating system process or every form of text search. MCP calls are reported separately.', 'Workspace instructions and file hashes are integrity controls, not proof of complete operating system isolation.'],
    accountingSource: 'Codex CLI turn.completed usage; https://learn.chatgpt.com/docs/non-interactive-mode',
    animation: 'Replay the first SQLite pair, selected before scoring, regardless of outcome. Show actual public actions at recorded JSONL receipt times. Separate sessions align at their start and playback is accelerated. This is a rendered action replay, not a screen recording.',
  }
}

if (process.argv[2] === '--freeze') {
  assert(!existsSync(protocolPath), 'Do not overwrite a frozen protocol')
  const frozen = freezeInputs(root, runtime)
  writeJson(frozenPath, frozen)
  writeJson(protocolPath, { ...makeProtocol(), frozenInputsDigest: frozen.digest })
  console.log('Frozen paired benchmark protocol without running tasks')
} else {
  const resuming = process.argv[2] === '--resume'
  assert(resuming || process.argv[2] === '--run', 'Usage: node scripts/paired-agent.mjs --freeze|--run|--resume')
  assert(existsSync(protocolPath) && (resuming ? existsSync(reportPath) : !existsSync(reportPath)), 'Freeze first; use explicit resume to retain a partial study')
  const protocolBytes = readFileSync(protocolPath), protocol = JSON.parse(protocolBytes)
  const frozen = JSON.parse(readFileSync(frozenPath))
  assert.equal(frozen.digest, protocol.frozenInputsDigest)
  verifyFrozenInputs(frozen)
  assert.deepEqual(protocol.config, pairedConfig, 'Runner settings must match the frozen protocol')
  assert.equal(JSON.parse(readFileSync(join(runtime, 'package.json'))).version, '0.3.0')
  const cliVersion = command('codex', ['--version'])
  const packageMetadata = JSON.parse(command('npm', ['view', 'typelatch@0.3.0', 'dist', '--json']))
  const packageManifestSha256 = hash(readFileSync(join(runtime, 'package.json')))
  const sourceCommit = command('git', ['rev-parse', 'HEAD'], { cwd: root })
  const prior = resuming ? JSON.parse(readFileSync(reportPath)) : null
  if (prior) {
    assert(!prior.complete, 'A completed study cannot resume')
    assert.deepEqual(prior.protocol.tasks, protocol.tasks, 'Resume cannot change tasks or prompts')
    assert.deepEqual(prior.protocol.schedule, protocol.schedule, 'Resume cannot change the run order')
    assert.deepEqual(prior.protocol.config, protocol.config, 'Resume cannot change agent settings')
    assert(prior.runs.every((run, index) => run.id === protocol.schedule[index].id && run.status !== 'running'), 'Resume requires a completed prefix, not a replacement run')
    assert.equal(prior.cliVersion, cliVersion)
    assert.deepEqual(prior.package.dist, packageMetadata)
  }
  const captureRoot = mkdtempSync(join(root, 'artifacts/paired-agent/scored-'))
  const publicDirectory = join(studyDirectory, 'paired-agent-runs'); mkdirSync(publicDirectory, { recursive: true })
  const harnessFiles = ['scripts/paired-agent.mjs', 'scripts/paired-agent-runner.mjs', 'scripts/paired-agent-evidence.mjs', 'scripts/paired-agent-fixtures.mjs', 'scripts/paired-agent-integrity.mjs', 'scripts/paired-agent-comparison.mjs']
  const harness = harnessFiles.map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }))
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), capturedAt: null, protocol, protocolSha256: hash(protocolBytes), sourceCommit, cliVersion, package: { identity: 'typelatch@0.3.0', manifestSha256: packageManifestSha256, dist: packageMetadata }, machine: { platform: platform(), architecture: arch(), nodeVersion: process.version, processor: cpus()[0]?.model, logicalProcessors: cpus().length, memoryBytes: totalmem() }, harness, frozenInputs: { digest: frozen.digest, manifests: frozen.manifests.map(({name,sha256,entries}) => ({name,sha256,entries:entries.length})), files: frozen.files.map(({name,sha256,bytes})=>({name,sha256,bytes})) }, tasks: protocol.tasks.map(({ id, title }) => ({ id, title })), runs: [], summary: summarizePairedRuns([]), complete: false }
  report.fixtureComparisons = {}
  const comparisons = new Map()
  if (prior) {
    report.startedAt = prior.startedAt
    report.runs = prior.runs
    report.captureRevisions = [...(prior.captureRevisions ?? [{ sourceCommit: prior.sourceCommit, protocolSha256: prior.protocolSha256, frozenInputs: prior.frozenInputs, runIds: prior.runs.map(run => run.id) }]), { sourceCommit, protocolSha256: report.protocolSha256, frozenInputs: report.frozenInputs, runIds: protocol.schedule.slice(prior.runs.length).map(run => run.id) }]
    for (const run of prior.runs) {
      const candidates = readdirSync(join(root, 'artifacts/paired-agent')).filter(name => name.startsWith('scored-')).map(name => join(root, 'artifacts/paired-agent', name, run.id, 'before.json')).filter(existsSync)
      assert.equal(candidates.length, 1, 'One preserved prelaunch inventory is required to resume each existing run')
      const before = JSON.parse(readFileSync(candidates[0])).prepared
      assert.equal(before.fixtureSha256, run.fixtureSha256)
      const comparison = comparisonManifest(before.files, before.workspace)
      comparisons.set(run.task, comparison)
      report.fixtureComparisons[run.id] = publicComparison(comparison)
    }
  }
  report.summary = summarizePairedRuns(report.runs)
  writeJson(join(captureRoot, 'protocol.json'), protocol)
  writeJson(reportPath, report)
  for (const scheduled of protocol.schedule) {
    if (report.runs.some(run => run.id === scheduled.id)) continue
    console.log(JSON.stringify({ event: 'preparing', ...scheduled }))
    const task = protocol.tasks.find(task => task.id === scheduled.task)
    const workspace = mkdtempSync(join(tmpdir(), 'typelatch-paired-'))
    const prepared = await prepareTask(task.id, workspace)
    assert.equal(prepared.baseline.passed, false, 'An unfixed task must fail its correctness gate')
    const comparison = comparisonManifest(prepared.files, workspace)
    if (comparisons.has(task.id)) assertComparableFixtures(comparisons.get(task.id), comparison)
    else comparisons.set(task.id, comparison)
    report.fixtureComparisons[scheduled.id] = publicComparison(comparison)
    const sourceBefore = Object.fromEntries(prepared.files.filter(file => file.path === 'batch.ts' || /^src\/.+\.ts$/u.test(file.path)).map(file => [file.path, readFileSync(join(workspace, file.path), 'utf8')]))
    const setupMs = prepared.setupMs
    let indexSetupMs = 0, preparation = null
    if (scheduled.arm === 'typelatch') {
      const start = performance.now()
      const indexed = spawnSync(process.execPath, [join(runtime, 'dist/cli.js'), 'sync', '--json'], { cwd: workspace, env: { ...process.env, TYPELATCH_HOME: join(workspace, '.typelatch'), TYPELATCH_USAGE: 'off' }, encoding: 'utf8', timeout: 180_000, maxBuffer: 15_000_000 })
      indexSetupMs = performance.now() - start
      preparation = { exitCode: indexed.status, result: JSON.parse(indexed.stdout), stderr: indexed.stderr }
      assert.equal(indexed.status, 0, 'Typelatch index preparation must complete before a scored launch')
      assert.equal(preparation.result.success, true)
    }
    const output = join(captureRoot, scheduled.id)
    mkdirSync(output, { recursive: true })
    writeJson(join(output, 'before.json'), { scheduled, prepared, preparation, prompt: task.prompt })
    const normalize = value => normalizeDemo(value, [[workspace, '$WORKSPACE'], [root, '$REPOSITORY'], [homedir(), '$USER_HOME'], [process.execPath, '$NODE']])
    const empty = extractPairedEvents('')
    const run = { ...scheduled, startedAt: new Date().toISOString(), finishedAt: null, elapsedMs: null, setupMs, indexSetupMs, gradingMs: null, status: 'running', exitCode: null, timedOut: null, processGroupStopped: null, correct: null, usage: empty.usage, counts: empty.counts, capture: empty.capture, fixtureSha256: prepared.fixtureSha256, promptSha256: task.promptSha256, rawSha256: null, evidence: `paired-agent-runs/${scheduled.id}.json` }
    const persist = () => { report.summary = summarizePairedRuns(report.runs); report.capturedAt = new Date().toISOString(); writeJson(reportPath, report) }
    // Persist before launch so no later grading or export failure can erase an attempt.
    report.runs.push(run); persist()
    let stage = 'launch', started, evidence = empty, grading = null, changes = []
    try {
      started = await runAgent({ workspace, prompt: task.prompt, output, packageRoot: scheduled.arm === 'typelatch' ? runtime : null, timeoutMs: protocol.timeoutMs })
      stage = 'accounting'; evidence = extractPairedEvents(started.raw)
      if (started.recordingError) { evidence.capture.complete = false; evidence.capture.issues.push({ code: 'recorder-error' }) }
      evidence.actions = evidence.actions.map(action => ({ ...action, startedMs: started.timing.find(event => event.type === 'item.started' && event.itemIdHash === action.idSha256)?.elapsedMs ?? null, completedMs: started.timing.find(event => event.type === 'item.completed' && event.itemIdHash === action.idSha256)?.elapsedMs ?? null }))
      Object.assign(run, { startedAt: started.startedAt, finishedAt: started.finishedAt, elapsedMs: started.elapsedMs, status: started.exitCode === 0 && !started.timedOut && evidence.capture.complete ? 'completed' : 'failed', exitCode: started.exitCode, timedOut: started.timedOut, processGroupStopped: started.processGroupStopped, recordingError: started.recordingError, usage: evidence.usage, counts: evidence.counts, capture: evidence.capture, rawSha256: started.rawSha256 })
      persist()
      stage = 'grading'
      assert.equal(started.processGroupStopped, true, 'Grade only after the owned agent processes have stopped')
      const gradeStart = performance.now()
      grading = await gradeTask(task.id, workspace, prepared.files)
      run.gradingMs = performance.now() - gradeStart
      run.correct = grading.error ? null : grading.passed
      persist()
      stage = 'source-export'
      changes = (grading.integrity.changes ?? []).filter(path => Object.hasOwn(sourceBefore, path)).map(path => ({ path, before: sourceBefore[path], after: existsSync(join(workspace, path)) ? readFileSync(join(workspace, path), 'utf8') : null }))
    } catch (error) {
      run.status = 'failed'; run.postProcessingError = { stage, name: error?.name ?? 'Error' }
      persist()
    }
    let record = normalize({ schemaVersion: 1, run, prompt: task.prompt, requestedConfig: started?.config ?? null, actions: evidence.actions, baseline: prepared.baseline, preparation, grading, changes, fixture: { fileCount: prepared.files.length, manifestSha256: prepared.fixtureSha256, dependencies: prepared.dependencyIdentities }, recording: 'Allowlisted completed public tool actions, final source changes, independent test output, and measured usage only. Model reasoning and message bodies are not exported. Full initial file inventory is retained locally; its digest includes installed dependencies.' })
    let serialized = JSON.stringify(record, null, 2) + '\n'
    if (/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//.test(serialized)) {
      run.status = 'failed'; run.postProcessingError = { stage: 'privacy-export', name: 'UnnormalizedPath' }
      record = { schemaVersion: 1, run, prompt: task.prompt, recording: 'Payload withheld after export validation failed. Measurements remain recorded.' }
      serialized = JSON.stringify(record, null, 2) + '\n'
    }
    writeFileSync(join(publicDirectory, scheduled.id + '.json'), serialized)
    run.evidenceSha256 = hash(serialized); persist()
    console.log(JSON.stringify({ event: 'recorded', ...scheduled, status: run.status, correct: run.correct, elapsedMs: run.elapsedMs, usage: run.usage, counts: run.counts }))
    for (const file of harness) assert.equal(hash(readFileSync(join(root, file.path))), file.sha256, 'Frozen harness changed during the benchmark')
    assert.equal(command('codex', ['--version']), cliVersion)
    assert.equal(hash(readFileSync(join(runtime, 'package.json'))), packageManifestSha256)
    assert.equal(run.processGroupStopped, true, 'Do not launch another run while an owned process group may still be active')
    verifyFrozenInputs(frozen)
  }
  report.complete = report.runs.length === protocol.runCount
  report.finishedAt = report.capturedAt = new Date().toISOString(); writeJson(reportPath, report)
  console.log(JSON.stringify({ event: 'complete', report: 'docs/benchmarks/paired-agent.json', summary: report.summary }))
}
