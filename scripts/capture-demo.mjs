import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { demoHash, successfulDemoMcp, normalizeDemo, publicDemoActions, snapshotDemoFiles, verifyAssertionOutput, verifyDemoActions, verifyDemoFiles } from './demo-evidence.mjs'

const root = resolve(import.meta.dirname, '..')
const harnessBefore = demoHash(readFileSync(import.meta.filename))
const verifierBefore = demoHash(readFileSync(join(root, 'scripts/demo-evidence.mjs')))
const outputRoot = join(root, 'artifacts/demo')
mkdirSync(outputRoot, { recursive: true })
const output = mkdtempSync(join(outputRoot, 'run-'))
let workspace = process.argv[2]
if (!workspace) {
  const prepared = spawnSync(process.execPath, ['scripts/showcase-agent.mjs', '--prepare-only'], { cwd: root, encoding: 'utf8', timeout: 180_000 })
  assert.equal(prepared.status, 0, prepared.stderr)
  workspace = JSON.parse(prepared.stdout).workspaceRoot
}
workspace = resolve(workspace)
const preparedIndex = spawnSync(process.execPath, [join(root, 'dist/cli.js'), 'sync', '--json'], { cwd: workspace, env: { ...process.env, TYPELATCH_HOME: join(workspace, '.typelatch'), TYPELATCH_USAGE: 'off' }, encoding: 'utf8', timeout: 180_000, maxBuffer: 8_000_000 })
assert.equal(preparedIndex.status, 0, preparedIndex.stderr)
const preparation = JSON.parse(preparedIndex.stdout)
assert.equal(preparation.success, true, 'Dependency preparation must finish without an operational error; explicit unsupported packages remain visible')
const fixtureBefore = snapshotDemoFiles(workspace)
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'batch.test.ts', 'batch.ts']) assert(fixtureBefore.some(entry => entry.path === file && entry.kind === 'file'), `Required fixture file: ${file}`)
const sourcePath = join(workspace, 'batch.ts')
const before = readFileSync(sourcePath, 'utf8')
const beforeSha256 = demoHash(before)
const testsBefore = fixtureBefore.find(file => file.path === 'batch.test.ts').sha256
const initialCheck = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 })
assert.equal(initialCheck.status, 1, 'The prepared exercise must fail its original rollback assertion')
verifyAssertionOutput(initialCheck.stdout, false)
assert.deepEqual(snapshotDemoFiles(workspace), fixtureBefore, 'Baseline execution must preserve fixture files')
const distBefore = snapshotDemoFiles(join(root, 'dist'), [])
const packageBefore = demoHash(readFileSync(join(root, 'package.json')))
const cliVersion = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 30_000 })
assert.equal(cliVersion.status, 0, 'Codex CLI version must be captured')
const prompt = `Contact imports leave partial data after a duplicate name. Find the implementation and fix whole batch rollback while preserving parameter binding.
Use the typelatch MCP tools as your first stop for workspace discovery and exact dependency API evidence. Start with workspace_search using detail source. Inspect the relevant exact API through library_symbol or workspace_context before editing. You may use normal file tools to inspect and edit as needed. I authorize the existing npm test assertions in this isolated exercise. Run them through workspace_validate before and after the fix. Edit only the implementation file you locate; never tests, dependencies or configuration, and do not create files. Do not make commits or access files outside this isolated exercise. This is a public demonstration of your actual work, not a benchmark. Report what the checks establish.`
const config = {
  approval_policy: 'never',
  project_doc_max_bytes: 0,
  'features.apps': false,
  'features.plugins': false,
  'features.multi_agent': false,
  'mcp_servers.typelatch.command': process.execPath,
  'mcp_servers.typelatch.args': [join(root, 'dist/mcp.js')],
  'mcp_servers.typelatch.cwd': workspace,
  'mcp_servers.typelatch.env.TYPELATCH_HOME': join(workspace, '.typelatch'),
  'mcp_servers.typelatch.env.TYPELATCH_USAGE': 'off',
  'mcp_servers.typelatch.startup_timeout_sec': 60,
  'mcp_servers.typelatch.tool_timeout_sec': 180,
}
for (const tool of ['workspace_search', 'workspace_context', 'workspace_validate', 'library_search', 'library_symbol', 'library_feedback', 'library_stats']) config[`mcp_servers.typelatch.tools.${tool}.approval_mode`] = 'approve'
const args = ['exec', '--ignore-user-config', '--ephemeral', '--json', '--color', 'never', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--cd', workspace]
for (const [key, value] of Object.entries(config)) args.push('-c', key + '=' + JSON.stringify(value))
args.push(prompt)
const env = Object.fromEntries(['HOME', 'CODEX_HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
const startedAt = new Date().toISOString()
// Preserve genuine prelaunch state even when a later export check fails.
writeFileSync(join(output, 'before-session.json'), JSON.stringify({
  schemaVersion: 1, root, workspace, startedAt, prompt, config,
  harnessSha256: harnessBefore, evidenceVerifierSha256: verifierBefore,
  packageVersion: JSON.parse(readFileSync(join(root, 'package.json'))).version,
  packageJsonSha256: packageBefore, codexCliVersion: cliVersion.stdout.trim(),
  nodeVersion: process.version, platform: process.platform,
  originalSource: before, beforeSha256, testsBefore, fixtureBefore, distBefore,
  preparation: { exitCode: preparedIndex.status, result: preparation, stderr: preparedIndex.stderr },
  baselineVerification: { command: ['npm', 'test'], exitCode: initialCheck.status, stdout: initialCheck.stdout, stderr: initialCheck.stderr },
}, null, 2) + '\n', { mode: 0o600 })
const child = spawn('codex', args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = '', stderr = ''
child.stdout.on('data', data => { stdout += data })
child.stderr.on('data', data => { stderr += data })
const timer = setTimeout(() => child.kill('SIGTERM'), 600_000)
const exitCode = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) })
clearTimeout(timer)
// Raw events can contain private model analysis. Export only completed public tool actions.
writeFileSync(join(output, 'raw-events.jsonl'), stdout, { mode: 0o600 })
writeFileSync(join(output, 'stderr.txt'), stderr, { mode: 0o600 })
assert.equal(exitCode, 0, `Codex run failed; inspect ignored ${output}/stderr.txt`)
const rows = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
const actions = publicDemoActions(rows)
const after = readFileSync(sourcePath, 'utf8')
const afterSha256 = demoHash(after)
const fixtureAfter = snapshotDemoFiles(workspace)
verifyDemoFiles(fixtureBefore, fixtureAfter)
const qualified = verifyDemoActions(actions, { workspace, beforeSha256, afterSha256 })
const verification = spawnSync('npm', ['test'], { cwd: workspace, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000 })
assert.equal(verification.status, 0, verification.stdout + verification.stderr)
verifyAssertionOutput(verification.stdout, true)
assert.deepEqual(snapshotDemoFiles(workspace), fixtureAfter, 'Independent final execution must preserve fixture files')
assert.deepEqual(snapshotDemoFiles(join(root, 'dist'), []), distBefore, 'The executed Typelatch build must not change during capture')
assert.equal(demoHash(readFileSync(join(root, 'package.json'))), packageBefore, 'Package identity must not change during capture')
assert.equal(demoHash(readFileSync(import.meta.filename)), harnessBefore, 'Capture harness must not change during the run')
assert.equal(demoHash(readFileSync(join(root, 'scripts/demo-evidence.mjs'))), verifierBefore, 'Evidence verifier must not change during the run')
const normalize = value => normalizeDemo(value, [[workspace, '$WORKSPACE'], [root, '$REPOSITORY'], [homedir(), '$USER_HOME'], [process.execPath, '$NODE']])
const mcpActions = actions.filter(item => item.type === 'mcp_tool_call')
const record = normalize({
  provenance: {
    startedAt, finishedAt: new Date().toISOString(), kind: 'Actual Codex CLI session on an authored isolated exercise',
    codexCliVersion: cliVersion.stdout.trim(), nodeVersion: process.version, platform: process.platform,
    packageVersion: JSON.parse(readFileSync(join(root, 'package.json'))).version,
    packageSource: 'Built development checkout, not a registry installation',
    preparation: 'Installed authored fixture dependencies and ran typelatch sync before the agent session. Explicit unsupported dependencies remain in preparation.result. Local MCP tools were approved for the isolated exercise.',
    prompt, toolPreference: 'Prompt explicitly requests Typelatch first, source mode and before/after MCP validation; no implementation or solution supplied',
    recording: 'Completed public tool actions only. Model analysis and native session/item identifiers are excluded. Tool evidence identifiers are retained. Workspace, repository, home and temporary paths are normalized.',
    elapsedPlayback: 'Animation timing is edited for readability, not measured task time',
    harnessSha256: harnessBefore, evidenceVerifierSha256: verifierBefore,
    distManifestSha256: demoHash(JSON.stringify(distBefore)), distManifest: distBefore,
    limitations: ['One prompted session on an authored exercise, with prepared dependency indexes; no comparison or token saving is measured.', 'Fixture file inventory excludes node_modules, .git and .typelatch. Endpoint hashes and completed actions do not prove the absence of all transient or external activity.', 'Exact served model identity and complete process lifecycle are not established by this export.'],
  },
  preparation: { command: ['typelatch', 'sync', '--json'], exitCode: preparedIndex.status, result: preparation, stderr: preparedIndex.stderr },
  actions, qualified,
  change: { file: 'batch.ts', before, after, beforeSha256, afterSha256 },
  fixture: { excludedDirectories: ['node_modules', '.git', '.typelatch'], before: fixtureBefore, after: fixtureAfter, onlyImplementationChanged: true },
  baselineVerification: { command: ['npm', 'test'], exitCode: initialCheck.status, stdout: initialCheck.stdout, stderr: initialCheck.stderr },
  verification: { command: ['npm', 'test'], exitCode: verification.status, stdout: verification.stdout, stderr: verification.stderr, testsUnchanged: true, testSha256: testsBefore },
  counts: { mcpCalls: mcpActions.length, successfulMcpCalls: mcpActions.filter(item => successfulDemoMcp(item)).length, failedMcpCalls: mcpActions.filter(item => !successfulDemoMcp(item)).length,
    shellCommands: actions.filter(item => item.type === 'command_execution').length,
    grepCommands: actions.filter(item => item.type === 'command_execution' && /\b(?:rg|grep)\b/.test(item.command)).length,
    grepCountMeaning: 'Completed shell command strings containing the word rg or grep. A compound command counts once; this does not count arbitrary text searching or compare another agent run.' },
})
const serialized = JSON.stringify(record, null, 2) + '\n'
assert.doesNotMatch(serialized, /\/(?:Users|home)\/[A-Za-z0-9._-]+|\/(?:private\/)?var\/folders\//)
writeFileSync(join(root, 'docs/showcase/codex-session.json'), serialized)
console.log(JSON.stringify({ workspace, counts: record.counts, testsUnchanged: true, testsPassed: true, output: 'docs/showcase/codex-session.json' }, null, 2))
