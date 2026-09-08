import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkVersion = JSON.parse(readFileSync(join(root, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8')).version
assert(process.env.JCODE_SCRATCH_DIR, 'Set JCODE_SCRATCH_DIR to an absolute writable scratch directory')
const scratch = resolve(process.env.JCODE_SCRATCH_DIR)
mkdirSync(scratch, { recursive: true })
const runRoot = mkdtempSync(join(scratch, 'typelatch-showcase-'))
const workspace = join(runRoot, 'workspace')
const published = join(runRoot, 'published')
const home = join(runRoot, 'data')
for (const path of [workspace, published, home]) mkdirSync(path)
const output = resolve(process.argv[2] ?? join(root, 'docs/showcase/recording.json'))
const env = { ...process.env, TYPELATCH_HOME: home, TYPELATCH_USAGE: 'on', npm_config_cache: join(runRoot, 'npm-cache') }
const question = 'How can I import a batch of contacts into SQLite atomically, roll back every new row if a UNIQUE name constraint fails, and safely store a name containing a quote?'
const recording = {
  schemaVersion: 1,
  provenance: {
    capturedAt: new Date().toISOString(),
    client: { name: 'typelatch-showcase', version: '1.0.0', implementation: '@modelcontextprotocol/sdk Client over stdio', sdkVersion, agent: 'Jcode' },
    harnessSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: release() },
    publishedPackage: 'typelatch@0.1.1',
    indexedPackage: 'kysely@0.28.8',
    runtimePackage: 'better-sqlite3@13.0.3',
    runtimeDeclarations: '@types/better-sqlite3@9.6.0',
    normalization: 'Only private absolute path prefixes are replaced. Durations, IDs, hashes, outputs and evidence states are retained.',
    pathTokens: { '$WORKSPACE': 'isolated copy of examples/sqlite', '$TYPELATCH_HOME': 'isolated Typelatch data directory', '$PUBLISHED_INSTALL': 'scratch npm install of published typelatch', '$RUN_ROOT': 'fresh capture directory', '$SCRATCH': 'JCODE_SCRATCH_DIR', '$REPOSITORY': 'source checkout', '$NODE': 'Node executable', '$USER_HOME': 'user home' }
  },
  authored: {
    label: 'Question and rationale authored by Jcode, not MCP output or a simulated agent transcript',
    question,
    rationale: [
      'The initial natural language search surfaced ControlledTransaction, insertion and constraint APIs, not the selected callback transaction API. Refine the search to TransactionBuilder execute and inspect the exact ESM symbol.',
      'Use Kysely bundled declarations for API discovery. The SQLite dialect executes against better-sqlite3. Its separately installed declarations have their own identity and are not the indexed Kysely artifact.',
      'Run each insert inside the transaction callback and allow errors to escape. Use values for parameter binding rather than interpolating a name into SQL.',
      'Retrieval alone does not prove rollback or binding. Compile the installed workspace, execute positive assertions, and show that omitting the transaction fails the same atomicity requirement.'
    ]
  },
  fixture: [], commands: [], mcp: [], sourceExcerpts: [], storeAudit: [], assertions: {}
}
const replacements = [[workspace, '$WORKSPACE'], [home, '$TYPELATCH_HOME'], [published, '$PUBLISHED_INSTALL'], [runRoot, '$RUN_ROOT'], [root, '$REPOSITORY'], [process.execPath, '$NODE'], [scratch, '$SCRATCH'], [homedir(), '$USER_HOME']]
function normalize(value) {
  if (typeof value === 'string') {
    for (const [path, token] of replacements) value = value.replaceAll(path, token)
    return value
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]))
  return value
}
function save(destination = join(runRoot, 'recording.partial.json')) {
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, JSON.stringify(normalize(recording), null, 2) + '\n')
}
function command(id, executable, args, cwd = workspace, required = true) {
  console.error(`capture: ${id}`)
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 240_000, maxBuffer: 20 * 1024 * 1024 })
  recording.commands.push({ id, command: executable, args, cwd, exitCode: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error.message } : {}) })
  save()
  if (required) assert.equal(result.status, 0, `${id}: ${result.stderr}`)
  return result
}
function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text)
}
let client
try {
  for (const file of readdirSync(join(root, 'examples/sqlite')).filter(file => /\.(?:ts|json)$/.test(file))) {
    const source = join(root, 'examples/sqlite', file)
    copyFileSync(source, join(workspace, file))
    recording.fixture.push({ path: `examples/sqlite/${file}`, sha256: createHash('sha256').update(readFileSync(source)).digest('hex') })
  }
  writeFileSync(join(published, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  command('npm-version', 'npm', ['--version'])
  command('published-registry-metadata', 'npm', ['view', 'typelatch@0.1.1', 'version', 'dist', 'bin', 'engines', '--json'])
  command('install-published', 'npm', ['install', '--save-exact', '--no-audit', '--no-fund', 'typelatch@0.1.1'], published)
  const installed = join(published, 'node_modules/typelatch')
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.version, '0.1.1')
  recording.provenance.installedManifest = manifest
  recording.provenance.publishedLock = JSON.parse(readFileSync(join(published, 'package-lock.json'), 'utf8'))
  const cli = join(installed, 'dist/cli.js')
  command('cli-help', process.execPath, [cli, '--help'])
  command('install-fixture', 'npm', ['ci', '--no-audit', '--no-fund'])
  command('installed-fixture-identities', 'npm', ['ls', '--depth=0', '--json'])
  command('unavailable-provisional-declarations', 'npm', ['view', '@types/better-sqlite3@9.6.13', 'version'], workspace, false)
  command('available-declarations', 'npm', ['view', '@types/better-sqlite3@9.6.0', 'version', 'dist', '--json'])
  command('declaration-index-attempt', process.execPath, [cli, 'add', '@types/better-sqlite3@9.6.0'], workspace, false)
  command('index-kysely', process.execPath, [cli, 'add', 'kysely@0.28.8'])
  command('fixture-compile', 'npm', ['run', 'check'])

  client = new Client({ name: recording.provenance.client.name, version: recording.provenance.client.version })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(installed, 'dist/mcp.js')], cwd: workspace, env, stderr: 'pipe' })
  recording.provenance.mcpServer = { command: process.execPath, args: [join(installed, 'dist/mcp.js')], cwd: workspace, env: { TYPELATCH_HOME: home, TYPELATCH_USAGE: 'on' } }
  recording.serverStderr = ''
  transport.stderr?.on('data', chunk => { recording.serverStderr += chunk.toString() })
  await client.connect(transport)
  recording.provenance.serverVersion = client.getServerVersion()
  const tools = await client.listTools()
  recording.mcp.push({ id: 'list-tools', method: 'tools/list', request: {}, response: tools })
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['library_feedback', 'library_search', 'library_stats', 'library_symbol', 'workspace_context', 'workspace_validate'])
  async function call(id, name, args) {
    console.error(`capture: ${id}`)
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
    recording.mcp.push({ id, method: 'tools/call', request: { name, arguments: args }, response })
    save()
    return payload(response)
  }
  const initial = await call('initial-search', 'library_search', { package: 'kysely', version: '0.28.8', question, limit: 5 })
  assert(initial.results.length > 0)
  const refined = await call('refined-search', 'library_search', { package: 'kysely', version: '0.28.8', question: 'TransactionBuilder execute', limit: 5 })
  const selected = refined.results.find(result => result.symbol === 'esm/kysely.TransactionBuilder')
  assert(selected, 'Expected ESM TransactionBuilder in refined search')
  const symbol = await call('transaction-symbol', 'library_symbol', { package: 'kysely', version: '0.28.8', symbol: selected.symbol })
  assert(symbol.results.some(result => result.symbol === selected.symbol && result.source === selected.source && result.line === selected.line))
  assert.equal(symbol.package, 'kysely')
  assert.equal(symbol.version, '0.28.8')
  await call('kysely-symbol', 'library_symbol', { package: 'kysely', version: '0.28.8', symbol: 'esm/kysely.Kysely' })
  const declaration = readFileSync(join(workspace, 'node_modules/kysely', selected.source), 'utf8')
  const lines = declaration.split('\n')
  for (const [startLine, endLine] of [[140, 207], [623, 629]]) {
    recording.sourceExcerpts.push({ origin: 'Read from installed Kysely declaration file, not an MCP response', package: 'kysely', version: '0.28.8', source: selected.source, startLine, endLine, fileSha256: createHash('sha256').update(declaration).digest('hex'), text: lines.slice(startLine - 1, endLine).join('\n') })
  }
  const context = await call('workspace-context', 'workspace_context', { config: join(workspace, 'tsconfig.json'), file: join(workspace, 'batch.ts'), importSpecifier: 'kysely', symbol: 'Kysely', expectedVersion: '0.28.8' })
  assert.equal(context.api.status, 'resolved')
  assert.equal(context.dependency.name, 'kysely')
  assert.equal(context.dependency.version, '0.28.8')
  assert.equal(context.checks.resolved.status, 'pass')
  assert.equal(context.checks.versionMatch.status, 'pass')
  assert.equal(context.checks.artifactMatch.status, 'unknown')
  const request = { config: join(workspace, 'tsconfig.json'), workspaceRoot: workspace, timeoutMs: 60_000, record: true, queryId: refined.queryId }
  const positive = await call('validate-positive', 'workspace_validate', { ...request, testCommand: ['npm', 'test'] })
  assert.equal(positive.success, true)
  assert.equal(positive.checks.typechecked.status, 'pass')
  assert.equal(positive.checks.tested.status, 'pass')
  assert.equal(positive.checks.stable.status, 'pass')
  assert.equal(positive.execution.exitCode, 0)
  assert.match(positive.execution.stdout, /# pass 2/)
  assert.match(positive.execution.stdout, /SQLITE_CONSTRAINT_UNIQUE/)
  assert.match(positive.execution.stdout, /O'Reilly/)
  const negative = await call('validate-negative', 'workspace_validate', { ...request, testCommand: ['npm', 'run', 'test:negative'] })
  assert.equal(negative.success, false)
  assert.equal(negative.checks.typechecked.status, 'pass')
  assert.equal(negative.checks.tested.status, 'fail')
  assert.equal(negative.checks.stable.status, 'pass')
  assert.equal(negative.execution.exitCode, 1)
  assert.match(negative.execution.stdout, /ERR_ASSERTION/)
  assert.match(negative.execution.stdout, /must roll back/)
  const invalid = await call('validate-invalid-types', 'workspace_validate', { ...request, testCommand: ['npm', 'test'], overlays: [{ file: join(workspace, 'batch.ts'), text: readFileSync(join(workspace, 'batch.ts'), 'utf8') + '\nconst invalid: number = "wrong"\n' }] })
  assert.equal(invalid.success, false)
  assert.equal(invalid.checks.typechecked.status, 'fail')
  assert.equal(invalid.checks.tested.status, 'not-run')
  assert(invalid.checks.typechecked.diagnostics.some(diagnostic => diagnostic.code === 2322))
  await client.close()
  client = undefined

  const requirePublished = createRequire(join(installed, 'package.json'))
  const Database = requirePublished('better-sqlite3')
  const db = new Database(join(home, 'brains/kysely/0.28.8/brain.db'), { readonly: true, fileMustExist: true })
  try {
    recording.storeAudit.push({ path: join(home, 'brains/kysely/0.28.8/brain.db'), mode: 'readonly', client: 'better-sqlite3, separate audit script, not an MCP tool', queries: [
      { sql: "SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name", rows: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all() },
      { sql: 'SELECT count(*) AS symbols FROM symbols', rows: db.prepare('SELECT count(*) AS symbols FROM symbols').all() },
      { sql: 'SELECT count(*) AS relationships FROM edges', rows: db.prepare('SELECT count(*) AS relationships FROM edges').all() },
      { sql: 'SELECT key, value FROM metadata ORDER BY key', rows: db.prepare('SELECT key, value FROM metadata ORDER BY key').all() },
      { sql: 'SELECT qualified_name, source_path, line_start, line_end FROM symbols WHERE qualified_name = ?', parameters: [selected.symbol], rows: db.prepare('SELECT qualified_name, source_path, line_start, line_end FROM symbols WHERE qualified_name = ?').all(selected.symbol) }
    ] })
    assert.equal(db.prepare('SELECT count(*) AS count FROM symbols WHERE qualified_name = ?').get(selected.symbol).count, 1)
  } finally { db.close() }
  recording.assertions = { publishedVersion: manifest.version, sixMcpTools: true, searchReturnedSymbols: true, exactTransactionSymbolReturned: true, workspaceContextCaptured: true, workspaceResolved: context.checks.resolved.status, workspaceVersionMatch: context.checks.versionMatch.status, workspaceArtifactMatch: context.checks.artifactMatch.status, positiveCompilation: positive.checks.typechecked.status, positiveExecution: positive.checks.tested.status, omittedTransactionExecution: negative.checks.tested.status, invalidTypes: invalid.checks.typechecked.status, invalidTypesExecution: invalid.checks.tested.status, sqliteIndexAudited: true, passed: true }
  save(output)
  console.log(`Captured published package evidence: ${output}`)
} finally {
  await client?.close()
  save()
}
