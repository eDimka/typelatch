import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { prepareBaseline } from './competitive-baseline.mjs'

const directory = resolve('artifacts/competitive/search-session')
mkdirSync(directory, { recursive: true })
const baselineBuild = prepareBaseline(directory)
const beforeDist = join(directory, 'before-dist')
rmSync(beforeDist, { recursive: true, force: true })
cpSync(resolve('dist'), beforeDist, { recursive: true })
const changedModules = ['workspace/runtime.js', 'workspace/persistent.js', 'workspace/search-worker.js']
for (const module of changedModules) cpSync(join(baselineBuild.distDirectory, module), join(beforeDist, module))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n') }
const root = join(directory, 'fixture')
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
execFileSync('git', ['init', '-q', root])
const corpus = baselineBuild.readTree(['src'])
for (const file of corpus) { mkdirSync(dirname(join(root, file.path)), { recursive: true }); writeFileSync(join(root, file.path), file.text) }
writeFileSync(join(root, 'package.json'), '{"name":"session-benchmark","version":"1.0.0"}\n')
const probe = join(directory, 'process-probe.mjs')
writeFileSync(probe, "import {appendFileSync} from 'node:fs'; appendFileSync(process.env.TYPELATCH_SESSION_PROBE, JSON.stringify({pid:process.pid,argv:process.argv})+'\\n');\n")
const questions = ['workspaceContext', 'searchWorkspaceIndex', 'recordOutcome', 'verifyIntegrity', 'missingBenchmarkNeedle', 'workspaceContext', 'searchWorkspaceIndex', 'recordOutcome', 'verifyIntegrity']
const all = []

function normalize(response) {
  const value = JSON.parse(JSON.stringify(response, (key, item) => ['latencyMs', 'searchMs'].includes(key) ? undefined : item))
  value.index.path = `[isolated cache]/${basename(dirname(value.index.path))}/${basename(value.index.path)}`
  return value
}

async function connect(provider, session) {
  const home = join(directory, `session-${session}`, `${provider}-data`)
  const log = join(directory, `session-${session}`, `${provider}-processes.jsonl`)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, '')
  const server = join(provider === 'before' ? beforeDist : resolve('dist'), 'mcp.js')
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], cwd: process.cwd(), env: {
    ...process.env, TYPELATCH_HOME: home, TYPELATCH_USAGE: 'off', TYPELATCH_SESSION_PROBE: log,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(probe).href}`.trim()
  }, stderr: 'pipe' })
  const client = new Client({ name: 'search-session-proof', version: '1.0.0' })
  const started = performance.now()
  await client.connect(transport)
  return { client, log, connectionMs: performance.now() - started }
}

for (let session = 0; session < 3; session++) {
  const servers = {}
  const records = []
  try {
    for (const provider of session % 2 ? ['after', 'before'] : ['before', 'after']) servers[provider] = await connect(provider, session)
    for (const [index, question] of questions.entries()) {
      const pair = {}
      for (const provider of (session + index) % 2 ? ['after', 'before'] : ['before', 'after']) {
        const request = { name: 'workspace_search', arguments: { workspaceRoot: root, question, scope: 'workspace', limit: 8 } }
        const started = performance.now()
        const response = await servers[provider].client.callTool(request)
        const elapsedMs = performance.now() - started
        assert.notEqual(response.isError, true)
        assert.ok(response.structuredContent)
        assert.equal(response.structuredContent.index.updatedFiles, index === 0 ? corpus.length + 1 : 0)
        pair[provider] = { request, response, elapsedMs, responseJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(response)) }
      }
      assert.deepEqual(normalize(pair.after.response.structuredContent), normalize(pair.before.response.structuredContent), `Full search response differs in session ${session}, question ${question}`)
      records.push({ index, phase: index === 0 ? 'cold runtime and cache' : 'warm cache and connected MCP session', question, ...pair })
    }
  } finally {
    for (const server of Object.values(servers)) await server.client.close()
  }
  const processes = Object.fromEntries(Object.entries(servers).map(([provider, server]) => [provider, readFileSync(server.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))]))
  const searchStarts = Object.fromEntries(Object.entries(processes).map(([provider, entries]) => [provider, entries.filter(entry => entry.argv.some(value => value.endsWith('/search-worker.js'))).length]))
  assert.equal(searchStarts.before, questions.length)
  assert.equal(searchStarts.after, 1)
  all.push({ session, connectionMs: Object.fromEntries(Object.entries(servers).map(([provider, server]) => [provider, server.connectionMs])), searchStarts, processes, records })
  console.error(`Session ${session + 1}: identical outputs, search worker starts ${searchStarts.before} -> ${searchStarts.after}`)
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[Math.floor(sorted.length / 2)] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 }
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
const measurements = Object.fromEntries(['before', 'after'].map(provider => {
  const coldMs = all.map(session => session.records[0][provider].elapsedMs)
  const warmMs = all.flatMap(session => session.records.slice(1).map(record => record[provider].elapsedMs))
  return [provider, { coldMs, coldMedianMs: median(coldMs), warmMs, warmMedianMs: median(warmMs), warmP95Ms: percentile(warmMs, 0.95), searchWorkerStarts: all.reduce((sum, session) => sum + session.searchStarts[provider], 0) }]
}))
const baselineModules = Object.fromEntries(changedModules.map(module => [module, hash(readFileSync(join(beforeDist, module)))]))
const candidateModules = Object.fromEntries(changedModules.map(module => [module, hash(readFileSync(join('dist', module)))]))
const raw = gzipSync(JSON.stringify({ baselineRef: baselineBuild.ref, corpus, baselineModules, candidateModules, sessions: all }))
const archive = join(directory, 'evidence.json.gz')
writeFileSync(archive, raw)
const report = {
  kind: 'retained search worker latency', generatedAt: new Date().toISOString(), passed: true,
  node: process.version, platform: process.platform, arch: process.arch, baselineRef: baselineBuild.ref,
  method: 'Three actual stdio MCP sessions per implementation. Each session begins with an empty isolated SQLite cache and nine sequential search requests. Provider order alternates within each session. Before uses current build and current index format with only runtime.js, persistent.js and search-worker.js replaced by the immutable baseline versions. After uses the current build. Tool latency is measured from SDK call to response. Worker starts are observed through a Node import probe in both variants.',
  parity: 'Full structured responses match after removing only latencyMs/searchMs and replacing the separate cache directory prefixes with one placeholder. Every result, source location, coverage detail, evidence state, snapshot, updatedFiles and removedFiles value is preserved.',
  limitations: 'One authored repository source snapshot on this machine. Cold means new worker and empty application cache, not a cold operating system cache. No concurrent-load or peak-memory measurement. Retained workers may keep parser runtime memory for up to thirty idle seconds. Workspace contents are still read and hashed on every request. No autonomous agent time or general competitor superiority claim.',
  reproduction: 'Run npm run build then node scripts/benchmark-search-session.mjs. Requires the fixed baseline Git commit and installed dependencies; no old artifacts are needed.',
  files: corpus.length + 1, sourceSha256: hash(JSON.stringify(corpus)), queriesPerSession: questions.length,
  measurements, warmMedianReductionPercent: 100 * (1 - measurements.after.warmMedianMs / measurements.before.warmMedianMs),
  baselineModules, candidateModules,
  rawArchive: { path: relative(process.cwd(), archive), bytes: raw.length, sha256: hash(raw) }
}
save(join(directory, 'report.json'), report)
save(resolve('docs/benchmarks/search-session.json'), report)
console.log(JSON.stringify(report, null, 2))
