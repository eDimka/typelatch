import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const codegraph = process.env.CODEGRAPH_BIN
const python = process.env.GRAPHIFY_PYTHON
const typelatchDetail = process.env.TYPELATCH_DETAIL ?? 'full'
if (!['full', 'compact'].includes(typelatchDetail)) throw new Error('TYPELATCH_DETAIL must be full or compact')
if (!codegraph || !python) throw new Error('Set CODEGRAPH_BIN and GRAPHIFY_PYTHON to the pinned isolated installations described in docs/research/competitive-baseline.md')
const reportPath = resolve(process.argv[2] ?? join(repo, 'docs/benchmarks/competitive.json'))
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'typelatch-competitive-')))
const fixture = resolve(process.env.COMPETITIVE_FIXTURE ?? join(repo, 'scripts/fixtures/competitive'))
const casesPath = resolve(process.env.COMPETITIVE_CASES ?? join(repo, 'scripts/fixtures/competitive-cases.json'))
const cases = JSON.parse(readFileSync(casesPath, 'utf8')).cases
const sha = value => createHash('sha256').update(value).digest('hex')
const env = Object.fromEntries(Object.entries({ PATH: process.env.PATH, LANG: process.env.LANG, TMPDIR: process.env.TMPDIR, SYSTEMROOT: process.env.SYSTEMROOT, DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DAEMON: '1', GRAPHIFY_QUERY_LOG_DISABLE: '1', GRAPHIFY_NO_AUTO_REFRESH: '1', TYPELATCH_USAGE: 'off' }).filter(([, value]) => value !== undefined))
// Competitor setup must not discover or update the user's existing agent configuration.
env.HOME = join(directory, 'isolated-home')
env.XDG_CONFIG_HOME = join(directory, 'isolated-config')
env.XDG_CACHE_HOME = join(directory, 'isolated-cache')
mkdirSync(env.HOME, { recursive: true })
function files(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : []
  }).sort()
}
function footprint(root) {
  const entries = files(root).map(path => { const stat = lstatSync(path); return { path: relative(root, path), bytes: stat.size, allocatedBytes: (stat.blocks ?? 0) * 512 } })
  return { logicalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), allocatedBytes: entries.reduce((sum, entry) => sum + entry.allocatedBytes, 0), files: entries }
}
function manifest(root) { return files(root).map(path => ({ path: relative(root, path), sha256: sha(readFileSync(path)), bytes: lstatSync(path).size })) }
function installLock(path) {
  for (let root = dirname(realpathSync(path)); root !== dirname(root); root = dirname(root)) {
    const lock = join(root, 'package-lock.json')
    if (existsSync(lock)) return { path: lock, sha256: sha(readFileSync(lock)), contents: JSON.parse(readFileSync(lock, 'utf8')) }
  }
  return null
}
const initialFixture = manifest(fixture)
const report = {
  schemaVersion: 1, kind: 'authored deterministic MCP retrieval comparison', startedAt: new Date().toISOString(), complete: false,
  runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  environment: { platform: process.platform, arch: process.arch, node: process.version, typelatchDetail },
  corpus: { path: fixture, casesPath, manifest: initialFixture, sha256: sha(JSON.stringify(initialFixture)), expectationsSha256: sha(readFileSync(casesPath)), cases },
  providers: {}, rows: [], freshness: [], negativeControls: [],
  limitations: [
    'Authored TypeScript retrieval fixture. See corpus path and file manifest for exact scale. This is not a held out agent coding task.',
    'A discovery hit means the expected source path appears in tool content. It does not prove the answer, a usable implementation, or equivalent context quality.',
    'One fixed query per case, no answer derived rewrites or repairs. Seven code cases share AST eligible files. Docs and config are reported separately.',
    'Graphify runs local code only extraction with no clustering or LLM calls. This excludes semantic document extraction, graph communities and visual artifacts.',
    'Output bytes are measured directly. No token, API cost, total agent latency, peak RSS or coding correctness claim follows from them.',
    'Warm calls reuse one server and may include provider session deduplication. Cold is the first query after setup and connection, not a cold operating system cache.',
    'Storage includes all files in each provider index directory, including caches and journal files. Install and language runtime sizes are separate observations.',
    'Freshness records immediate and explicit refresh behavior. CodeGraph default watcher stays enabled, but the immediate response may race its debounce window.',
    'Unsupported features are not scored as wins. No universal superiority gate is defined.'
  ]
}
function save() { mkdirSync(dirname(reportPath), { recursive: true }); writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n') }
function capture(command, args, cwd, extra = {}) {
  const start = performance.now()
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
  return { command, args, elapsedMs: performance.now() - start, status: result.status === 0 && !result.error ? 'ok' : 'error', exitCode: result.status, signal: result.signal, output: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) }
}
function textOf(result) { return result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '' }
function evidence(id, result, expected) {
  const text = textOf(result)
  const outputPaths = [...new Set(text.match(/(?:src|test|docs)\/[A-Za-z0-9_.\/-]+\.(?:ts|md)/g) ?? [])]
  if (id === 'typelatch') {
    const data = result.structuredContent ?? JSON.parse(text)
    const items = data.results ?? data.items ?? []
    const matched = items.find(item => String(item.source ?? item.file ?? '').endsWith(expected))
    return { expectedPathMentioned: text.includes(expected), sourceLocationProvided: Boolean(matched?.line > 0), sourceExcerptIncluded: Boolean(matched?.snippet?.length), referencedSourceFiles: outputPaths.length, outputPaths }
  }
  const located = id === 'codegraph'
    ? text.includes(`**\`${expected}\`**`) && text.includes('```')
    : text.split('\n').some(line => line.startsWith('NODE ') && line.includes(`src=${expected} `) && /loc=L\d+/.test(line))
  return { expectedPathMentioned: text.includes(expected), sourceLocationProvided: located, sourceExcerptIncluded: id === 'codegraph' && located, referencedSourceFiles: outputPaths.length, outputPaths }
}
const clients = {}
const roots = {}
const indexes = {}
async function connect(id, command, args) {
  const start = performance.now()
  const transport = new StdioClientTransport({ command, args, cwd: roots[id], env: { ...env, TYPELATCH_HOME: indexes[id] }, stderr: 'pipe' })
  let stderr = ''
  transport.stderr.on('data', chunk => { stderr += chunk.toString() })
  const client = new Client({ name: 'typelatch-competitive-proof', version: '1.0.0' })
  try {
    await client.connect(transport, { timeout: 90000 })
    const listed = await client.listTools(undefined, { timeout: 30000 })
    Object.assign(report.providers[id], { status: 'ready', connectionMs: performance.now() - start, server: client.getServerVersion(), tools: listed.tools, schemaBytes: Buffer.byteLength(JSON.stringify(listed)), get stderr() { return stderr } })
    clients[id] = client
  } catch (error) {
    Object.assign(report.providers[id], { status: 'unavailable', error: error.message, stderr })
    await client.close().catch(() => {})
  }
}
function request(id, question) {
  if (id === 'typelatch') return { name: 'workspace_search', arguments: { workspaceRoot: roots[id], question, scope: 'workspace', limit: 8, ...(typelatchDetail === 'compact' ? { detail: 'compact' } : {}) } }
  if (id === 'codegraph') return { name: 'codegraph_explore', arguments: { query: question, maxFiles: 8, projectPath: roots[id] } }
  return { name: 'query_graph', arguments: { question, token_budget: 2000 } }
}
async function call(id, question) {
  const input = request(id, question)
  const start = performance.now()
  try {
    const output = await clients[id].callTool(input, undefined, { timeout: 90000 })
    const text = textOf(output)
    const empty = !text.length || output.structuredContent?.status === 'empty' || /^(?:No relevant code found|No matching nodes found)/.test(text)
    return { input, status: output.isError || /^Error executing /.test(text) ? 'error' : empty ? 'empty' : 'ok', elapsedMs: performance.now() - start, responseBytes: Buffer.byteLength(JSON.stringify(output)), contentBytes: Buffer.byteLength(text), output }
  } catch (error) { return { input, status: 'error', elapsedMs: performance.now() - start, error: error.message } }
}
try {
  for (const id of ['typelatch', 'codegraph', 'graphify']) {
    roots[id] = join(directory, id, 'repo')
    indexes[id] = id === 'typelatch' ? join(directory, id, 'data') : join(roots[id], id === 'codegraph' ? '.codegraph' : 'graphify-out')
    cpSync(fixture, roots[id], { recursive: true })
    execFileSync('git', ['init', '-q', roots[id]])
    report.providers[id] = { status: 'initializing', workspace: roots[id], indexPath: indexes[id], inputManifestSha256: sha(JSON.stringify(manifest(roots[id]).filter(entry => !entry.path.startsWith('.git/')))), setup: [], beforeIndex: footprint(indexes[id]) }
  }
  report.providers.typelatch.identity = { version: JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, source: manifest(join(repo, 'src')), dist: manifest(join(repo, 'dist')) }
  report.providers.codegraph.identity = { npm: '@colbymchenry/codegraph@1.6.2', documentationSourceCommit: '6421644ef292d0e6decd968e249c18bd648a9078', binary: codegraph, version: capture(codegraph, ['--version'], roots.codegraph), installLock: installLock(codegraph) }
  report.providers.graphify.identity = { python, installationSourceCommit: '5c7b84792f453582676548185aaec3824d51dfe2', installed: capture(python, ['-c', 'import importlib.metadata as m,json; print(json.dumps({"version":m.version("graphifyy"),"directUrl":m.distribution("graphifyy").read_text("direct_url.json"),"dependencies":sorted((d.metadata["Name"], d.version) for d in m.distributions())}))'], roots.graphify) }
  if (report.providers.codegraph.identity.version.output?.trim() !== '1.6.2') throw new Error('CodeGraph installation must be version 1.6.2')
  if (JSON.parse(report.providers.graphify.identity.installed.output).version !== '0.9.77') throw new Error('Graphify installation must be version 0.9.77')
  report.providers.codegraph.setup.push(capture(codegraph, ['init', roots.codegraph, '--yes'], roots.codegraph))
  report.providers.graphify.setup.push(capture(python, ['-m', 'graphify', 'extract', roots.graphify, '--code-only', '--no-cluster', '--out', roots.graphify], roots.graphify))
  for (const id of ['typelatch', 'codegraph', 'graphify']) report.providers[id].afterSetup = footprint(indexes[id])
  save()
  await connect('typelatch', process.execPath, [join(repo, 'dist/mcp.js')])
  if (report.providers.codegraph.setup.every(row => row.status === 'ok')) await connect('codegraph', codegraph, ['serve', '--mcp', '--path', roots.codegraph])
  else report.providers.codegraph.status = 'unavailable'
  if (report.providers.graphify.setup.every(row => row.status === 'ok')) await connect('graphify', python, ['-m', 'graphify.serve', join(indexes.graphify, 'graph.json')])
  else report.providers.graphify.status = 'unavailable'
  for (const [index, entry] of cases.entries()) {
    const ids = ['typelatch', 'codegraph', 'graphify']
    for (const id of [...ids.slice(index % 3), ...ids.slice(0, index % 3)]) {
      if (!clients[id]) { report.rows.push({ provider: id, ...entry, status: 'unavailable', hit: null }); continue }
      for (const cache of ['first', 'repeat']) {
        const row = { provider: id, ...entry, cache, ...await call(id, entry.question) }
        row.hit = row.status === 'ok' ? textOf(row.output).includes(entry.expected) : row.status === 'empty' ? false : null
        row.evidence = row.status === 'ok' ? evidence(id, row.output, entry.expected) : null
        // Docs are outside this Graphify invocation's selected code only scope.
        row.support = id === 'graphify' && entry.lane === 'docs' ? 'not-evaluated-in-code-only-mode' : 'evaluated'
        if (index === 0) report.providers[id][cache === 'first' ? 'afterColdQuery' : 'afterWarmQuery'] = footprint(indexes[id])
        report.rows.push(row)
        save()
      }
    }
  }
  for (const id of ['typelatch', 'codegraph', 'graphify']) {
    if (!clients[id]) continue
    const result = await call(id, 'quuxNebulaUnrelated999')
    const text = result.output ? textOf(result.output) : ''
    const structured = result.output?.structuredContent
    const empty = id === 'typelatch' ? structured?.status === 'empty' && structured.results?.length === 0
      : id === 'codegraph' ? text.startsWith('No relevant code found') : text.startsWith('No matching nodes found')
    report.negativeControls.push({ provider: id, expected: 'explicit empty response', passed: result.status !== 'error' && empty, ...result })
  }
  // Changes occur after all frozen discovery cases. They do not alter the score corpus.
  for (const id of ['typelatch', 'codegraph', 'graphify']) {
    if (!clients[id]) continue
    const path = join(roots[id], 'src/retry.ts')
    if (!existsSync(path)) { report.freshness.push({ provider: id, status: 'not-evaluated', reason: 'Alternate corpus has no src/retry.ts fixture' }); continue }
    writeFileSync(path, readFileSync(path, 'utf8').replace('retryDelay', 'backoffSchedule'))
    const immediate = await call(id, 'backoffSchedule')
    const refresh = id === 'typelatch' ? null : id === 'codegraph'
      ? capture(codegraph, ['sync', roots[id]], roots[id])
      : capture(python, ['-m', 'graphify', 'extract', roots[id], '--code-only', '--no-cluster', '--out', roots[id]], roots[id])
    const refreshed = await call(id, 'backoffSchedule')
    rmSync(path)
    const afterDelete = await call(id, 'backoffSchedule')
    const deleteRefresh = id === 'typelatch' ? null : id === 'codegraph'
      ? capture(codegraph, ['sync', roots[id]], roots[id])
      : capture(python, ['-m', 'graphify', 'extract', roots[id], '--code-only', '--no-cluster', '--out', roots[id]], roots[id])
    const afterDeleteRefresh = await call(id, 'backoffSchedule')
    report.freshness.push({ provider: id, immediate, refresh, refreshed, afterDelete, deleteRefresh, afterDeleteRefresh })
    report.providers[id].afterFreshness = footprint(indexes[id])
    save()
  }
  for (const [id, client] of Object.entries(clients)) { await client.close(); delete clients[id]; report.providers[id].closedIndex = footprint(indexes[id]) }
  report.summary = Object.fromEntries(['typelatch', 'codegraph', 'graphify'].map(id => {
    const code = report.rows.filter(row => row.provider === id && row.lane === 'code' && row.cache === 'first')
    return [id, { codeCases: code.length, codeHits: code.filter(row => row.hit).length, sourceLocationsProvided: code.filter(row => row.evidence?.sourceLocationProvided).length, sourceExcerptsIncluded: code.filter(row => row.evidence?.sourceExcerptIncluded).length, firstContentBytes: code.reduce((sum, row) => sum + (row.contentBytes ?? 0), 0), firstResponseBytes: code.reduce((sum, row) => sum + (row.responseBytes ?? 0), 0), schemaBytes: report.providers[id].schemaBytes, coldIndexBytes: report.providers[id].afterColdQuery?.logicalBytes, warmIndexBytes: report.providers[id].afterWarmQuery?.logicalBytes, status: report.providers[id].status }]
  }))
  report.complete = true
  report.generatedAt = new Date().toISOString()
  save()
  console.log(JSON.stringify({ report: reportPath, directory, summary: report.summary }, null, 2))
} finally {
  for (const client of Object.values(clients)) await client.close().catch(() => {})
  save()
  // Keep temporary indexes for independent inspection. Their exact paths are in the report.
}
