import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repo = resolve('.')
const codegraph = process.env.CODEGRAPH_BIN
const python = process.env.GRAPHIFY_PYTHON
if (!codegraph || !python) throw new Error('Set CODEGRAPH_BIN and GRAPHIFY_PYTHON to the isolated pinned installations')
const run = resolve('artifacts/competitive/agent-eval', new Date().toISOString().replaceAll(':', '-'))
mkdirSync(run, { recursive: true })
const token = randomUUID()
const sessions = new Map()
const files = root => readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)])
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const frozen = JSON.parse(readFileSync('artifacts/competitive/agent-eval-frozen/freeze.json', 'utf8'))
for (const entry of frozen.manifest) if (hash(join('scripts/fixtures/agent-eval', entry.path)) !== entry.sha256) throw new Error(`Frozen fixture changed: ${entry.path}`)
for (const [path, digest] of Object.entries(frozen.grader)) if (hash(join('scripts', path)) !== digest) throw new Error(`Frozen grader changed: ${path}`)
cpSync('artifacts/competitive/agent-eval-frozen/freeze.json', join(run, 'freeze.json'))
cpSync('artifacts/competitive/agent-eval-frozen/task.txt', join(run, 'task.txt'))
writeFileSync(join(run, 'implementation.json'), JSON.stringify({ product: Object.fromEntries(files('src').map(path => [path, hash(path)])), harness: Object.fromEntries(['scripts/agent-eval-server.mjs', 'scripts/agent-eval-client.mjs', 'scripts/agent-eval-grade.mjs', 'scripts/fixtures/agent-eval-grader.test.mjs'].map(path => [path, hash(path)])) }, null, 2))
const log = (session, record) => appendFileSync(join(run, `${session.id}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n')
const setup = (command, args, env, cwd) => {
  try { return { status: 0, stdout: execFileSync(command, args, { env, cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 }) } }
  catch (error) { return { status: error.status, stdout: error.stdout?.toString(), stderr: error.stderr?.toString(), error: error.message } }
}
for (const id of ['typelatch', 'codegraph', 'graphify']) {
  const root = join(run, id, 'repo')
  const home = join(run, id, 'home')
  cpSync('scripts/fixtures/agent-eval', root, { recursive: true })
  mkdirSync(home, { recursive: true })
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
    DO_NOT_TRACK: '1', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_NO_DAEMON: '1', GRAPHIFY_QUERY_LOG_DISABLE: '1', GRAPHIFY_NO_AUTO_REFRESH: '1',
    TYPELATCH_USAGE: 'off', TYPELATCH_HOME: join(run, id, 'data') }
  execFileSync('git', ['init', '-q', root], { env })
  const session = { id, root, env, calls: 0, tests: 0, busy: false, edits: [], baseline: setup(process.execPath, ['--experimental-strip-types', join(repo, 'scripts/agent-eval-grade.mjs'), root], env, repo) }
  log(session, { action: 'baseline', output: session.baseline })
  if (session.baseline.status === 0) throw new Error('Evaluation baseline must fail its behavioral assertions')
  const prepared = id === 'codegraph' ? setup(codegraph, ['init', root, '--yes'], env, root)
    : id === 'graphify' ? setup(python, ['-m', 'graphify', 'extract', root, '--code-only', '--no-cluster', '--out', root], env, root) : { status: 0 }
  log(session, { action: 'provider-setup', output: prepared })
  if (prepared.status !== 0) throw new Error(`Cannot prepare ${id}: ${JSON.stringify(prepared)}`)
  const command = id === 'codegraph' ? codegraph : id === 'graphify' ? python : process.execPath
  const args = id === 'codegraph' ? ['serve', '--mcp', '--path', root] : id === 'graphify' ? ['-m', 'graphify.serve', join(root, 'graphify-out/graph.json')] : [join(repo, 'dist/mcp.js')]
  const transport = new StdioClientTransport({ command, args, cwd: root, env, stderr: 'pipe' })
  transport.stderr.on('data', data => log(session, { action: 'provider-stderr', output: data.toString() }))
  session.client = new Client({ name: 'typelatch-coding-pilot', version: '1.0.0' })
  await session.client.connect(transport, { timeout: 90_000 })
  session.schemas = await session.client.listTools()
  log(session, { action: 'schemas', output: session.schemas })
  sessions.set(id, session)
}

function sourcePath(session, path, editable = false) {
  if (typeof path !== 'string') throw new Error('Supply a relative source path')
  const target = resolve(session.root, path)
  if (!target.startsWith(session.root + sep) || !existsSync(target) || realpathSync(target) !== target) throw new Error('Path must be an existing regular file within the fixture')
  const rel = relative(session.root, target)
  if (rel.startsWith('.') || rel.startsWith('graphify-out') || rel.includes('node_modules')) throw new Error('Only fixture source and documentation are readable')
  if (editable && !/^src\/[^/]+\.ts$/.test(rel)) throw new Error('Only existing src/*.ts files are editable')
  return target
}
async function act(session, input) {
  if (session.busy) throw new Error('One action at a time')
  if (session.calls >= 16) throw new Error('Action budget exhausted')
  session.calls++
  session.busy = true
  const start = performance.now()
  try {
    let output
    if (input.action === 'query') {
      if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 2000) throw new Error('Supply a question of 1 through 2000 characters')
      const request = session.id === 'typelatch'
        ? { name: 'workspace_search', arguments: { workspaceRoot: session.root, question: input.question, scope: 'workspace', detail: 'compact', limit: 8 } }
        : session.id === 'codegraph' ? { name: 'codegraph_explore', arguments: { query: input.question, maxFiles: 8, projectPath: session.root } }
          : { name: 'query_graph', arguments: { question: input.question, token_budget: 2000 } }
      const response = await session.client.callTool(request, undefined, { timeout: 90_000 })
      output = { isError: response.isError ?? false, text: response.content.filter(item => item.type === 'text').map(item => item.text).join('\n') }
      log(session, { action: 'raw-mcp', request, response })
    } else if (input.action === 'list') {
      output = files(session.root).map(path => relative(session.root, path)).filter(path => !path.startsWith('.') && !path.startsWith('graphify-out'))
    } else if (input.action === 'read') {
      output = readFileSync(sourcePath(session, input.path), 'utf8')
    } else if (input.action === 'edit') {
      if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 80_000) throw new Error('Supply complete file text under 80KB')
      const path = sourcePath(session, input.path, true)
      const before = readFileSync(path, 'utf8')
      writeFileSync(path, input.text)
      session.edits.push({ path: input.path, before, after: input.text })
      output = { written: input.path, bytes: Buffer.byteLength(input.text) }
    } else if (input.action === 'test') {
      if (session.tests >= 3) throw new Error('Grader budget exhausted')
      session.tests++
      output = setup(process.execPath, ['--experimental-strip-types', join(repo, 'scripts/agent-eval-grade.mjs'), session.root], session.env, repo)
    } else throw new Error('Unknown action')
    log(session, { action: input.action, input, output, elapsedMs: performance.now() - start, callsUsed: session.calls, testsUsed: session.tests })
    return { output, callsRemaining: 16 - session.calls, testsRemaining: 3 - session.tests }
  } catch (error) {
    log(session, { action: input.action, input, error: error.message, elapsedMs: performance.now() - start })
    throw error
  } finally { session.busy = false }
}
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json')
  try {
    if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${token}`) throw new Error('Unauthorized')
    let body = ''
    for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 100_000) throw new Error('Request too large') }
    const input = JSON.parse(body)
    const session = sessions.get(input.session)
    if (!session) throw new Error('Unknown session')
    response.end(JSON.stringify(await act(session, input)))
  } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error.message })) }
})
server.listen(0, '127.0.0.1', () => {
  const control = { url: `http://127.0.0.1:${server.address().port}`, token, run, sessions: [...sessions.keys()] }
  writeFileSync(join(run, 'control.json'), JSON.stringify(control, null, 2))
  writeFileSync('artifacts/competitive/agent-eval-current.json', JSON.stringify({ control: join(run, 'control.json'), run }))
  console.log(JSON.stringify({ ready: true, control: join(run, 'control.json'), run }))
})
async function close() {
  for (const session of sessions.values()) {
    const final = setup(process.execPath, ['--experimental-strip-types', join(repo, 'scripts/agent-eval-grade.mjs'), session.root], session.env, repo)
    log(session, { action: 'final-grade', output: final, calls: session.calls, tests: session.tests, edits: session.edits })
    await session.client.close()
  }
  server.close(() => process.exit(0))
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
