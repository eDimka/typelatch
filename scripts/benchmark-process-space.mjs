import { createHash } from 'node:crypto'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { arch, freemem, loadavg, platform, release, totalmem, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// macOS ps reports RSS in KiB. This deliberately does not claim unique physical memory.
if (platform() !== 'darwin') throw new Error('This sampler has only been validated with macOS ps')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidate = resolve(process.env.TYPELATCH_CANDIDATE ?? repo)
const codegraph = process.env.CODEGRAPH_BIN
const python = process.env.GRAPHIFY_PYTHON
if (!codegraph || !python) throw new Error('Set CODEGRAPH_BIN and GRAPHIFY_PYTHON to isolated pinned installations')
const smoke = process.argv.includes('--smoke')
const rounds = smoke ? 1 : 3
const lateIdleMs = smoke ? 1500 : 32_000
const destination = resolve(process.env.PROCESS_SPACE_REPORT ?? join(repo, `docs/benchmarks/process-space${smoke ? '-smoke' : ''}.json`))
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'typelatch-process-space-')))
const artifactRoot = join(repo, 'artifacts/competitive/process-space', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(artifactRoot, { recursive: true })
const run = promisify(execFile)
const sha = value => createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const median = values => { const v = [...values].sort((a, b) => a - b); return v.length ? (v[Math.floor(v.length / 2)] + v[Math.floor((v.length - 1) / 2)]) / 2 : null }
function files(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : []
  }).sort()
}
function manifest(root) { return files(root).map(path => ({ path: relative(root, path), bytes: lstatSync(path).size, sha256: sha(readFileSync(path)) })) }
function treeIdentity(root) { const entries = manifest(root); return { root, files: entries.length, bytes: entries.reduce((sum, row) => sum + row.bytes, 0), sha256: sha(JSON.stringify(entries)), entries } }
function fileIdentity(path) { const actualPath = realpathSync(path); return { path, actualPath, bytes: lstatSync(actualPath).size, sha256: sha(readFileSync(actualPath)) } }
function footprint(root) { return files(root).reduce((sum, path) => sum + lstatSync(path).size, 0) }
function isolatedEnv(base, index) {
  const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_DOWNLOAD: '1', GRAPHIFY_QUERY_LOG_DISABLE: '1', GRAPHIFY_NO_AUTO_REFRESH: '1', PYTHONDONTWRITEBYTECODE: '1', TYPELATCH_USAGE: 'off', TYPELATCH_HOME: index }).filter(([, value]) => value !== undefined))
  env.HOME = join(base, 'home')
  env.XDG_CONFIG_HOME = join(base, 'config')
  env.XDG_CACHE_HOME = join(base, 'cache')
  mkdirSync(env.HOME, { recursive: true })
  return env
}
async function processTable() {
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss=,state=,comm='], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 })
  return stdout.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) throw new Error(`Unparsed ps row: ${line}`)
    return { pid: +match[1], ppid: +match[2], pgid: +match[3], rssBytes: +match[4] * 1024, state: match[5], command: match[6] }
  })
}
function descendants(table, root, known = new Set()) {
  const selected = new Set([root, ...known])
  let changed = true
  while (changed) {
    changed = false
    for (const row of table) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true }
  }
  const result = table.filter(row => selected.has(row.pid))
  for (const row of result) known.add(row.pid)
  return result
}
function sampler(getPid, getPhase) {
  const samples = [], errors = [], known = new Set()
  const started = performance.now()
  let stopped = false, timer, pending = Promise.resolve()
  async function take() {
    const rootPid = getPid()
    if (rootPid === null || rootPid === undefined) return
    const sampledAt = performance.now(), sampledPhase = getPhase()
    try {
      const table = await processTable()
      const rows = descendants(table, rootPid, known)
      samples.push({ elapsedMs: sampledAt - started, durationMs: performance.now() - sampledAt, phase: sampledPhase, rootPid, rootPresent: rows.some(row => row.pid === rootPid), processCount: rows.length, rssBytes: rows.reduce((sum, row) => sum + row.rssBytes, 0), processes: rows })
    } catch (error) { errors.push({ elapsedMs: sampledAt - started, phase: sampledPhase, error: error.message }) }
  }
  function tick() {
    pending = take().finally(() => { if (!stopped) timer = setTimeout(tick, ['startup', 'query', 'setup'].includes(getPhase()) ? 25 : 200) })
  }
  tick()
  return { samples, errors, known, take, async stop() { stopped = true; clearTimeout(timer); await pending; samples.sort((a, b) => a.elapsedMs - b.elapsedMs) } }
}
function summarize(samples, errors) {
  const stages = Object.fromEntries([...new Set(samples.map(row => row.phase))].map(phase => {
    const rows = samples.filter(row => row.phase === phase)
    return [phase, { samples: rows.length, medianRssBytes: median(rows.map(row => row.rssBytes)), sampledMaximumRssBytes: Math.max(...rows.map(row => row.rssBytes)), minimumRssBytes: Math.min(...rows.map(row => row.rssBytes)), maximumProcessCount: Math.max(...rows.map(row => row.processCount)), rootAbsentSamples: rows.filter(row => !row.rootPresent).length }]
  }))
  return { sampledMaximumRssBytes: samples.length ? Math.max(...samples.map(row => row.rssBytes)) : null, sampleCount: samples.length, sampleErrorCount: errors.length, maximumSampleGapMs: samples.length > 1 ? Math.max(...samples.slice(1).map((row, index) => row.elapsedMs - samples[index].elapsedMs)) : null, stages }
}
async function capture(command, args, cwd, env, measured = false) {
  const started = performance.now()
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', spawnError
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const sampling = measured ? sampler(() => child.pid, () => 'setup') : null
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  const result = await new Promise(resolve => {
    child.on('error', error => { spawnError = error.message })
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  if (sampling) await sampling.stop()
  return { command, args, status: result.code === 0 && !spawnError ? 'ok' : 'error', ...result, ...(spawnError ? { error: spawnError } : {}), elapsedMs: performance.now() - started, stdout, stderr, ...(sampling ? { memory: summarize(sampling.samples, sampling.errors), samples: sampling.samples, samplingErrors: sampling.errors } : {}) }
}
function textOf(output) { return output.content?.filter(row => row.type === 'text').map(row => row.text).join('\n') ?? '' }
function request(provider, root, question) {
  return provider === 'typelatch' ? { name: 'workspace_search', arguments: { workspaceRoot: root, question, scope: 'workspace', limit: 8, detail: 'compact' } }
    : provider === 'codegraph' ? { name: 'codegraph_explore', arguments: { query: question, maxFiles: 8, projectPath: root } }
    : { name: 'query_graph', arguments: { question, token_budget: 2000 } }
}
const report = {
  schemaVersion: 1, kind: 'Sampled macOS process tree RSS for three local MCP providers', smoke, complete: false, startedAt: new Date().toISOString(),
  runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), directory,
  environment: { platform: platform(), architecture: arch(), kernel: release(), node: process.version, totalMemoryBytes: totalmem(), backgroundActivity: 'Host is not dedicated. Other desktop applications and short validation commands may run. No time advantage is claimed.' },
  protocol: { rounds, providerOrderRotation: ['typelatch,codegraph,graphify', 'codegraph,graphify,typelatch', 'graphify,typelatch,codegraph'], prepareIndexBeforeMeasuredServer: true, preQueryBaselineMs: 1000, retainedIdleStartMs: 250, retainedIdleEndMs: 2000, lateIdleWindowStartMs: lateIdleMs - 1000, lateIdleWindowEndMs: lateIdleMs, fastSamplingDelayMs: 25, idleSamplingDelayMs: 200, root: 'MCP transport PID including npm launcher and every observed descendant', typelatchDetail: 'compact', queryCountPerMeasuredServer: 1 },
  corpora: {}, identities: {}, sessions: [], summary: {},
  limitations: [
    'RSS is resident pages mapped into each process. Summing a process tree can count shared pages more than once. It is not unique physical memory, proportional set size, memory pressure, or reclaimable memory.',
    'Maximum means the greatest observed sample, not a true peak. Sampling can miss short lived processes and allocation spikes. Raw samples include actual gaps and ps duration.',
    'A root PID and recursively observed descendants define ownership. Detached observed descendants remain tracked. A daemon that detaches before any sample may be missed. No daemon mode is requested.',
    'Operating system caches are not purged. Each server is fresh and each index is prepared in a separate setup process. The first measured query therefore reads an existing index.',
    'Three rotated rounds on two authored corpora are descriptive observations. One shared machine and a small number of rounds do not establish statistical or universal superiority.',
    'Each provider returns different context. A matching source path is a retrieval access control, not proof of equivalent source completeness or completed code behavior.',
    'Graphify uses local code only extraction without clustering or model calls. Setup, installation files and runtime disk footprint are separate from serving RSS.',
    'The controller, ps sampler and unrelated processes are excluded from provider sums. Background host activity is uncontrolled and can affect residency.',
    'Captured RSS and source path controls do not measure model token use or agent outcome quality. Error and empty responses are not counted as successful low memory retrievals.'
  ]
}
const raw = { report, identities: {}, sessions: [] }
function save() { mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, JSON.stringify(report, null, 2) + '\n') }

// The frozen candidate points at the shared checkout's node_modules. Copy it so later installs cannot change this experiment.
const executableRoot = join(directory, 'typelatch-runtime')
mkdirSync(executableRoot)
for (const path of ['dist', 'package.json', 'package-lock.json']) cpSync(join(candidate, path), join(executableRoot, path), { recursive: true })
cpSync(realpathSync(join(candidate, 'node_modules')), join(executableRoot, 'node_modules'), { recursive: true })
const setupEnv = isolatedEnv(join(directory, 'identity'), join(directory, 'identity/data'))
const graphPackageRoot = dirname(realpathSync(codegraph))
const graphNodeModules = resolve(graphPackageRoot, '../..')
const pythonDescription = await capture(python, ['-c', 'import sys,sysconfig,json,importlib.metadata as m; print(json.dumps({"version":m.version("graphifyy"),"runtime":sys.version,"base":sys.base_prefix,"site":sysconfig.get_path("purelib"),"dependencies":sorted((d.metadata["Name"],d.version) for d in m.distributions())}))'], directory, setupEnv)
if (pythonDescription.status !== 'ok') throw new Error('Unable to inspect Graphify identity')
const pythonMetadata = JSON.parse(pythonDescription.stdout)
const codegraphVersion = await capture(codegraph, ['--version'], directory, setupEnv)
if (codegraphVersion.status !== 'ok' || codegraphVersion.stdout.trim() !== '1.6.2' || pythonMetadata.version !== '0.9.77') throw new Error('Pinned competitor version mismatch')
for (const [id, path] of Object.entries({ typelatch: executableRoot, codegraph: graphNodeModules, graphify: pythonMetadata.site })) {
  const identity = treeIdentity(path)
  raw.identities[id] = identity
  const { entries, ...summary } = identity
  report.identities[id] = summary
}
Object.assign(report.identities.typelatch, { sourceCandidate: candidate, source: treeIdentity(join(candidate, 'src')), node: fileIdentity(process.execPath), version: JSON.parse(readFileSync(join(executableRoot, 'package.json'), 'utf8')).version })
Object.assign(report.identities.codegraph, { version: '1.6.2', launcher: fileIdentity(codegraph), bundledNode: fileIdentity(join(graphNodeModules, `@colbymchenry/codegraph-${platform()}-${arch()}`, 'node')), installLock: fileIdentity(resolve(graphNodeModules, '../package-lock.json')) })
Object.assign(report.identities.graphify, { version: pythonMetadata.version, python: fileIdentity(python), installed: pythonMetadata })
raw.identities.pythonRuntime = treeIdentity(pythonMetadata.base)
const { entries: pythonRuntimeEntries, ...pythonRuntimeIdentity } = raw.identities.pythonRuntime
report.identities.graphify.pythonDistribution = pythonRuntimeIdentity
const definitions = [
  { id: 'small', path: join(repo, 'scripts/fixtures/competitive'), question: 'calculateInvoiceTotal', expected: 'src/billing.ts' },
  { id: 'repository', path: join(repo, 'artifacts/competitive/repository-fixture'), question: 'validateWorkspace', expected: 'src/workspace/validate.ts' }
]
for (const corpus of definitions) {
  const identity = treeIdentity(corpus.path)
  if (!identity.files) throw new Error(`Missing fixture ${corpus.path}; first prepare it using scripts/competitive-repository.mjs`)
  report.corpora[corpus.id] = { ...identity, question: corpus.question, expected: corpus.expected, sourceCommit: corpus.id === 'repository' ? '0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125' : null }
  if (corpus.id === 'repository') for (const entry of identity.entries) {
    const expected = execFileSync('git', ['show', `0053a7fbb1c8f8e7b3572145f2e64e18e8dc7125:${entry.path}`], { cwd: repo })
    if (sha(expected) !== entry.sha256) throw new Error(`Repository fixture drift: ${entry.path}`)
  }
}
save()
for (const corpus of definitions) for (let round = 0; round < rounds; round++) {
  const providers = ['typelatch', 'codegraph', 'graphify']
  for (const provider of [...providers.slice(round % 3), ...providers.slice(0, round % 3)]) {
    const base = join(directory, corpus.id, String(round + 1), provider), root = join(base, 'repo')
    cpSync(corpus.path, root, { recursive: true })
    execFileSync('git', ['init', '-q', root])
    const index = provider === 'typelatch' ? join(base, 'data') : join(root, provider === 'codegraph' ? '.codegraph' : 'graphify-out')
    const env = isolatedEnv(base, index)
    const session = { corpus: corpus.id, provider, round: round + 1, root, index, startedAt: new Date().toISOString(), status: 'starting', hostStart: { freeMemoryBytes: freemem(), loadAverage: loadavg() } }
    const details = { session }
    raw.sessions.push(details)
    report.sessions.push(session)
    console.log(JSON.stringify({ phase: 'session', corpus: corpus.id, provider, round: round + 1 }))
    const setup = provider === 'typelatch'
      ? await capture(process.execPath, [join(executableRoot, 'dist/cli.js'), 'search', corpus.question, '--root', root, '--scope', 'workspace', '--compact', '--json'], root, env, true)
      : provider === 'codegraph' ? await capture(codegraph, ['init', root, '--yes'], root, env, true)
      : await capture(python, ['-m', 'graphify', 'extract', root, '--code-only', '--no-cluster', '--out', root], root, env, true)
    details.setup = setup
    session.setup = { status: setup.status, elapsedMs: setup.elapsedMs, memory: setup.memory, outputSha256: sha(setup.stdout), errorSha256: sha(setup.stderr), indexBytes: footprint(index) }
    if (setup.status !== 'ok') { session.status = 'setup-error'; save(); continue }
    const command = provider === 'typelatch' ? process.execPath : provider === 'codegraph' ? codegraph : python
    const args = provider === 'typelatch' ? [join(executableRoot, 'dist/mcp.js')] : provider === 'codegraph' ? ['serve', '--mcp', '--path', root] : ['-m', 'graphify.serve', join(index, 'graph.json')]
    const transport = new StdioClientTransport({ command, args, cwd: root, env, stderr: 'pipe' })
    const client = new Client({ name: 'typelatch-process-space', version: '1.0.0' })
    let phase = 'startup', stderr = '', rootPid
    transport.stderr.on('data', chunk => { stderr += chunk })
    const sampling = sampler(() => rootPid ?? transport.pid, () => phase)
    try {
      await client.connect(transport, { timeout: 90_000 })
      rootPid = transport.pid
      session.rootPid = rootPid
      session.server = client.getServerVersion()
      await client.listTools(undefined, { timeout: 30_000 })
      phase = 'baseline'
      await sleep(1000)
      phase = 'query'
      await sampling.take()
      const input = request(provider, root, corpus.question)
      const started = performance.now()
      const output = await client.callTool(input, undefined, { timeout: 90_000 })
      const returnedAt = performance.now()
      await sampling.take()
      const text = textOf(output)
      const status = output.isError || /^Error executing /.test(text) ? 'error' : !text.length || output.structuredContent?.status === 'empty' || /^(No relevant code found|No matching nodes found)/.test(text) ? 'empty' : 'ok'
      details.query = { input, output }
      session.query = { status, elapsedMs: returnedAt - started, contentBytes: Buffer.byteLength(text), responseBytes: Buffer.byteLength(JSON.stringify(output)), responseSha256: sha(JSON.stringify(output)), expectedSourcePathMentioned: status === 'ok' ? text.includes(corpus.expected) : null }
      phase = 'settling'
      await sleep(Math.max(0, 250 - (performance.now() - returnedAt)))
      phase = 'retainedIdle'
      await sleep(Math.max(0, 2000 - (performance.now() - returnedAt)))
      phase = 'idleWaiting'
      await sleep(Math.max(0, lateIdleMs - 1000 - (performance.now() - returnedAt)))
      phase = 'lateIdle'
      await sleep(Math.max(0, lateIdleMs - (performance.now() - returnedAt)))
      await sampling.take()
      session.status = session.query.status === 'ok' && session.query.expectedSourcePathMentioned ? 'ok' : 'query-control-failed'
    } catch (error) { session.status = 'error'; session.error = error.message }
    finally {
      await sampling.stop()
      details.samples = sampling.samples
      details.samplingErrors = sampling.errors
      details.stderr = stderr
      session.memory = summarize(sampling.samples, sampling.errors)
      session.stderrSha256 = sha(stderr)
      if (sampling.errors.length) session.status = 'sampling-error'
      const known = sampling.known
      await client.close().catch(error => { session.closeError = error.message })
      await sleep(500)
      const residual = (await processTable()).filter(row => known.has(row.pid))
      session.close = { observedProcesses: known.size, residualProcesses: residual }
      // Only PIDs observed within this server's tree are eligible for cleanup.
      for (const row of residual) try { process.kill(row.pid, 'SIGTERM') } catch {}
      if (residual.length) {
        await sleep(500)
        const surviving = (await processTable()).filter(row => known.has(row.pid))
        session.close.afterTermination = surviving
        for (const row of surviving) try { process.kill(row.pid, 'SIGKILL') } catch {}
      }
      session.indexBytes = footprint(index)
      session.hostEnd = { freeMemoryBytes: freemem(), loadAverage: loadavg() }
      session.finishedAt = new Date().toISOString()
      save()
    }
  }
}
for (const corpus of definitions) for (const provider of ['typelatch', 'codegraph', 'graphify']) {
  const rows = report.sessions.filter(row => row.corpus === corpus.id && row.provider === provider)
  const valid = rows.filter(row => row.status === 'ok')
  report.summary[`${corpus.id}/${provider}`] = {
    attemptedRounds: rows.length, successfulRounds: valid.length, failedRounds: rows.length - valid.length,
    allExpectedSourcePathsMentioned: rows.every(row => row.query?.expectedSourcePathMentioned === true),
    indexBytes: valid.map(row => row.indexBytes),
    setupSampledMaximumRssBytes: valid.map(row => row.setup.memory.sampledMaximumRssBytes),
    servingSampledMaximumRssBytes: valid.map(row => row.memory.sampledMaximumRssBytes),
    medianServingSampledMaximumRssBytes: median(valid.map(row => row.memory.sampledMaximumRssBytes)),
    stages: Object.fromEntries(['baseline', 'query', 'retainedIdle', 'lateIdle'].map(stage => [stage, {
      roundMedianRssBytes: valid.map(row => row.memory.stages[stage]?.medianRssBytes ?? null),
      medianAcrossRoundsRssBytes: median(valid.map(row => row.memory.stages[stage]?.medianRssBytes).filter(value => value !== undefined)),
      roundMaximumRssBytes: valid.map(row => row.memory.stages[stage]?.sampledMaximumRssBytes ?? null),
      maximumProcessCounts: valid.map(row => row.memory.stages[stage]?.maximumProcessCount ?? null)
    }]))
  }
}
report.identityUnchanged = Object.fromEntries(Object.entries(raw.identities).map(([id, identity]) => [id, treeIdentity(identity.root).sha256 === identity.sha256]))
report.completedSessions = report.sessions.length
report.successfulSessions = report.sessions.filter(row => row.status === 'ok').length
report.complete = !smoke && report.completedSessions === definitions.length * rounds * 3 && report.successfulSessions === report.completedSessions && Object.values(report.identityUnchanged).every(Boolean)
report.finishedAt = new Date().toISOString()
const rawPath = join(artifactRoot, 'samples-and-responses.json.gz')
const compressed = gzipSync(JSON.stringify(raw))
writeFileSync(rawPath, compressed)
report.raw = { path: relative(repo, rawPath), bytes: compressed.length, sha256: sha(compressed) }
writeFileSync(join(artifactRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
save()
console.log(JSON.stringify({ report: destination, complete: report.complete, successfulSessions: report.successfulSessions, summary: report.summary }, null, 2))
if (!smoke && !report.complete) process.exitCode = 1
