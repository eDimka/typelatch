import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = resolve(import.meta.dirname, '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const scratch = resolve(root, 'artifacts/agent-workflow')
mkdirSync(scratch, { recursive: true })
const runRoot = realpathSync(mkdtempSync(join(scratch, 'run-')))
const workspace = join(runRoot, 'workspace')
const dataHome = join(runRoot, 'data')
mkdirSync(workspace)
const env = { ...process.env, TYPELATCH_HOME: dataHome, TYPELATCH_USAGE: 'off' }
const hash = value => createHash('sha256').update(value).digest('hex')
const question = 'Contact imports leave partial data after a duplicate name. Find the implementation and fix whole batch rollback while preserving parameter binding.'
const record = {
  provenance: {
    capturedAt: new Date().toISOString(), version,
    kind: 'Curated MCP workflow replay with actual tool responses; not an independent agent session or benchmark',
    author: 'Codex', client: '@modelcontextprotocol/sdk Client over stdio',
    harnessSha256: hash(readFileSync(import.meta.filename)),
    fixture: 'Isolated copy of examples/sqlite with the transaction deliberately removed from batch.ts',
    question, packageSource: process.env.TYPELATCH_PACKAGE ?? 'built source checkout',
    normalization: 'Private absolute path prefixes are replaced; responses, code, IDs, hashes, timings and execution output are otherwise retained',
    node: process.version, platform: process.platform
  },
  commands: [], calls: [], fileActions: [], checks: {}, summary: {}
}
const replacements = [[workspace, '$WORKSPACE'], [dataHome, '$TYPELATCH_HOME'], [runRoot, '$RUN'], [root, '$REPOSITORY'], [process.execPath, '$NODE'], [homedir(), '$USER_HOME']]
function normalize(value) {
  if (typeof value === 'string') { for (const [path, token] of replacements) value = value.replaceAll(path, token); return value }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]))
  return value
}
function command(id, executable, args, cwd = workspace) {
  console.error(`showcase: ${id}`)
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 8_000_000 })
  record.commands.push({ id, executable, args, cwd, exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
  assert.equal(result.status, 0, `${id}: ${result.error?.message ?? result.stderr}`)
  return result.stdout
}
function read(path, reason) {
  const text = readFileSync(path, 'utf8')
  record.fileActions.push({ tool: 'ordinary file read', reason, path, sha256: hash(text), text })
  return text
}
let client
try {
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'batch.ts', 'batch.test.ts']) copyFileSync(join(root, 'examples/sqlite', file), join(workspace, file))
  const correct = readFileSync(join(workspace, 'batch.ts'), 'utf8')
  const start = correct.indexOf('export async function importContacts(')
  assert(start >= 0)
  const before = correct.slice(0, start) + `export async function importContacts(db: Kysely<Tables>, contacts: Contact[]) {
  for (const contact of contacts) {
    await db.insertInto('contact').values(contact).execute()
  }
}
`
  writeFileSync(join(workspace, 'batch.ts'), before)
  writeFileSync(join(workspace, '.gitignore'), 'node_modules/\n')
  command('prepare-git-inventory', 'git', ['init', '-q'])
  command('install-fixture', 'npm', ['ci', '--no-audit', '--no-fund'])
  if (process.argv.includes('--prepare-only')) {
    console.log(JSON.stringify({ workspaceRoot: workspace, task: question, baseline: 'Intentionally missing the transaction; npm test should fail the rollback assertion', authorization: 'Run npm test in this isolated workspace. Edit only batch.ts.' }, null, 2))
  } else {
    let installed = root
    if (process.env.TYPELATCH_PACKAGE) {
      const destination = join(runRoot, 'tool')
      mkdirSync(destination)
      writeFileSync(join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
      const spec = process.env.TYPELATCH_PACKAGE
      if (spec.endsWith('.tgz')) record.provenance.tarballSha256 = hash(readFileSync(spec))
      command('install-tool', 'npm', ['install', '--no-audit', '--no-fund', spec], destination)
      installed = join(destination, 'node_modules/typelatch')
      const lock = JSON.parse(readFileSync(join(destination, 'package-lock.json'), 'utf8'))
      record.provenance.installedPackage = lock.packages['node_modules/typelatch']
    }
    assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, version)
    const cli = join(installed, 'dist/cli.js')
    client = new Client({ name: 'typelatch-agent-workflow', version: '1.0.0' })
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(installed, 'dist/mcp.js')], cwd: workspace, env }))
    record.provenance.server = client.getServerVersion()
    assert.equal(record.provenance.server.version, version)
    record.tools = await client.listTools()
    assert(record.tools.tools.some(tool => tool.name === 'workspace_search'))
    const call = async (id, decision, name, args) => {
      console.error(`showcase: ${id}`)
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })
      record.calls.push({ id, decision, request: { name, arguments: args }, response })
      assert.notEqual(response.isError, true, JSON.stringify(response))
      return response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text)
    }
    const initial = await call('discover', 'Start from the user task without choosing a package or file.', 'workspace_search', { workspaceRoot: workspace, question, limit: 8 })
    assert(initial.results.some(item => item.source.endsWith('batch.test.ts') || item.source.endsWith('batch.ts')))
    assert.equal(initial.checks.typechecked.status, 'not-run')
    assert(initial.coverage.missingIndexes > 0)
    const tests = read(join(workspace, 'batch.test.ts'), 'Inspect the rollback assertion and identify the function under test.')
    const focused = await call('find-implementation', 'The tests call importContacts. Locate its declaration.', 'workspace_search', { workspaceRoot: workspace, question: 'importContacts', scope: 'workspace', limit: 5 })
    const location = focused.results.find(item => item.symbol === 'importContacts' && item.source.endsWith('batch.ts'))
    assert(location)
    read(location.source, 'The loop inserts directly through db, so earlier inserts can survive a later failure.')
    const config = join(workspace, 'tsconfig.json')
    const validation = { config, workspaceRoot: workspace, testCommand: ['npm', 'test'], timeoutMs: 60_000, record: false }
    const failing = await call('before-edit', 'Run the authorized assertions before changing code. Compilation alone cannot establish rollback.', 'workspace_validate', validation)
    assert.equal(failing.checks.typechecked.status, 'pass')
    assert.equal(failing.checks.tested.status, 'fail')
    assert.match(failing.execution.stdout, /must roll back/)
    const context = await call('resolve-dependency', 'Resolve the actual import with the installed compiler before choosing an index version.', 'workspace_context', { config, file: location.source, importSpecifier: 'kysely', symbol: 'Kysely' })
    assert.equal(context.checks.resolved.status, 'pass')
    assert.equal(context.dependency.name, 'kysely')
    assert.equal(context.dependency.version, '0.28.8')
    const dependency = context.dependency
    command('prepare-exact-index', process.execPath, [cli, 'add', `${dependency.name}@${dependency.version}`])
    const api = await call('discover-transaction', 'Search the workspace dependency indexes for the transaction callback. The request still has no package argument.', 'workspace_search', { workspaceRoot: workspace, question: 'TransactionBuilder execute', scope: 'dependencies', limit: 8 })
    const transaction = api.results.find(item => item.package === dependency.name && item.version === dependency.version && item.symbol === 'esm/kysely.TransactionBuilder')
    assert(transaction, 'Expected callback transaction API in the dependency shortlist')
    const symbol = await call('inspect-api', 'Inspect the exact returned symbol and signature before editing.', 'library_symbol', { package: transaction.package, version: transaction.version, symbol: transaction.symbol })
    assert(symbol.results.some(item => item.signature.includes('execute<T>')))
    writeFileSync(location.source, correct)
    record.fileActions.push({ tool: 'ordinary file edit', path: location.source, reason: 'Wrap all parameterized inserts in one transaction callback and let failures escape.', before, after: correct, beforeSha256: hash(before), afterSha256: hash(correct) })
    assert.equal(readFileSync(join(workspace, 'batch.test.ts'), 'utf8'), tests)
    const refreshed = await call('refresh-after-edit', 'Confirm discovery refreshes the changed file.', 'workspace_search', { workspaceRoot: workspace, question: 'importContacts', scope: 'workspace', limit: 5 })
    assert(refreshed.index.updatedFiles >= 1)
    assert(refreshed.results.some(item => item.source === location.source && item.snippet.includes('db.transaction()')))
    const finalContext = await call('resolve-edited-call', 'Inspect the transaction call in the edited source with the workspace compiler.', 'workspace_context', { config, file: location.source, importSpecifier: 'kysely', expectedVersion: dependency.version, position: correct.indexOf('transaction().execute') })
    assert.equal(finalContext.checks.resolved.status, 'pass')
    const passing = await call('after-edit', 'Run the same assertions after the edit and preserve separate evidence states.', 'workspace_validate', validation)
    assert.equal(passing.success, true)
    assert.equal(passing.checks.typechecked.status, 'pass')
    assert.equal(passing.checks.tested.status, 'pass')
    assert.equal(passing.checks.stable.status, 'pass')
    assert.match(passing.execution.stdout, /# pass 2/)
    assert.match(passing.execution.stdout, /O'Reilly/)
    const terminal = JSON.parse(command('cli-equivalent', process.execPath, [cli, 'search', 'importContacts', '--scope', 'workspace', '--json', '--limit', '5']))
    assert(terminal.results.some(item => item.symbol === 'importContacts'))
    record.checks = { passed: true, initialSearchNamedPackage: false, baselineCompilation: failing.checks.typechecked.status, baselineTests: failing.checks.tested.status, finalCompilation: passing.checks.typechecked.status, finalTests: passing.checks.tested.status, finalStability: passing.checks.stable.status, finalArtifactMatch: finalContext.checks.artifactMatch.status, testsUnchanged: true, refreshedFiles: refreshed.index.updatedFiles, cliEquivalent: true }
    record.summary = { initialCoverage: initial.coverage, dependencyCoverage: api.coverage, located: location, selectedApi: transaction, beforeOutput: failing.execution.stdout, afterOutput: passing.execution.stdout }
    const raw = JSON.stringify(normalize(record), null, 2) + '\n'
    const compressed = gzipSync(raw, { level: 9 })
    const archive = join(root, 'artifacts/agent-workflow.json.gz')
    writeFileSync(archive, compressed)
    const project = response => {
      const value = response.structuredContent ?? JSON.parse(response.content.find(item => item.type === 'text').text)
      return { ...('results' in value ? { results: value.results } : {}), ...('coverage' in value ? { coverage: value.coverage } : {}), ...('checks' in value ? { checks: value.checks } : {}), ...('execution' in value ? { execution: value.execution } : {}), ...('dependency' in value ? { dependency: value.dependency } : {}), ...('hover' in value ? { hover: value.hover } : {}), ...('index' in value ? { index: value.index } : {}), ...('status' in value ? { status: value.status } : {}) }
    }
    const summary = normalize({ provenance: record.provenance, checks: record.checks, summary: record.summary, fileActions: record.fileActions, calls: record.calls.map(item => ({ id: item.id, decision: item.decision, request: item.request, resultProjection: project(item.response) })), rawEvidence: { file: 'agent-workflow.json.gz', sha256: hash(compressed), note: 'Full MCP envelopes and command output. This JSON retains explicit projections of responses.' } })
    mkdirSync(join(root, 'docs/showcase'), { recursive: true })
    writeFileSync(join(root, 'docs/showcase/agent-workflow.json'), JSON.stringify(summary, null, 2) + '\n')
    console.log(JSON.stringify({ ...record.checks, summary: 'docs/showcase/agent-workflow.json', rawEvidence: archive }, null, 2))
  }
} finally {
  await client?.close()
  writeFileSync(join(runRoot, 'recording.json'), JSON.stringify(normalize(record), null, 2) + '\n')
}
