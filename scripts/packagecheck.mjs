import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const directory = mkdtempSync(join(tmpdir(), `${pkg.name}-install-`))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 180_000, ...options })
const env = { ...process.env, APIROVA_HOME: join(directory, 'data'), APIROVA_USAGE: 'off' }
let client
try {
  const packed = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', directory]))[0]
  assert(packed.files.some(file => file.path === 'dist/benchmark/corpus.json'))
  assert.equal(packed.files.filter(file => file.path.startsWith('dist/benchmark/cases/') && file.path.endsWith('.json')).length, 10)
  assert(!packed.files.some(file => /node_modules|\.env|\.db$/.test(file.path)))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', join(directory, packed.filename)], { cwd: directory })
  const installed = join(directory, 'node_modules', pkg.name)
  const cli = join(installed, 'dist/cli.js')
  assert.match(run(process.execPath, [cli, '--help'], { cwd: directory, env }), /local API evidence/)
  const corpusUrl = new URL(`file://${join(installed, 'dist/benchmark/corpus.js')}`).href
  const cases = run(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(corpusUrl)}); console.log(m.loadCorpus().packages.reduce((n, p) => n + m.corpusCaseFile(p.name).length, 0))`], { cwd: directory, env })
  assert.equal(Number(cases.trim()), 73)
  run(process.execPath, [cli, 'add', 'ansi-regex@6.3.0'], { cwd: directory, env })
  const query = JSON.parse(run(process.execPath, [cli, 'query', 'ansi-regex@6.3.0', 'ansiRegex', '--json'], { cwd: directory, env }))
  assert(query.results.length > 0)
  const retrieval = JSON.parse(run(process.execPath, [cli, 'benchmark', 'ansi-regex@6.3.0', '--json'], { cwd: directory, env }))
  assert.equal(retrieval.taskPassRate, 1)
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ['index.ts'] }))
  writeFileSync(join(directory, 'index.ts'), 'export const answer: number = 42\n')
  const request = { config: join(directory, 'tsconfig.json'), record: false, testCommand: [process.execPath, '-e', 'require("node:assert/strict").equal(6 * 7, 42)'] }
  writeFileSync(join(directory, 'request.json'), JSON.stringify(request))
  const validation = JSON.parse(run(process.execPath, [cli, 'validate', join(directory, 'request.json')], { cwd: directory, env }))
  assert.equal(validation.success, true)
  client = new Client({ name: 'releasecheck', version: pkg.version })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(installed, 'dist/mcp.js')], cwd: directory, env })
  await client.connect(transport)
  const listed = await client.listTools()
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['library_feedback', 'library_search', 'library_stats', 'library_symbol', 'workspace_context', 'workspace_validate'])
  const result = await client.callTool({ name: 'library_search', arguments: { package: 'ansi-regex', version: '6.3.0', question: 'ansiRegex' } })
  assert.notEqual(result.isError, true)
  const content = JSON.parse(result.content.find(item => item.type === 'text').text)
  assert(content.results.length > 0)
  writeFileSync(join(directory, 'index.ts'), 'export const answer: number = "wrong"\n')
  const invalid = await client.callTool({ name: 'workspace_validate', arguments: request })
  assert.notEqual(invalid.isError, true)
  const failed = JSON.parse(invalid.content.find(item => item.type === 'text').text)
  assert.equal(failed.success, false)
  assert.equal(failed.checks.typechecked.status, 'fail')
  assert.equal(failed.checks.tested.status, 'not-run')
  console.log('Clean package installation, CLI retrieval, bundled benchmark, six MCP tools, validation and negative control passed.')
} finally {
  await client?.close()
  rmSync(directory, { recursive: true, force: true })
}
