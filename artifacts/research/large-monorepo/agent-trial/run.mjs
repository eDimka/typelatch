import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir, platform, arch, cpus, totalmem } from 'node:os'
import { pathToFileURL } from 'node:url'
import { pairedConfig, cleanEnvironment, resolvedCodexBinary, hash } from '../../../../scripts/paired-agent-runner.mjs'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
import { extractPairedEvents } from '../../../../scripts/paired-agent-evidence.mjs'
import { normalizeDemo } from '../../../../scripts/demo-evidence.mjs'
import { verifyCandidateArchive } from '../../../../scripts/paired-agent-candidate.mjs'
import { decisionGate, makeSchedule, evaluateDecision, arms } from './decision.mjs'
import { captureAgent, substitute, nativeValidationObservation } from './capture.mjs'
import { initializeFixtureGit, verifyFixtureGit } from './fixture-git.mjs'

const here = import.meta.dirname, repository = resolve(here, '../../../..')
const read = path => JSON.parse(readFileSync(path))
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const snapshot = path => inventoryTree(path, { excludeDirectories: ['.git', '.typelatch'] })
const files = ['run.mjs', 'capture.mjs', 'decision.mjs', 'fixture-git.mjs'].map(path => join(here, path))
const shared = ['paired-agent-runner.mjs', 'paired-agent-integrity.mjs', 'paired-agent-evidence.mjs', 'paired-agent-candidate.mjs', 'paired-agent-fixtures.mjs', 'paired-agent-comparison.mjs', 'paired-agent-decision.mjs', 'demo-evidence.mjs'].map(path => join(repository, 'scripts', path))
const commonPrompt = 'Make a minimal change in existing implementation source. Do not add files or edit tests, dependencies, manifests, configuration or documentation. Inspect relevant source using the available tools as appropriate. Run npm run test:typelatch-benchmark before and after the change; this provided native validation command is the same in every condition. It is authorized to execute its supplied external test runner, but do not otherwise inspect files outside this project. Do not use the network, install packages, inspect repository history or delegate work. Report your changes and remaining failures.'

export const taskDescriptions = [
  { id: 'pnpm-changed-project-move', title: 'pnpm changed-project selection after a file move', publicCases: 3, body: 'Changed-project selection can omit an affected project when tracked source files move from one workspace project into another. Fix the existing selection behavior so both the old and new project are selected, without selecting unrelated projects. Preserve ordinary edits, unchanged projects, ignored-file patterns and test-only change classification.' },
  { id: 'pnpm-global-bin-api-migration', title: 'pnpm global executable-directory API migration', publicCases: 3, body: 'After the prepared dependency upgrade, validating an existing writable global executable directory fails. Adapt the existing validation code to the installed package API. Preserve PATH membership checks, missing PATH errors, optional write checking, and rejection of directories that cannot be written to.' },
]

function command(config, variables, timeoutMs = 600000) {
  const value = substitute(config, variables), start = performance.now()
  const result = spawnSync(value.command, value.args, { cwd: variables.workspace, env: { ...cleanEnvironment(), ...value.env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  return { command: value.command, args: value.args, envKeys: Object.keys(value.env ?? {}), elapsedMs: performance.now() - start, exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.code ?? null }
}

export function validateSpec(spec) {
  assert.equal(spec.schemaVersion, 1)
  assert.equal(spec.status, 'selected-and-ready', 'Resolve the strongest control before freezing')
  const candidates = Object.hasOwn(spec.arms, 'packet') ? ['typelatch', 'packet'] : ['typelatch']
  assert.deepEqual(Object.keys(spec.arms).sort(), [...arms, ...(candidates.length === 2 ? ['packet'] : [])].sort())
  assert.deepEqual(spec.candidates, candidates, 'Candidate set must be explicit before freeze')
  assert.deepEqual(Object.keys(spec.fixtures).sort(), taskDescriptions.map(task => task.id).sort())
  assert(spec.competitorSelection?.name && spec.competitorSelection?.version && spec.competitorSelection?.reason && spec.competitorSelection?.evidencePath, 'Competitor selection needs an explicit frozen rationale and evidence')
  for (const [name, arm] of Object.entries(spec.arms)) {
    assert(Array.isArray(arm.setupCommands) && Array.isArray(arm.frozenInputs) && Array.isArray(arm.allowedStateLinks))
    assert(['process-group', 'lifecycle'].includes(arm.cleanupMode))
    assert(!arm.lifecycleModule || arm.cleanupMode === 'lifecycle')
    assert(arm.cleanupMode !== 'lifecycle' || arm.lifecycleModule)
    for (const stateLink of arm.allowedStateLinks) assert(['.codegraph', '.serena', '.graphify'].includes(stateLink), 'Only declared provider state links may be added')
    for (const server of Object.values(arm.servers)) {
      assert(server.command.startsWith('/') && !server.command.includes('{'))
      assert(Array.isArray(server.args) && Array.isArray(server.tools) && server.tools.length > 0)
      assert.equal(server.cwd, '{workspace}')
    }
    for (const setup of arm.setupCommands) assert(setup.command.startsWith('/') && Array.isArray(setup.args))
    if (name === 'native') assert(Object.keys(arm.servers).length === 0 && arm.setupCommands.length === 0 && !arm.lifecycleModule)
    else assert(Object.keys(arm.servers).length > 0 && arm.frozenInputs.length > 0)
  }
  assert.deepEqual(spec.arms.typelatch.servers.typelatch.tools.toSorted(), ['workspace_search', 'workspace_context', 'workspace_validate', 'library_search', 'library_symbol', 'library_feedback', 'library_stats'].toSorted())
  assert(spec.typelatchArtifact?.manifest && spec.typelatchArtifact?.runtime, 'Exact candidate archive binding is required')
  assert(Array.isArray(spec.sharedFrozenInputs) && spec.sharedFrozenInputs.length > 0, 'Native grader loader and its dependencies must be frozen')
  for (const fixture of Object.values(spec.fixtures)) assert(fixture.workspace.startsWith('/') && fixture.initialManifest.startsWith('/') && fixture.qualification.startsWith('/') && fixture.graderModule.startsWith('/') && fixture.sourceTrackingManifest.startsWith('/'))
}

function binding(spec) {
  const artifact = read(spec.typelatchArtifact.manifest)
  assert.equal(artifact.name, 'typelatch')
  assert.equal(artifact.tarball, artifact.tarball.split('/').at(-1))
  return { ...verifyCandidateArchive({ ...artifact, archive: join(dirname(spec.typelatchArtifact.manifest), artifact.tarball), runtime: spec.typelatchArtifact.runtime }), sourceCommit: artifact.sourceCommit, name: artifact.name, version: artifact.version }
}

function inventoryInputs(spec, specPath) {
  const entries = [...files, ...shared, specPath, spec.typelatchArtifact.manifest, spec.competitorSelection.evidencePath, resolvedCodexBinary().path, process.execPath, realpathSync('/usr/bin/git')].map(path => ({ path, kind: 'file' }))
  entries.push({ path: join(dirname(spec.typelatchArtifact.manifest), read(spec.typelatchArtifact.manifest).tarball), kind: 'file' })
  for (const fixture of Object.values(spec.fixtures)) entries.push({ path: fixture.workspace, kind: 'tree' }, ...[fixture.initialManifest, fixture.qualification, fixture.graderModule, fixture.sourceTrackingManifest].map(path => ({ path, kind: 'file' })))
  for (const arm of Object.values(spec.arms)) {
    entries.push(...arm.frozenInputs)
    if (arm.lifecycleModule) entries.push({ path: arm.lifecycleModule, kind: 'file' })
    for (const server of Object.values(arm.servers)) entries.push({ path: realpathSync(server.command), kind: 'file' })
    for (const setup of arm.setupCommands) entries.push({ path: realpathSync(setup.command), kind: 'file' })
  }
  entries.push(...spec.sharedFrozenInputs)
  const unique = [...new Map(entries.map(entry => [entry.kind + ':' + resolve(entry.path), { ...entry, path: resolve(entry.path) }])).values()]
  return unique.map(entry => {
    assert(['file', 'tree'].includes(entry.kind), 'Known inventory kind required')
    const value = entry.kind === 'tree' ? snapshot(entry.path) : { sha256: hash(readFileSync(entry.path)), bytes: readFileSync(entry.path).length }
    return { ...entry, sha256: value.sha256, bytes: value.bytes ?? null, entries: value.entries?.length ?? null }
  })
}

function verifyInputs(frozen) {
  for (const input of frozen) assert.equal(input.kind === 'tree' ? snapshot(input.path).sha256 : hash(readFileSync(input.path)), input.sha256, `Frozen input changed: ${input.path}`)
}

function preparedIntegrity(before, after, arm, workspace, state) {
  const a = new Map(before.entries.filter(entry => entry.kind !== 'directory').map(entry => [entry.path, entry]))
  const b = new Map(after.entries.filter(entry => entry.kind !== 'directory').map(entry => [entry.path, entry]))
  for (const [path, entry] of a) assert.deepEqual(b.get(path), entry, `Provider preparation changed a protected fixture entry: ${path}`)
  for (const [path, entry] of b) if (!a.has(path)) {
    assert(arm.allowedStateLinks.includes(path) && entry.kind === 'symlink', `Undeclared provider corpus addition: ${path}`)
    assert(resolve(dirname(join(workspace, path)), entry.target).startsWith(state + sep), 'Provider state link must point inside this run state directory')
  }
}

export function assertResume(report, protocol, protocolSha256) {
  assert.equal(report.protocolSha256, protocolSha256)
  assert.deepEqual(report.protocol, protocol)
  assert.equal(report.complete, false)
  assert.equal(report.preparationAttempts.length, report.runs.length)
  for (const [index, attempt] of report.preparationAttempts.entries()) {
    const run = report.runs[index]
    assert(attempt.status === 'ready' && attempt.id === run.id && run.id === protocol.schedule[index].id && run.status !== 'running' && run.processGroupStopped === true && run.providerStopped === true, 'Interrupted, failed or unmatched preparation/cleanup cannot be retried')
  }
}

async function main() {
  const [mode, specArgument, outputArgument] = process.argv.slice(2)
  assert(['--freeze', '--run', '--resume'].includes(mode) && specArgument && outputArgument, 'Use --freeze|--run|--resume SPEC.json NEW_STUDY_DIRECTORY')
  const specPath = resolve(specArgument), output = resolve(outputArgument), spec = read(specPath)
  validateSpec(spec)
  mkdirSync(output, { recursive: true })
  const protocolPath = join(output, 'protocol.json'), reportPath = join(output, 'report-private.json')
  if (mode === '--freeze') {
    assert(!existsSync(protocolPath) && !existsSync(reportPath), 'Never overwrite a frozen study')
    const inputs = inventoryInputs(spec, specPath)
    for (const fixture of Object.values(spec.fixtures)) { assert.equal(read(fixture.qualification).status, 'qualified'); assert.equal(snapshot(fixture.workspace).sha256, read(fixture.initialManifest).sha256) }
    const cli = spawnSync(resolvedCodexBinary().path, ['--version'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(cli, 'codex-cli 0.166.0')
    const tasks = taskDescriptions.map(({ body, ...task }) => ({ ...task, prompt: body + '\n\n' + commonPrompt, promptSha256: hash(body + '\n\n' + commonPrompt) }))
    const protocol = { schemaVersion: 1, study: 'real-maintenance-flexible-tools-v1', createdAt: new Date().toISOString(), status: 'frozen-before-agent-sessions', runCount: 4 * Object.keys(spec.arms).length, repeats: 2, candidates: spec.candidates, timeoutMs: 600000, tasks, schedule: makeSchedule(tasks.map(task => task.id), spec.candidates), config: pairedConfig, cliVersion: cli, codexBinary: resolvedCodexBinary(), decisionGate, spec, specSha256: hash(readFileSync(specPath)), inputs, typelatchArchiveBinding: binding(spec), treatment: 'Same prompt and native tools in all arms; additional provider tools are available but optional. No forced API inspection or workspace_validate calls.', timing: 'Fresh corpus copies and independent grading excluded. Provider-specific setup is charged once, plus agent wall time including MCP startup, query work and native validation. Teardown measured separately. No prepared package index is required for Typelatch; any indexing it performs during use is already inside agent time.', selection: 'Two real upstream pnpm maintenance cases selected before these agent sessions, including one explicitly isolated dependency upgrade. The initial date-fns template is retained as pre-session amendment evidence, and date-fns remains reserved for external replication. Identical prompts across all frozen arms; fixed task order ABBA and reversed provider order per task across repeats. With four arms each occupies every ordinal position once. No tasks, runs or candidates removed after results; each candidate decision is separate.', failurePolicy: 'Persist preparation before work and run before launch. Preserve every attempt. Failed or interrupted preparation cannot be retried; interrupted or incomplete launches remain visible. Resume only a completed prefix. No replacements.', evidencePolicy: 'Private raw JSONL retained. Only completed public actions, source changes, independent test results, usage and timestamp metadata are eligible for export. No reasoning or assistant message bodies.', limits: ['One task tests a real installed-API migration and one tests source workflow in the same pnpm snapshot. This narrow sample does not establish general API or monorepo superiority.', 'A two-task sample with two repeats is not universal superiority or a statistical confidence bound.', 'The public upstream repairs may occur in model training data.', 'No immutable served model snapshot or sampling seed is available.', 'OS file caches and provider prompt caching may be warm; cached tokens remain included.', 'Fixture and prompt boundaries are procedural; no OS isolation claim is made.'] }
    write(protocolPath, protocol)
    console.log(JSON.stringify({ status: 'frozen-no-agent-run', protocol: protocolPath, sha256: hash(readFileSync(protocolPath)) }))
    return
  }
  const protocolBytes = readFileSync(protocolPath), protocol = JSON.parse(protocolBytes), protocolSha256 = hash(protocolBytes)
  assert.deepEqual(protocol.spec, spec); assert.equal(protocol.specSha256, hash(readFileSync(specPath)))
  assert.deepEqual(protocol.config, pairedConfig); assert.deepEqual(protocol.decisionGate, decisionGate); assert.deepEqual(protocol.schedule, makeSchedule(protocol.tasks.map(task => task.id), protocol.candidates))
  verifyInputs(protocol.inputs); assert.deepEqual(binding(spec), protocol.typelatchArchiveBinding)
  const report = mode === '--resume' ? read(reportPath) : { schemaVersion: 1, protocol, protocolSha256, startedAt: new Date().toISOString(), complete: false, runs: [], preparationAttempts: [], machine: { platform: platform(), architecture: arch(), nodeVersion: process.version, processor: cpus()[0]?.model, logicalProcessors: cpus().length, memoryBytes: totalmem() } }
  if (mode === '--resume') assertResume(report, protocol, protocolSha256)
  else assert(!existsSync(reportPath), 'Use explicit resume to retain a prior study')
  const persist = () => { report.updatedAt = new Date().toISOString(); report.decision = evaluateDecision(report); write(reportPath, report) }
  persist()
  for (const slot of protocol.schedule) {
    if (report.runs.some(run => run.id === slot.id)) continue
    const arm = spec.arms[slot.arm], task = protocol.tasks.find(task => task.id === slot.task), fixture = spec.fixtures[slot.task]
    const runRoot = join(output, 'runs', slot.id), workspace = join(runRoot, 'workspace'), state = join(runRoot, 'provider-state'), capture = join(runRoot, 'capture')
    const attempt = { ...slot, status: 'preparing', stage: 'fixture', startedAt: new Date().toISOString() }
    report.preparationAttempts.push(attempt); persist()
    let lifecycle = null, lifecycleModule = null, initial, baseline, fixtureGit, fixtureSetupMs, providerSetupMs = 0, run = null, preparation = []
    try {
      verifyInputs(protocol.inputs)
      assert(!existsSync(runRoot), 'No preparation attempt may overwrite an earlier attempt')
      mkdirSync(runRoot, { recursive: true }); mkdirSync(state)
      const commonStart = performance.now()
      cpSync(fixture.workspace, workspace, { recursive: true, dereference: false, verbatimSymlinks: true })
      baseline = snapshot(workspace); assert.equal(baseline.sha256, read(fixture.initialManifest).sha256, 'Every arm receives exact same full fixture bytes and link text')
      fixtureGit = initializeFixtureGit({ workspace, state, trackingManifest: read(fixture.sourceTrackingManifest) })
      write(join(runRoot, 'fixture-git.json'), fixtureGit)
      fixtureSetupMs = performance.now() - commonStart
      attempt.stage = 'provider-setup'; persist()
      const providerStart = performance.now()
      try {
        for (const setup of arm.setupCommands) { const result = command(setup, { workspace, state }); preparation.push(result); write(join(runRoot, 'preparation.json'), preparation); assert.equal(result.exitCode, 0, 'Provider setup failed') }
        if (arm.lifecycleModule) {
          lifecycleModule = await import(pathToFileURL(arm.lifecycleModule).href)
          lifecycle = await lifecycleModule.start({ workspace, state, arm: slot.arm })
          assert(lifecycle && typeof lifecycle.close === 'function', 'Lifecycle must return a close method that verifies owned processes stopped')
          preparation.push({ lifecycleModule: arm.lifecycleModule, evidence: lifecycle.evidence ?? null })
        }
      } finally { providerSetupMs = performance.now() - providerStart; attempt.providerSetupMs = providerSetupMs; write(join(runRoot, 'preparation.json'), preparation); persist() }
      initial = snapshot(workspace); preparedIntegrity(baseline, initial, arm, workspace, state)
      write(join(runRoot, 'before.json'), { slot, promptSha256: task.promptSha256, fixtureSetupMs, providerSetupMs, inventory: initial })
      const empty = extractPairedEvents('')
      run = { ...slot, status: 'running', startedAt: null, finishedAt: null, fixtureSetupMs, providerSetupMs, elapsedMs: null, teardownMs: null, gradingMs: null, exitCode: null, timedOut: null, processGroupStopped: null, providerStopped: null, correct: null, capture: empty.capture, usage: empty.usage, counts: empty.counts, fixtureSha256: baseline.sha256, preparedSha256: initial.sha256, promptSha256: task.promptSha256 }
      report.runs.push(run); attempt.status = 'ready'; attempt.finishedAt = new Date().toISOString(); persist()
    } catch (error) {
      attempt.status = 'failed'; attempt.error = { name: error.name, message: error.message }; attempt.finishedAt = new Date().toISOString()
      if (lifecycle) attempt.cleanup = await lifecycle.close().catch(error => ({ stopped: false, error: error.message }))
      else if (lifecycleModule?.cleanupFailedStart) attempt.cleanup = await lifecycleModule.cleanupFailedStart({ workspace, state }).catch(error => ({ stopped: false, error: error.message }))
      persist(); throw error
    }
    let recorded, evidence = extractPairedEvents(''), grading = null, changes = [], stage = 'agent'
    try {
      recorded = await captureAgent({ workspace, state, prompt: task.prompt, servers: arm.servers, output: capture, timeoutMs: protocol.timeoutMs })
      evidence = extractPairedEvents(recorded.raw)
      if (recorded.recordingError) { evidence.capture.complete = false; evidence.capture.issues.push({ code: 'recorder-error' }) }
      evidence.actions = evidence.actions.map(action => ({ ...action, startedMs: recorded.timing.find(row => row.type === 'item.started' && row.itemIdHash === action.idSha256)?.elapsedMs ?? null, completedMs: recorded.timing.find(row => row.type === 'item.completed' && row.itemIdHash === action.idSha256)?.elapsedMs ?? null }))
      Object.assign(run, { startedAt: recorded.startedAt, finishedAt: recorded.finishedAt, elapsedMs: recorded.elapsedMs, exitCode: recorded.exitCode, timedOut: recorded.timedOut, processGroupStopped: recorded.processGroupStopped, recordingError: recorded.recordingError, rawSha256: recorded.rawSha256, capture: evidence.capture, counts: evidence.counts, usage: evidence.usage, nativeValidation: nativeValidationObservation(recorded.raw, task.publicCases), status: recorded.exitCode === 0 && !recorded.timedOut && evidence.capture.complete ? 'completed' : 'failed' })
      persist()
    } catch (error) { run.status = 'failed'; run.error = { stage, name: error.name, message: error.message }; persist() }
    finally {
      const start = performance.now()
      try { const cleanup = lifecycle ? await lifecycle.close() : { stopped: run.processGroupStopped === true }; run.providerStopped = cleanup.stopped === true; write(join(runRoot, 'cleanup.json'), cleanup) }
      catch (error) { run.providerStopped = false; run.cleanupError = { name: error.name, message: error.message } }
      run.teardownMs = performance.now() - start; persist()
    }
    assert.equal(run.processGroupStopped, true, 'Do not grade or launch another session while owned agent processes may remain')
    assert.equal(run.providerStopped, true, 'Do not grade or launch another session while a provider daemon may remain')
    try {
      stage = 'grading'; const start = performance.now()
      const grader = await import(pathToFileURL(fixture.graderModule).href)
      grading = await grader.gradeWorkspace(workspace, initial)
      grading.fixtureGitUnchanged = verifyFixtureGit(workspace, fixtureGit)
      grading.passed = grading.passed && grading.fixtureGitUnchanged
      run.gradingMs = performance.now() - start; run.correct = typeof grading.passed === 'boolean' ? grading.passed : null
      changes = (grading.integrity?.changed ?? grading.integrity?.changes ?? []).map(path => {
        const beforeEntry = initial.entries.find(entry => entry.path === path), target = join(workspace, path), regular = existsSync(target) && lstatSync(target).isFile()
        return { path, beforeSha256: beforeEntry?.sha256 ?? null, afterSha256: regular ? hash(readFileSync(target)) : null, ...(beforeEntry?.kind === 'file' && /\.[cm]?[jt]sx?$/u.test(path) && regular && existsSync(join(fixture.workspace, path)) ? { before: readFileSync(join(fixture.workspace, path), 'utf8'), after: readFileSync(target, 'utf8') } : {}) }
      })
      persist()
    } catch (error) { run.status = 'failed'; run.error = { stage, name: error.name, message: error.message }; persist() }
    const publicRecord = normalizeDemo({ schemaVersion: 1, run, prompt: task.prompt, actions: evidence.actions, requestedConfig: recorded?.config ?? null, grading, changes, recording: 'Allowlisted completed public actions, independent grading, final changes and measured usage. No reasoning or assistant message bodies.' }, [[workspace, '$WORKSPACE'], [state, '$PROVIDER_STATE'], [output, '$STUDY'], [repository, '$REPOSITORY'], [homedir(), '$USER_HOME']])
    const recordBytes = JSON.stringify(publicRecord, null, 2) + '\n'
    assert(!/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u.test(recordBytes), 'Public artifact contains an unnormalized private path')
    writeFileSync(join(runRoot, 'public-evidence.json'), recordBytes, { mode: 0o600 }); run.evidenceSha256 = hash(recordBytes); persist()
    console.log(JSON.stringify({ event: 'recorded', ...slot, correct: run.correct, elapsedMs: run.elapsedMs, providerSetupMs, usage: run.usage, counts: run.counts }))
    verifyInputs(protocol.inputs)
  }
  report.complete = report.runs.length === protocol.schedule.length; report.finishedAt = new Date().toISOString(); persist()
  console.log(JSON.stringify({ event: 'complete', report: reportPath, decision: report.decision }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
