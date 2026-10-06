import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const fixture = join(scripts, 'fixtures/agent-eval')
const output = resolve(process.argv[2] ?? 'artifacts/competitive/agent-eval')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]).sort()
const manifest = walk(fixture).map(path => ({ path: relative(fixture, path), bytes: readFileSync(path).length, sha256: sha256(readFileSync(path)) }))
const graderFiles = ['agent-eval-grade.mjs', 'fixtures/agent-eval-grader.test.mjs', 'fixtures/agent-eval-tasks.json']
const grader = Object.fromEntries(graderFiles.map(path => [path, sha256(readFileSync(join(scripts, path)))]))
assert(!existsSync(join(output, 'freeze.json')), 'Choose a new output directory; a frozen evaluation must not be overwritten')
mkdirSync(output, { recursive: true })
const tasks = JSON.parse(readFileSync(join(scripts, 'fixtures/agent-eval-tasks.json'), 'utf8'))
writeFileSync(join(output, 'task.txt'), tasks.prompt + '\n')
const workspaces = {}
for (const provider of ['baseline', 'typelatch', 'codegraph', 'graphify']) {
  const workspace = join(output, provider, 'repo')
  cpSync(fixture, workspace, { recursive: true })
  execFileSync('git', ['init', '-q', workspace])
  workspaces[provider] = workspace
}
const frozen = { schemaVersion: 1, generatedAt: new Date().toISOString(), node: process.version, kind: 'Two task exploratory agent coding pilot', manifest, corpusSha256: sha256(JSON.stringify(manifest)), grader, tasks, workspaces, limits: tasks.limits, providerRetrievalStarted: false }
frozen.freezeSha256 = sha256(JSON.stringify(frozen))
writeFileSync(join(output, 'freeze.json'), JSON.stringify(frozen, null, 2) + '\n')
const baseline = spawnSync(process.execPath, [join(scripts, 'agent-eval-grade.mjs'), workspaces.baseline], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 })
const transcript = `${baseline.stdout ?? ''}${baseline.stderr ?? ''}`
writeFileSync(join(output, 'baseline-grade.txt'), transcript)
const failCount = Number(transcript.match(/^# fail (\d+)$/m)?.[1])
const passCount = Number(transcript.match(/^# pass (\d+)$/m)?.[1])
assert.equal(baseline.status, 1, 'The untouched fixture must fail its behavior grader')
assert.ok(transcript.includes('TypeScript compile: passed'), 'Baseline must compile before behavioral failures count')
assert.ok(transcript.includes('not ok 1 - cache:') && transcript.includes('not ok 7 - retry:'), 'Both requested fixes must have demonstrated baseline failures')
assert.ok(failCount > 0 && passCount > 0, 'Baseline needs behavioral failures and passing negative controls')
const result = { freezeSha256: frozen.freezeSha256, baselineExitCode: baseline.status, passCount, failCount, transcriptSha256: sha256(transcript), transcriptPath: join(output, 'baseline-grade.txt'), workspaces, taskPrompt: join(output, 'task.txt'), freeze: join(output, 'freeze.json') }
writeFileSync(join(output, 'baseline-result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
