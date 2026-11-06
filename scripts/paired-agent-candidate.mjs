import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, platform, arch, cpus, totalmem, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { list as listTar } from 'tar'
import { tasks, prepareTask, gradeTask } from './paired-agent-fixtures.mjs'
import { extractPairedEvents, summarizePairedRuns } from './paired-agent-evidence.mjs'
import { normalizeDemo } from './demo-evidence.mjs'
import { hash, pairedConfig, runAgent, writeJson } from './paired-agent-runner.mjs'
import { freezeInputs, frozenInputDigest, inventoryTree, verifyFrozenInputs } from './paired-agent-integrity.mjs'
import { comparisonManifest, assertComparableFixtures } from './paired-agent-comparison.mjs'
import { decisionGate, evaluateDecision } from './paired-agent-decision.mjs'

export function verifyCandidateArchive({ archive, runtime, name, version, sha256, integrity }) {
  const archiveBytes = readFileSync(archive)
  assert.equal(hash(archiveBytes), sha256, 'Candidate archive hash mismatch')
  assert.equal('sha512-' + createHash('sha512').update(archiveBytes).digest('base64'), integrity, 'Candidate archive integrity mismatch')
  const entries = new Map(), paths = new Set()
  listTar({ file: archive, sync: true, strict: true, onReadEntry(entry) {
    const path = entry.path.replace(/\/+$/u, '')
    assert(path === 'package' || path.startsWith('package/'), 'Archive entry must be inside the package root')
    assert(!path.includes('\\') && !path.includes('\0') && path.split('/').every(part => part && part !== '.' && part !== '..'), 'Archive entry has an unsafe path')
    assert(!paths.has(path), 'Archive contains duplicate paths')
    paths.add(path)
    if (entry.type === 'Directory') return
    assert.equal(entry.type, 'File', 'Candidate archive must contain regular files, not links or special entries')
    assert(path.startsWith('package/'), 'Archive file must be inside the package root')
    const digest = createHash('sha256'); let size = 0
    entry.on('data', chunk => { digest.update(chunk); size += chunk.length })
    entry.on('end', () => {
      assert.equal(size, entry.size, 'Archive file size mismatch')
      entries.set(path.slice('package/'.length), { bytes: size, sha256: digest.digest('hex') })
    })
  } })
  assert(entries.size > 0 && entries.has('package.json'), 'Candidate archive must contain its package manifest')
  const installed = inventoryTree(runtime, { excludeDirectories: ['node_modules'] })
  assert(installed.entries.every(entry => entry.kind === 'file' || entry.kind === 'directory'), 'Installed candidate must contain regular files, not links')
  const files = installed.entries.filter(entry => entry.kind === 'file').map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const expected = [...entries].map(([path, value]) => ({ path, ...value })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert.deepEqual(files, expected, 'Candidate archive and installed package files must match exactly')
  const manifest = JSON.parse(readFileSync(join(runtime, 'package.json')))
  assert.equal(manifest.name, name, 'Candidate package name mismatch')
  assert.equal(manifest.version, version, 'Candidate package version mismatch')
  return { archiveSha256: sha256, archiveIntegrity: integrity, packageFileCount: files.length, packageTreeSha256: hash(JSON.stringify(files)) }
}

export const restoredSqliteInput = Object.freeze({
  name: 'trustedDependencies:sqlite/node_modules',
  originalSha256: 'ace86a92aa8177c1fce8d54cf6ade5b7c8590b23c11dee45a35a50669091db1b',
  restoredSha256: '5f12a9177d48af0b50407cb9a5621f396bdf3d5e18cfe938f99429ce6c04fc40',
  reconstructedOriginalSha256: 'ace86a92aa8177c1fce8d54cf6ade5b7c8590b23c11dee45a35a50669091db1b',
  rule: 'The restored checkout moved from release-030 to typelatch-research. An in-memory replacement of that exact checkout prefix in only these two generated files reproduced the original full tree digest. No dependency files were modified. Current bytes are frozen separately and no other restoration difference is allowed.',
  files: [
    { path: 'better-sqlite3/build/Makefile', replacements: 2, restoredSha256: '8a4b9683320581c3859d581df934b8f757b34da6d94941bbd1c2becfeb76fd43', reconstructedOriginalSha256: '17be17205d35997ec0b9d539dc360b82efadc108ec9233afab8fe10c17ec271c' },
    { path: 'better-sqlite3/build/config.gypi', replacements: 1, restoredSha256: '04168bb5fde448c13963f95d466ee64b0f8493f03f52d89daca3a007ba350570', reconstructedOriginalSha256: '26af977ad0c3bf2c06e2777bfa0cfaf15fb1d11a8d799f2a3425bd2cc9543535' },
  ],
})

export function assertOriginalStudyInputs(frozen, previous) {
  const original = previous.frozenInputs
  assert(original, 'Original study must include frozen input identities')
  const shared = inputs => inputs.filter(item => item.name !== 'installedTypelatchAndDependencies')
  const actual = shared(frozen.manifests), expected = shared(original.manifests), restorations = []
  assert.deepEqual(actual.map(item => item.name), expected.map(item => item.name), 'Candidate fixture inventory names must match the original study')
  for (const [index, manifest] of actual.entries()) {
    if (manifest.sha256 === expected[index].sha256) continue
    const exception = restoredSqliteInput
    assert(manifest.name === exception.name && manifest.sha256 === exception.restoredSha256 && expected[index].sha256 === exception.originalSha256, 'Candidate fixtures and trusted grader dependencies must match the original study except the exact recorded SQLite restoration')
    for (const file of exception.files) assert(manifest.entries?.some(entry => entry.path === file.path && entry.kind === 'file' && entry.sha256 === file.restoredSha256), 'SQLite restoration file must match its recorded bytes')
    restorations.push(exception)
  }
  for (const file of original.files) {
    if (file.name === 'harness:paired-agent-use.mjs') continue
    const actual = frozen.files.find(candidate => candidate.name === file.name)
    assert(actual && actual.sha256 === file.sha256 && actual.bytes === file.bytes, `Reused input must match the original study: ${file.name}`)
  }
  return restorations
}

export function assertResumeIdentity(prior, protocolSha256, frozenInputsDigest) {
  assert.equal(prior.protocolSha256, protocolSha256, 'Resume cannot change the frozen protocol')
  assert.equal(prior.frozenInputs?.digest, frozenInputsDigest, 'Resume cannot change frozen inputs or mix candidates')
}

export function assertResumePreparation(prior) {
  assert(Array.isArray(prior.preparationAttempts), 'Resume requires a preparation ledger')
  assert.equal(prior.preparationAttempts.length, prior.runs.length, 'Resume cannot retry an unmatched preparation attempt')
  for (const [index, attempt] of prior.preparationAttempts.entries()) {
    assert(attempt.status === 'ready' && attempt.id === prior.runs[index].id, 'Resume cannot retry failed or interrupted preparation')
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '..')
  const extra = process.argv.slice(3)
  assert(extra.length === 0 || (extra.length === 2 && extra[0] === '--output-directory'), 'Optional argument: --output-directory PATH')
  const studyDirectory = extra.length ? resolve(extra[1]) : join(root, 'docs/benchmarks/typelatch-040-candidate')
  mkdirSync(studyDirectory, { recursive: true })
  const protocolPath = join(studyDirectory, 'paired-agent-protocol.json')
  const reportPath = join(studyDirectory, 'paired-agent.json')
  const candidateRoot = join(root, 'artifacts/paired-agent/candidate')
  const candidatePath = join(candidateRoot, 'artifact.json')
  const candidate = JSON.parse(readFileSync(candidatePath))
  assert.equal(candidate.name, 'typelatch')
  assert.equal(candidate.version, '0.4.0')
  assert.equal(candidate.source, 'packed checkout candidate')
  assert.equal(candidate.tarball, basename(candidate.tarball))
  const candidateArchive = join(candidateRoot, candidate.tarball)
  assert.equal(hash(readFileSync(candidateArchive)), candidate.sha256, 'Candidate archive bytes must match the manifest')
  const runtime = join(candidateRoot, 'runtime/node_modules/typelatch')
  const toolPackage = `${candidate.name}@${candidate.version}`
  const previousProtocolPath = join(root, 'docs/benchmarks/typelatch-use/paired-agent-protocol.json')
  const previousReportPath = join(root, 'docs/benchmarks/typelatch-use/paired-agent.json')
  const frozenPath = join(root, `artifacts/paired-agent/frozen-inputs-${hash(studyDirectory).slice(0, 12)}.json`)
  const commonPrompt = '\n\nWork only in this isolated project. Inspect the available source and dependency APIs using whichever available tools you judge useful. Make a minimal fix in existing implementation source files. Do not change tests, dependencies, package files, configuration, or documentation, and do not add files. You may run the existing npm test and npm run build commands. Check the result with the existing tests. Do not access files outside this project, use the network, install packages, make commits, or delegate work. Report the fix and any remaining failures.\n\nFollow this workflow in either condition: first discover relevant source with workspace_search using detail source when that tool is available, otherwise use native file and search tools. Before editing, inspect relevant installed dependency APIs with workspace_context or library_symbol when available, otherwise read installed declarations. Run the existing tests before and after the fix using workspace_validate when available, otherwise use the native shell. If a Typelatch tool fails, you may fall back to native tools and report that failure.'

  function command(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 10_000_000, ...options })
    assert.equal(result.status, 0, `${command} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  const publicComparison = comparison => ({ rawManifestSha256: comparison.rawManifestSha256, comparisonSha256: comparison.comparisonSha256, normalizations: comparison.normalizations.map(({ aliases, ...row }) => ({ ...row, aliasReplacementCounts: aliases.map(alias => alias.replacements) })) })

  function freezeStudyInputs() {
    const frozen = freezeInputs(root, runtime)
    frozen.restorationDifferences = assertOriginalStudyInputs(frozen, JSON.parse(readFileSync(previousReportPath)))
    const bytes = readFileSync(import.meta.filename)
    frozen.files.push({ name: 'harness:paired-agent-candidate.mjs', path: import.meta.filename, bytes: bytes.length, mode: statSync(import.meta.filename).mode & 0o777, sha256: hash(bytes) })
    for (const [name, path] of [['candidateManifest', candidatePath], ['candidateArchive', candidateArchive], ['previousProtocol', previousProtocolPath], ['previousReport', previousReportPath], ['harness:paired-agent-decision.mjs', join(root, 'scripts/paired-agent-decision.mjs')]]) {
      const bytes = readFileSync(path)
      frozen.files.push({ name, path, bytes: bytes.length, mode: statSync(path).mode & 0o777, sha256: hash(bytes) })
    }
    frozen.digest = frozenInputDigest(frozen)
    return frozen
  }

  function makeProtocol() {
    const schedule = []
    for (let repeat = 1; repeat <= 2; repeat++) {
      for (const [taskIndex, task] of tasks.entries()) {
        const arms = (taskIndex + repeat) % 2 ? ['baseline', 'typelatch'] : ['typelatch', 'baseline']
        for (const arm of arms) schedule.push({ id: `${task.id}-${repeat}-${arm}`, task: task.id, repeat, arm })
      }
    }
    return {
      schemaVersion: 1, study: 'explicit-tool-use', frozenAt: new Date().toISOString(), model: pairedConfig.model, reasoningEffort: pairedConfig.model_reasoning_effort,
      repeats: 2, taskCount: tasks.length, runCount: schedule.length, toolPackage, candidate, previousProtocolSha256: hash(readFileSync(previousProtocolPath)), timeoutMs: 600_000,
      conditions: { baseline: 'Native Codex tools without any MCP server', typelatch: 'The same native tools plus all seven Typelatch MCP tools; source discovery, API inspection and validation use MCP when available' },
      promptPolicy: 'Identical task and workflow prompt in both conditions. Both discover source, inspect installed APIs, and run tests before and after editing. The prompt requires Typelatch tools when available and native equivalents otherwise. It does not discourage grep or prescribe the code solution.',
      tasks: tasks.map(task => ({ ...task, prompt: task.prompt + commonPrompt, promptSha256: hash(task.prompt + commonPrompt) })),
      schedule, config: pairedConfig, decisionGate,
      timing: 'Sequential sessions on one machine. Agent time is monotonic time from spawning Codex to process close, including MCP startup and tool execution. The decision gate charges agent time plus Typelatch index setup time. Common fixture preparation and independent grading are excluded. Each time component is reported separately. Package installation into the shared benchmark runtime is outside the gate.',
      preparation: 'Fresh workspace and own installed dependencies each run. Fresh Typelatch home and package indexes prepared with sync only for the Typelatch condition. Source search cache starts cold. Dependency download and OS caches may be warm. Provider prompt caching is not disabled; cached input is reported.',
      fixtureComparison: 'Normalize only exact workspace paths in the two generated better-sqlite3 build metadata files. Preserve original inventory digests and require every other source and dependency byte to match.',
      correctness: 'Independent grader after the agent exits, using protected fixture checks and trusted tests outside the agent workspace. A self reported success does not count as correctness.',
      selection: 'Three authored, known exercises selected before any scored run: the existing SQLite showcase plus two larger Parcel Desk tasks. Two repeats per condition. Fixed counterbalanced order, no session reuse. No run is removed for a poor result or failure to follow the tool policy. No performance tuning after scored runs begin.',
      failurePolicy: 'Every preparation attempt and scheduled launch is retained. Failed or interrupted preparation cannot be retried in the same study. No automatic replacement or selective rerun. Missing usage is unknown, not zero. Infrastructure preflights contain no benchmark task and are excluded. A run interrupted before metrics complete remains visible.',
      limits: ['A small authored local sample, not an unseen production benchmark or a causal estimate for all coding work.', 'Requested model alias and reasoning setting are pinned; an immutable served model snapshot and sampling seed are not available.', 'Input tokens include cached input and repeated context. Total tokens are input plus output; cached and reasoning tokens are subsets, not extra tokens.', 'Search counts describe recorded native shell tool calls, not every operating system process or every form of text search. MCP calls are reported separately.', 'Workspace instructions and file hashes are integrity controls, not proof of complete operating system isolation.'],
      accountingSource: 'Codex CLI turn.completed usage; https://learn.chatgpt.com/docs/non-interactive-mode',
      animation: 'Replay the first SQLite pair, selected before scoring, regardless of outcome. Show actual public actions at recorded JSONL receipt times. Separate sessions align at their start and playback is accelerated. This is a rendered action replay, not a screen recording.',
    }
  }

  if (process.argv[2] === '--freeze') {
    assert(!existsSync(protocolPath), 'Do not overwrite a frozen protocol')
    const archiveBinding = verifyCandidateArchive({ ...candidate, archive: candidateArchive, runtime })
    const frozen = freezeStudyInputs()
    writeJson(frozenPath, frozen)
    const protocol = makeProtocol()
    const previous = JSON.parse(readFileSync(previousProtocolPath))
    assert.deepEqual(protocol.tasks, previous.tasks, 'Candidate must use the same tasks and exact prompts')
    assert.deepEqual(protocol.schedule, previous.schedule, 'Candidate must use the same counterbalanced order')
    assert.deepEqual(protocol.config, previous.config, 'Candidate must use the same model settings')
    writeJson(protocolPath, { ...protocol, archiveBinding, restorationDifferences: frozen.restorationDifferences, frozenInputsDigest: frozen.digest })
    console.log('Frozen paired benchmark protocol without running tasks')
  } else {
    const resuming = process.argv[2] === '--resume'
    assert(resuming || process.argv[2] === '--run', 'Usage: node scripts/paired-agent-candidate.mjs --freeze|--run|--resume')
    assert(existsSync(protocolPath) && (resuming ? existsSync(reportPath) : !existsSync(reportPath)), 'Freeze first; use explicit resume to retain a partial study')
    const protocolBytes = readFileSync(protocolPath), protocol = JSON.parse(protocolBytes)
    const frozen = JSON.parse(readFileSync(frozenPath))
    assert.equal(frozen.digest, protocol.frozenInputsDigest)
    verifyFrozenInputs(frozen)
    assert.deepEqual(assertOriginalStudyInputs(frozen, JSON.parse(readFileSync(previousReportPath))), protocol.restorationDifferences, 'Restoration provenance must match the frozen protocol')
    assert.deepEqual(verifyCandidateArchive({ ...candidate, archive: candidateArchive, runtime }), protocol.archiveBinding, 'Installed archive binding must match the frozen protocol')
    assert.deepEqual(protocol.decisionGate, decisionGate, 'Decision gate must match the frozen protocol')
    assert.deepEqual(protocol.config, pairedConfig, 'Runner settings must match the frozen protocol')
    assert.equal(JSON.parse(readFileSync(join(runtime, 'package.json'))).version, candidate.version)
    const cliVersion = command('codex', ['--version'])
    const packageMetadata = { tarball: candidate.tarball, integrity: candidate.integrity, sha256: candidate.sha256, source: candidate.source, sourceCommit: candidate.sourceCommit }
    const packageManifestSha256 = hash(readFileSync(join(runtime, 'package.json')))
    const sourceCommit = command('git', ['rev-parse', 'HEAD'], { cwd: root })
    const prior = resuming ? JSON.parse(readFileSync(reportPath)) : null
    if (prior) {
      assertResumeIdentity(prior, hash(protocolBytes), frozen.digest)
      assertResumePreparation(prior)
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
    const harnessFiles = ['scripts/paired-agent-candidate.mjs', 'scripts/paired-agent-decision.mjs', 'scripts/paired-agent.mjs', 'scripts/paired-agent-runner.mjs', 'scripts/paired-agent-evidence.mjs', 'scripts/paired-agent-fixtures.mjs', 'scripts/paired-agent-integrity.mjs', 'scripts/paired-agent-comparison.mjs']
    const harness = harnessFiles.map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }))
    const report = { schemaVersion: 1, startedAt: new Date().toISOString(), capturedAt: null, protocol, protocolSha256: hash(protocolBytes), sourceCommit, cliVersion, toolPolicy: 'MCP when available; native equivalents otherwise', package: { identity: toolPackage, manifestSha256: packageManifestSha256, dist: packageMetadata }, machine: { platform: platform(), architecture: arch(), nodeVersion: process.version, processor: cpus()[0]?.model, logicalProcessors: cpus().length, memoryBytes: totalmem() }, harness, frozenInputs: { digest: frozen.digest, manifests: frozen.manifests.map(({name,sha256,entries}) => ({name,sha256,entries:entries.length})), files: frozen.files.map(({name,sha256,bytes})=>({name,sha256,bytes})) }, tasks: protocol.tasks.map(({ id, title }) => ({ id, title })), runs: [], summary: summarizePairedRuns([]), complete: false }
    report.fixtureComparisons = {}
    report.preparationAttempts = prior?.preparationAttempts ?? []
    const comparisons = new Map()
    if (prior) {
      report.startedAt = prior.startedAt
      report.runs = prior.runs
      report.captureRevisions = [...(prior.captureRevisions ?? [{ sourceCommit: prior.sourceCommit, protocolSha256: prior.protocolSha256, frozenInputs: prior.frozenInputs, runIds: prior.runs.map(run => run.id) }]), { sourceCommit, protocolSha256: report.protocolSha256, frozenInputs: report.frozenInputs, runIds: protocol.schedule.slice(prior.runs.length).map(run => run.id) }]
      for (const run of prior.runs) {
        const candidates = readdirSync(join(root, 'artifacts/paired-agent')).filter(name => name.startsWith('scored-')).map(name => join(root, 'artifacts/paired-agent', name, run.id, 'before.json')).filter(existsSync).filter(path => { const value = JSON.parse(readFileSync(path)); return hash(value.prompt) === run.promptSha256 && value.prepared.fixtureSha256 === run.fixtureSha256 })
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
    const persist = () => { report.summary = summarizePairedRuns(report.runs); report.capturedAt = new Date().toISOString(); writeJson(reportPath, report) }
    for (const scheduled of protocol.schedule) {
      if (report.runs.some(run => run.id === scheduled.id)) continue
      console.log(JSON.stringify({ event: 'preparing', ...scheduled }))
      const task = protocol.tasks.find(task => task.id === scheduled.task)
      const attempt = { ...scheduled, status: 'preparing', stage: 'fixture', startedAt: new Date().toISOString(), finishedAt: null }
      report.preparationAttempts.push(attempt); persist()
      let workspace, prepared, sourceBefore, setupMs, output, indexSetupMs = 0, preparation = null
      try {
        workspace = mkdtempSync(join(tmpdir(), 'typelatch-paired-'))
        prepared = await prepareTask(task.id, workspace)
        assert.equal(prepared.baseline.passed, false, 'An unfixed task must fail its correctness gate')
        attempt.stage = 'fixture-identity'; persist()
        const comparison = comparisonManifest(prepared.files, workspace)
        if (comparisons.has(task.id)) assertComparableFixtures(comparisons.get(task.id), comparison)
        else comparisons.set(task.id, comparison)
        report.fixtureComparisons[scheduled.id] = publicComparison(comparison)
        sourceBefore = Object.fromEntries(prepared.files.filter(file => file.path === 'batch.ts' || /^src\/.+\.ts$/u.test(file.path)).map(file => [file.path, readFileSync(join(workspace, file.path), 'utf8')]))
        setupMs = prepared.setupMs
        if (scheduled.arm === 'typelatch') {
          attempt.stage = 'index'; persist()
          const start = performance.now()
          const indexed = spawnSync(process.execPath, [join(runtime, 'dist/cli.js'), 'sync', '--json'], { cwd: workspace, env: { ...process.env, TYPELATCH_HOME: join(workspace, '.typelatch'), TYPELATCH_USAGE: 'off' }, encoding: 'utf8', timeout: 180_000, maxBuffer: 15_000_000 })
          indexSetupMs = performance.now() - start
          attempt.indexSetupMs = indexSetupMs
          attempt.indexExitCode = indexed.status
          preparation = { exitCode: indexed.status, result: JSON.parse(indexed.stdout), stderr: indexed.stderr }
          assert.equal(indexed.status, 0, 'Typelatch index preparation must complete before a scored launch')
          assert.equal(preparation.result.success, true)
        }
        attempt.stage = 'prelaunch-record'; persist()
        output = join(captureRoot, scheduled.id)
        mkdirSync(output, { recursive: true })
        writeJson(join(output, 'before.json'), { scheduled, prepared, preparation, prompt: task.prompt })
      } catch (error) {
        attempt.status = 'failed'; attempt.finishedAt = new Date().toISOString()
        attempt.error = { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null }
        report.decision = evaluateDecision(report); persist()
        throw error
      }
      const normalize = value => normalizeDemo(value, [[workspace, '$WORKSPACE'], [root, '$REPOSITORY'], [homedir(), '$USER_HOME'], [process.execPath, '$NODE']])
      const empty = extractPairedEvents('')
      const run = { ...scheduled, startedAt: new Date().toISOString(), finishedAt: null, elapsedMs: null, setupMs, indexSetupMs, gradingMs: null, status: 'running', exitCode: null, timedOut: null, processGroupStopped: null, correct: null, usage: empty.usage, counts: empty.counts, capture: empty.capture, fixtureSha256: prepared.fixtureSha256, promptSha256: task.promptSha256, rawSha256: null, evidence: `paired-agent-runs/${scheduled.id}.json` }
      // Persist before launch so no later grading or export failure can erase an attempt.
      report.runs.push(run)
      attempt.status = 'ready'; attempt.stage = 'launch'; attempt.finishedAt = new Date().toISOString()
      persist()
      let stage = 'launch', started, evidence = empty, grading = null, changes = []
      try {
        started = await runAgent({ workspace, prompt: task.prompt, output, packageRoot: scheduled.arm === 'typelatch' ? runtime : null, timeoutMs: protocol.timeoutMs })
        stage = 'accounting'; evidence = extractPairedEvents(started.raw)
        if (started.recordingError) { evidence.capture.complete = false; evidence.capture.issues.push({ code: 'recorder-error' }) }
        evidence.actions = evidence.actions.map(action => ({ ...action, startedMs: started.timing.find(event => event.type === 'item.started' && event.itemIdHash === action.idSha256)?.elapsedMs ?? null, completedMs: started.timing.find(event => event.type === 'item.completed' && event.itemIdHash === action.idSha256)?.elapsedMs ?? null }))
        Object.assign(run, { startedAt: started.startedAt, finishedAt: started.finishedAt, elapsedMs: started.elapsedMs, status: started.exitCode === 0 && !started.timedOut && evidence.capture.complete ? 'completed' : 'failed', exitCode: started.exitCode, timedOut: started.timedOut, processGroupStopped: started.processGroupStopped, recordingError: started.recordingError, usage: evidence.usage, counts: evidence.counts, capture: evidence.capture, rawSha256: started.rawSha256 })
        run.toolPolicyFollowed = scheduled.arm === 'baseline' ? evidence.counts.mcpCalls === 0 : evidence.counts.mcpSucceeded > 0
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
    report.decision = evaluateDecision(report)
    report.finishedAt = report.capturedAt = new Date().toISOString(); writeJson(reportPath, report)
    console.log(JSON.stringify({ event: 'complete', report: reportPath, summary: report.summary }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
