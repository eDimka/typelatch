import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir, tmpdir, platform, arch, cpus, totalmem } from 'node:os'
import { pathToFileURL } from 'node:url'
import { pairedConfig, cleanEnvironment, resolvedCodexBinary, hash } from '../../../../scripts/paired-agent-runner.mjs'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
import { extractPairedEvents } from '../../../../scripts/paired-agent-evidence.mjs'
import { normalizeDemo } from '../../../../scripts/demo-evidence.mjs'
import { verifyCandidateArchive } from '../../../../scripts/paired-agent-candidate.mjs'
import { decisionGate, makeSchedule, evaluateDecision } from './decision.mjs'
import { reviewRules } from './review.mjs'
import { captureAgent, substitute } from '../../large-monorepo/inventory-agent-trial/capture.mjs'
import { initializeFixtureGit, verifyFixtureGit } from '../../large-monorepo/inventory-agent-trial/fixture-git.mjs'

const here = import.meta.dirname, repository = resolve(here, '../../../..')
const read = path => JSON.parse(readFileSync(path))
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const snapshot = path => inventoryTree(path, { excludeDirectories: ['.git', '.typelatch'] })
const capturePath = resolve(here, '../../large-monorepo/inventory-agent-trial/capture.mjs')
const files = ['run.mjs', 'decision.mjs', 'review.mjs'].map(path => join(here, path))
files.push(capturePath, resolve(here, '../../large-monorepo/inventory-agent-trial/fixture-git.mjs'))
const shared = ['paired-agent-runner.mjs', 'paired-agent-integrity.mjs', 'paired-agent-evidence.mjs', 'paired-agent-candidate.mjs', 'paired-agent-fixtures.mjs', 'paired-agent-comparison.mjs', 'paired-agent-decision.mjs', 'demo-evidence.mjs'].map(path => join(repository, 'scripts', path))
export const investigationPolicy = 'For your first task-directed investigation, obtain relevant evidence through the advertised repository provider when present, otherwise through native tools. Provider startup instructions and harmless top-level metadata checks are separate. Then choose freely among all available tools. Native compiler, language service, package-manager filters and source reads are available in every condition. Prefer concise evidence and avoid redundant reads. Do not mistake package reachability for proven symbol impact or an incomplete result for absence.'
export function taskPrompt(task) {
  const validation = task.validationCommand
  const taskPolicy = task.mode === 'edit'
    ? `Before investigating implementation, run the supplied native validation command: ${validation}. After making the requested change, run it again. ${task.policy}`
    : `Do not change implementation, tests, dependencies or configuration. Write the requested analysis to ${task.answerFile}. ${task.policy}${validation ? ' The optional answer format check is: ' + validation + '.' : ''}`
  return [task.description, taskPolicy, investigationPolicy, 'Stay inside this project. Do not use the network, install packages, inspect repository history, read external files or delegate work. Supplied native validation commands may execute their configured external runner, but do not inspect that runner or other external files. Native source, installed declarations and project configuration inside the workspace remain available.'].join('\n\n')
}
export function validationObservation(raw, expectedFinalCases) {
  const checks = [], seen = new Set()
  for (const [line, text] of raw.split('\n').entries()) {
    let event
    try { event = JSON.parse(text) } catch { continue }
    const item = event.item
    if (event.type !== 'item.completed' || item?.type !== 'command_execution' || typeof item.id !== 'string' || seen.has(item.id)) continue
    seen.add(item.id)
    if (typeof item.command !== 'string' || !/\bnpm\s+run\s+test:typelatch-benchmark\b/u.test(item.command) || typeof item.aggregated_output !== 'string') continue
    const results = item.aggregated_output.split('\n').flatMap(value => { try { return [JSON.parse(value)] } catch { return [] } }).filter(value => Number.isSafeInteger(value?.cases) && value.cases > 0 && Array.isArray(value.results) && value.results.length === value.cases && typeof value.passed === 'boolean')
    for (const [resultIndex, result] of results.entries()) checks.push({ line: line + 1, actionIdSha256: hash(item.id), commandExitCode: item.exit_code, individualCheckExitCode: null, resultIndex, passed: result.passed, cases: result.cases, expectedFinalCases, completePassingCheck: result.passed && result.cases === expectedFinalCases, outputSha256: hash(item.aggregated_output) })
  }
  return { checks, failingThenLaterCheckObserved: checks.length >= 2 && checks[0].passed === false, limitation: 'A compiler failure may prevent runtime checks, so actual case counts are retained. Only a passing final response with the full expected count qualifies. Compound shell exit is aggregate, not a per-check exit. Independent action review must assess actual execution and edit ordering.' }
}
export function capabilityInventory(spec, arm) {
  const providers = Object.entries(spec.arms[arm].servers)
  const names = providers.map(([name]) => name)
  const tools = providers.flatMap(([name, server]) => server.tools.map(tool => `mcp__${name}__${tool}`))
  return ['Repository retrieval capability inventory for this session:', `Provider: ${names.join(', ') || 'none'}`, `Tools: ${tools.join(', ') || 'none'}`, 'Additional repository providers: none', 'Native tools: available', 'This inventory is complete for the session. Built-in MCP resource and resource-template catalogs are not repository retrieval providers; do not call them to discover providers. Use tool search only if needed to load deferred definitions of the declared tools.'].join('\n')
}
export function makePrompts(tasks, spec) {
  return tasks.flatMap(task => Object.keys(spec.arms).map(arm => {
    const inventory = capabilityInventory(spec, arm), prompt = task.prompt + '\n\n' + inventory
    return { task: task.id, arm, inventory, prompt, promptSha256: hash(prompt) }
  }))
}

function command(config, variables, timeoutMs = 600000) {
  const value = substitute(config, variables), start = performance.now()
  const result = spawnSync(value.command, value.args, { cwd: variables.workspace, env: { ...cleanEnvironment(), ...value.env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 })
  return { command: value.command, args: value.args, envKeys: Object.keys(value.env ?? {}), elapsedMs: performance.now() - start, exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, error: result.error?.code ?? null }
}

export function validateSpec(spec) {
  assert.equal(spec.schemaVersion, 1)
  assert.equal(spec.status, 'selected-and-ready', 'Review task and provider qualification before freezing')
  assert(['development', 'confirmation'].includes(spec.phase))
  assert(Array.isArray(spec.tasks) && spec.tasks.length && new Set(spec.tasks.map(t => t.id)).size === spec.tasks.length)
  assert.deepEqual(Object.keys(spec.fixtures).toSorted(), spec.tasks.map(t => t.id).toSorted())
  const candidates = Object.keys(spec.arms).filter(name => !['native', 'competitor'].includes(name))
  assert.deepEqual(spec.candidates, candidates)
  assert(candidates.length > 0 && Object.keys(spec.arms).includes('native') && Object.keys(spec.arms).includes('competitor'))
  assert([1, 2].includes(spec.repeats) && Number.isInteger(spec.timeoutMs) && spec.timeoutMs > 0 && spec.timeoutMs <= 900000)
  if (spec.phase === 'confirmation') assert.equal(spec.repeats, 2)
  for (const task of spec.tasks) {
    assert(/^[a-z0-9][a-z0-9-]*$/.test(task.id) && decisionGate.categories.includes(task.category))
    assert(['edit', 'analysis'].includes(task.mode) && typeof task.description === 'string' && task.description.length > 40 && typeof task.policy === 'string')
    assert.equal(task.split, spec.phase === 'development' ? 'development' : 'heldout')
    if (task.mode === 'edit') {
      assert.equal(task.validationCommand, 'npm run test:typelatch-benchmark')
      assert(Number.isSafeInteger(task.publicCases) && task.publicCases > 0)
    }
    else assert(task.answerFile && !task.answerFile.startsWith('/') && !task.answerFile.split('/').some(p => p === '..'))
    assert(task.scope?.productionPackages >= 3, 'Task must genuinely cross at least three production package boundaries')
  }
  assert(spec.competitorSelection?.name && spec.competitorSelection?.version && spec.competitorSelection?.reason && spec.competitorSelection?.evidencePath)
  for (const [name, arm] of Object.entries(spec.arms)) {
    assert(Array.isArray(arm.setupCommands) && Array.isArray(arm.frozenInputs) && Array.isArray(arm.allowedStateLinks))
    assert(['process-group', 'lifecycle'].includes(arm.cleanupMode))
    assert(!arm.lifecycleModule || arm.cleanupMode === 'lifecycle')
    assert(arm.cleanupMode !== 'lifecycle' || arm.lifecycleModule)
    for (const link of arm.allowedStateLinks) assert(['.codegraph', '.serena', '.graphify'].includes(link))
    for (const server of Object.values(arm.servers)) {
      assert(server.command.startsWith('/') && !server.command.includes('{') && Array.isArray(server.args) && Array.isArray(server.tools) && server.tools.length)
      assert.equal(server.cwd, '{workspace}')
    }
    for (const setup of arm.setupCommands) assert(setup.command.startsWith('/') && Array.isArray(setup.args))
    if (name === 'native') assert(!Object.keys(arm.servers).length && !arm.setupCommands.length && !arm.lifecycleModule)
    else assert(Object.keys(arm.servers).length && arm.frozenInputs.length)
  }
  assert(spec.typelatchArtifact?.manifest && spec.typelatchArtifact?.runtime)
  assert(spec.supplementalOutputs?.extractor && spec.supplementalOutputs?.fileName === 'tool-outputs.json')
  assert(spec.toolUseQualification?.receipt && spec.toolUseQualification?.sourceSpec)
  assert(Array.isArray(spec.sharedFrozenInputs) && spec.sharedFrozenInputs.length)
  for (const fixture of Object.values(spec.fixtures)) for (const key of ['workspace', 'initialManifest', 'qualification', 'graderModule', 'sourceTrackingManifest']) assert(fixture[key].startsWith('/'))
}
function binding(spec) {
  const artifact = read(spec.typelatchArtifact.manifest)
  assert.equal(artifact.name, 'typelatch')
  assert.equal(artifact.tarball, artifact.tarball.split('/').at(-1))
  return { ...verifyCandidateArchive({ ...artifact, archive: join(dirname(spec.typelatchArtifact.manifest), artifact.tarball), runtime: spec.typelatchArtifact.runtime }), sourceCommit: artifact.sourceCommit, name: artifact.name, version: artifact.version }
}

export function inventoryDeclarations(spec, specPath) {
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
  entries.push(...[spec.supplementalOutputs.extractor, spec.toolUseQualification.receipt, spec.toolUseQualification.sourceSpec].map(path => ({ path, kind: 'file' })))
  const unique = [...new Map(entries.map(entry => [entry.kind + ':' + resolve(entry.path), { ...entry, path: resolve(entry.path) }])).values()]
  return unique
}

function inventoryInputs(spec, specPath) {
  return inventoryDeclarations(spec, specPath).map(entry => {
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
    assert.equal(hash(readFileSync(spec.supplementalOutputs.extractor)), spec.supplementalOutputs.extractorSha256)
    const qualificationBytes = readFileSync(spec.toolUseQualification.receipt), qualification = JSON.parse(qualificationBytes), original = read(spec.toolUseQualification.sourceSpec)
    assert.equal(qualification.passed, true)
    assert.equal(qualification.captureSha256, hash(readFileSync(capturePath)))
    assert.equal(qualification.specSha256, hash(readFileSync(spec.toolUseQualification.sourceSpec)))
    for (const arm of Object.keys(spec.arms)) assert.deepEqual(spec.arms[arm], original.arms[arm])
    for (const arm of Object.keys(spec.arms).filter(a => a !== 'native')) {
      const row = qualification.runs.find(r => r.arm === arm)
      assert(row?.status === 'passed' && row.cleanup?.stopped === true && row.capture?.capture?.complete === true && row.proof?.some(p => p.markerObserved === true))
    }
    const inputs = inventoryInputs(spec, specPath)
    for (const fixture of Object.values(spec.fixtures)) {
      assert.equal(read(fixture.qualification).status, 'qualified')
      assert.equal(snapshot(fixture.workspace).sha256, read(fixture.initialManifest).sha256)
    }
    const cliVersion = spawnSync(resolvedCodexBinary().path, ['--version'], { encoding: 'utf8' }).stdout.trim()
    assert.equal(cliVersion, 'codex-cli 0.166.0')
    const tasks = spec.tasks.map(task => ({ ...task, prompt: taskPrompt(task), promptSha256: hash(taskPrompt(task)) }))
    const protocol = {
      schemaVersion: 1, study: 'cross-package-agent-comparison-v1', phase: spec.phase,
      createdAt: new Date().toISOString(), status: 'frozen-before-agent-sessions',
      arms: Object.keys(spec.arms), candidates: spec.candidates, repeats: spec.repeats,
      runCount: tasks.length * spec.repeats * Object.keys(spec.arms).length, timeoutMs: spec.timeoutMs,
      tasks, prompts: makePrompts(tasks, spec), schedule: makeSchedule(tasks, Object.keys(spec.arms), spec.repeats),
      config: pairedConfig, cliVersion, codexBinary: resolvedCodexBinary(), decisionGate, reviewRules,
      toolUseQualification: { receiptSha256: hash(qualificationBytes), captureSha256: qualification.captureSha256 },
      supplementalOutputs: spec.supplementalOutputs, spec, specSha256: hash(readFileSync(specPath)), inputs,
      typelatchArchiveBinding: binding(spec),
      replaySelection: { task: tasks[0].id, repeat: 1, arms: ['native', spec.candidates[0]], rule: 'First task and repeat, fixed before outcomes. Retain failure and disclose accelerated replay.' },
      treatment: 'Same task and workflow policy with equal-format explicit provider inventory. First relevant investigation uses the declared provider where available; native uses ordinary tools. Compiler, language-service and package-manager tools remain available in every arm. Further tool choices are free. Edit tasks validate before and after; analysis tasks write the same structured report and preserve source.',
      timing: 'Sequential fresh sessions. Charge all provider preparation and agent wall time, including initialization, indexing, tool failures, fallback and validation. Common corpus copy/install/build preparation, independent grading and teardown are reported separately. Fresh provider state per run; OS file caches may be warm.',
      fixtureCopy: 'APFS copy-on-write clones with distinct inodes and isolated writes, not hardlinks. Exact file bytes, modes and symlink text are verified against the full frozen fixture inventory. Copy time is separately reported common preparation.',
      selection: 'Task categories were fixed before outcomes. Development cases may inform a later frozen candidate; they cannot establish an edge. Confirmation cases are held from candidate tuning. Any category edge requires a second distinct held-out task and two repetitions, all reported separately from development and earlier studies.',
      failurePolicy: 'Persist every preparation before work and every run before launch. No replacement or overwrite of failures. Resume only a completely recorded and cleaned prefix. Unknown usage or failed setup cannot pass.',
      evidencePolicy: 'Export only completed tool actions, returned tool outputs, explicit task artifacts, source changes and independently graded results. Never export model reasoning or assistant message bodies. Supplemental outputs bind raw capture and public evidence hashes. Workflow and usable provider evidence require a separate hash-bound independent review.',
      limits: ['Public upstream repairs may occur in model training data.', 'No immutable served model snapshot or sampling seed is available.', 'Cached input is included once within total input; tokens are not a billing estimate.', 'One frozen candidate per confirmation study; category hypotheses are exploratory multiple comparisons, not statistical confidence bounds.', 'Filesystem and no-network instructions are procedural; no additional OS isolation is claimed.'],
    }
    write(protocolPath, protocol)
    console.log(JSON.stringify({ status: 'frozen-no-agent-run', protocol: protocolPath, sha256: hash(readFileSync(protocolPath)), runs: protocol.runCount }))
    return
  }
  const protocolBytes = readFileSync(protocolPath), protocol = JSON.parse(protocolBytes), protocolSha256 = hash(protocolBytes)
  assert.deepEqual(protocol.spec, spec); assert.equal(protocol.specSha256, hash(readFileSync(specPath)))
  assert.deepEqual(protocol.config, pairedConfig); assert.deepEqual(protocol.decisionGate, decisionGate)
  assert.deepEqual(protocol.prompts, makePrompts(protocol.tasks, spec)); assert.deepEqual(protocol.schedule, makeSchedule(protocol.tasks, protocol.arms, protocol.repeats))
  verifyInputs(protocol.inputs); assert.deepEqual(binding(spec), protocol.typelatchArchiveBinding)
  const report = mode === '--resume' ? read(reportPath) : { schemaVersion: 1, protocol, protocolSha256, startedAt: new Date().toISOString(), complete: false, runs: [], preparationAttempts: [], machine: { platform: platform(), architecture: arch(), nodeVersion: process.version, processor: cpus()[0]?.model, logicalProcessors: cpus().length, memoryBytes: totalmem() } }
  if (mode === '--resume') assertResume(report, protocol, protocolSha256)
  else assert(!existsSync(reportPath), 'Use explicit resume to retain a prior study')
  const persist = () => { report.updatedAt = new Date().toISOString(); report.decision = evaluateDecision(report); write(reportPath, report) }
  persist()
  for (const slot of protocol.schedule) {
    if (report.runs.some(run => run.id === slot.id)) continue
    const arm = spec.arms[slot.arm], task = { ...protocol.tasks.find(task => task.id === slot.task), ...protocol.prompts.find(prompt => prompt.task === slot.task && prompt.arm === slot.arm) }, fixture = spec.fixtures[slot.task]
    const runRoot = join(output, 'runs', slot.id), workspace = join(runRoot, 'workspace'), state = join(runRoot, 'provider-state'), capture = join(runRoot, 'capture')
    const attempt = { ...slot, status: 'preparing', stage: 'fixture', startedAt: new Date().toISOString() }
    report.preparationAttempts.push(attempt); persist()
    let lifecycle = null, lifecycleModule = null, initial, baseline, fixtureGit, fixtureSetupMs, providerSetupMs = 0, run = null, preparation = []
    try {
      verifyInputs(protocol.inputs)
      assert(!existsSync(runRoot), 'No preparation attempt may overwrite an earlier attempt')
      mkdirSync(runRoot, { recursive: true }); mkdirSync(state)
      const commonStart = performance.now()
      cpSync(fixture.workspace, workspace, { recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE_FORCE })
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
      Object.assign(run, { startedAt: recorded.startedAt, finishedAt: recorded.finishedAt, elapsedMs: recorded.elapsedMs, exitCode: recorded.exitCode, timedOut: recorded.timedOut, processGroupStopped: recorded.processGroupStopped, recordingError: recorded.recordingError, rawSha256: recorded.rawSha256, capture: evidence.capture, counts: evidence.counts, usage: evidence.usage, nativeValidation: task.mode === 'edit' ? validationObservation(recorded.raw, task.publicCases) : null, providerCallObserved: evidence.actions.some(a => a.type === 'mcp_tool_call' && Object.keys(arm.servers).includes(a.server) && !['initial_instructions', 'activate_project', 'library_feedback', 'library_stats'].includes(a.tool)), providerUsed: null, workflowReviewed: null, status: recorded.exitCode === 0 && !recorded.timedOut && evidence.capture.complete ? 'completed' : 'failed' })
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
    const taskArtifacts = []
    if (task.answerFile) {
      const answerPath = join(workspace, task.answerFile)
      if (existsSync(answerPath) && lstatSync(answerPath).isFile()) {
        const bytes = readFileSync(answerPath)
        assert(bytes.length <= 1024 * 1024, 'Task answer exceeds the frozen publication bound')
        taskArtifacts.push({ path: task.answerFile, sha256: hash(bytes), bytes: bytes.length, text: bytes.toString('utf8') })
      }
    }
    const replacements = [[workspace, '$WORKSPACE'], [state, '$PROVIDER_STATE'], [output, '$STUDY'], [repository, '$REPOSITORY'], [homedir(), '$USER_HOME'], [tmpdir().replace(/\/$/u, ''), '$TEMP']]
    const publicRecord = normalizeDemo({ schemaVersion: 1, run, prompt: task.prompt, actions: evidence.actions, requestedConfig: recorded?.config ?? null, grading, changes, taskArtifacts, recording: 'Allowlisted completed public actions, explicit requested task artifacts, independent grading, final changes and measured usage. No reasoning or assistant message bodies.' }, replacements)
    const recordBytes = JSON.stringify(publicRecord, null, 2) + '\n'
    assert(!/\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//u.test(recordBytes), 'Public artifact contains an unnormalized private path')
    writeFileSync(join(runRoot, 'public-evidence.json'), recordBytes, { mode: 0o600 }); run.evidenceSha256 = hash(recordBytes); persist()
    if (recorded?.raw && run.rawSha256) {
      const extractor = await import(pathToFileURL(spec.supplementalOutputs.extractor).href)
      const supplement = extractor.extractToolOutputs({ raw: recorded.raw, publicRecordBytes: recordBytes, expectedPublicRecordSha256: run.evidenceSha256, replacements })
      const supplementBytes = JSON.stringify(supplement, null, 2) + '\n'
      writeFileSync(join(runRoot, spec.supplementalOutputs.fileName), supplementBytes, { flag: 'wx', mode: 0o600 })
      run.toolOutputsSha256 = hash(supplementBytes); persist()
    }
    console.log(JSON.stringify({ event: 'recorded', ...slot, correct: run.correct, elapsedMs: run.elapsedMs, providerSetupMs, usage: run.usage, counts: run.counts }))
    verifyInputs(protocol.inputs)
  }
  report.complete = report.runs.length === protocol.schedule.length; report.finishedAt = new Date().toISOString(); persist()
  console.log(JSON.stringify({ event: 'complete', report: reportPath, decision: report.decision }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
