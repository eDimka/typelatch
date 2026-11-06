import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const fixtureRoot = resolve(import.meta.dirname, 'fixtures/paired-agent')
export const tasks = JSON.parse(readFileSync(join(fixtureRoot, 'tasks.json'), 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const getTask = id => { const task = tasks.find(task => task.id === id); assert(task, `Unknown task: ${id}`); return task }
const fixtureFor = id => join(fixtureRoot, id === 'sqlite-rollback' ? 'sqlite' : 'parcel-desk')
const generated = path => ['.git', '.typelatch', 'dist'].some(prefix => path === prefix || path.startsWith(prefix + '/'))

export function snapshotTask(workspace) {
  const rows = []
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), key = relative(workspace, path).replaceAll('\\', '/')
      if (generated(key)) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) rows.push({ path: key, kind: 'symlink', target: readlinkSync(path), sha256: digest(readlinkSync(path)) })
      else if (stat.isDirectory()) walk(path)
      else if (stat.isFile()) rows.push({ path: key, kind: 'file', sha256: digest(readFileSync(path)) })
      else rows.push({ path: key, kind: 'special', sha256: null })
    }
  }
  walk(workspace)
  return rows
}

export function taskIntegrity(taskId, before, after) {
  getTask(taskId)
  const old = new Map(before.map(row => [row.path, row])), next = new Map(after.map(row => [row.path, row]))
  const changes = [...new Set([...old.keys(), ...next.keys()])].sort().filter(path => JSON.stringify(old.get(path)) !== JSON.stringify(next.get(path)))
  const editable = path => taskId === 'sqlite-rollback' ? path === 'batch.ts' : /^src\/.+\.ts$/u.test(path)
  const protectedChanges = changes.filter(path => !editable(path) || !old.has(path) || !next.has(path) || next.get(path).kind !== 'file')
  return { passed: protectedChanges.length === 0, changes, protectedChanges, excludedGeneratedRoots: ['.git', '.typelatch', 'dist'], dependenciesIncluded: true }
}

function execute(command, args, cwd, extra = {}) {
  const started = performance.now()
  const env = { ...process.env, ...extra.env }
  // A parent node:test process otherwise disables test execution in the child.
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8_000_000, ...extra, env })
  return { command: [command, ...args], exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, elapsedMs: Math.round(performance.now() - started), stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
const counts = result => ({ ...result, tests: Number(result.stdout.match(/^# tests (\d+)$/m)?.[1] ?? 0), pass: Number(result.stdout.match(/^# pass (\d+)$/m)?.[1] ?? 0), fail: Number(result.stdout.match(/^# fail (\d+)$/m)?.[1] ?? 0), skipped: Number(result.stdout.match(/^# skipped (\d+)$/m)?.[1] ?? 0) })
function copyFixture(taskId, destination) {
  const source = fixtureFor(taskId)
  cpSync(source, destination, { recursive: true, filter: path => !relative(source, path).split(/[\\/]/u).some(part => ['node_modules', '.git', '.typelatch', 'dist'].includes(part)) })
  if (taskId !== 'sqlite-rollback') copyFileSync(join(fixtureRoot, 'grader', taskId === 'preview-accuracy' ? 'repro-preview.test.mjs' : 'repro-partner.test.mjs'), join(destination, 'test/task.test.mjs'))
}
function dependencies(workspace) {
  const paths = ['node_modules/typescript/package.json', ...(existsSync(join(workspace, 'node_modules/kysely/package.json')) ? ['node_modules/kysely/package.json', 'node_modules/better-sqlite3/package.json'] : ['node_modules/effect/package.json', 'packages/preview/node_modules/effect/package.json'])]
  return paths.map(path => { const bytes = readFileSync(join(workspace, path)), value = JSON.parse(bytes); return { path, name: value.name, version: value.version, sha256: digest(bytes) } })
}
function ensureGraderDependencies(taskId) {
  const fixture = fixtureFor(taskId)
  if (!existsSync(join(fixture, 'node_modules/typescript/package.json'))) {
    const install = execute('npm', ['ci', '--no-audit', '--no-fund'], fixture)
    assert.equal(install.exitCode, 0, `Trusted grader installation failed: ${install.stderr}`)
  }
  return fixture
}
function copySource(source, destination) {
  if (lstatSync(source).isSymbolicLink()) throw new Error('Candidate source contains a symbolic link')
  if (lstatSync(source).isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const child of readdirSync(source)) copySource(join(source, child), join(destination, child))
  } else {
    assert(lstatSync(source).isFile(), 'Candidate source must contain regular files')
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
  }
}

export function gradeTask(taskId, workspace, beforeSnapshot) {
  getTask(taskId)
  const fixture = ensureGraderDependencies(taskId)
  const gradeRoot = mkdtempSync(join(tmpdir(), 'typelatch-paired-grade-'))
  const report = { taskId, typecheck: null, apiContract: null, publicTests: null, hiddenTests: null, integrity: beforeSnapshot ? taskIntegrity(taskId, beforeSnapshot, snapshotTask(workspace)) : { passed: null, note: 'No baseline inventory supplied' }, passed: false }
  try {
    copyFixture(taskId, gradeRoot)
    if (taskId === 'sqlite-rollback') copySource(join(workspace, 'batch.ts'), join(gradeRoot, 'batch.ts'))
    else { rmSync(join(gradeRoot, 'src'), { recursive: true }); copySource(join(workspace, 'src'), join(gradeRoot, 'src')) }
    // Only the evaluator can access this trusted dependency tree after the agent exits.
    symlinkSync(join(fixture, 'node_modules'), join(gradeRoot, 'node_modules'))
    const compiler = join(fixture, 'node_modules/typescript/bin/tsc')
    report.typecheck = execute(process.execPath, [compiler, '-p', 'tsconfig.json'], gradeRoot)
    if (report.typecheck.exitCode !== 0) return report
    if (taskId === 'sqlite-rollback') {
      report.publicTests = counts(execute(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', 'batch.test.ts'], gradeRoot))
      copyFileSync(join(fixtureRoot, 'grader/sqlite.test.mjs'), join(gradeRoot, 'hidden.test.mjs'))
      report.hiddenTests = counts(execute(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', 'hidden.test.mjs'], gradeRoot))
    } else {
      copyFileSync(join(fixtureRoot, 'grader/parcel-contract.ts'), join(gradeRoot, 'api-contract.ts'))
      const config = JSON.parse(readFileSync(join(fixture, 'tsconfig.json'), 'utf8'))
      delete config.compilerOptions.rootDir; delete config.compilerOptions.outDir; delete config.compilerOptions.declaration
      writeFileSync(join(gradeRoot, 'contract.json'), JSON.stringify({ compilerOptions: { ...config.compilerOptions, noEmit: true }, files: ['api-contract.ts'] }))
      report.apiContract = execute(process.execPath, [compiler, '-p', 'contract.json'], gradeRoot)
      report.publicTests = counts(execute(process.execPath, ['--test', '--test-reporter=tap', 'test/public.test.mjs', 'test/operations.test.mjs', 'test/task.test.mjs'], gradeRoot))
      copyFileSync(join(fixtureRoot, 'grader/parcel.test.mjs'), join(gradeRoot, 'test/hidden.test.mjs'))
      report.hiddenTests = counts(execute(process.execPath, ['--test', '--test-reporter=tap', 'test/hidden.test.mjs'], gradeRoot, { env: { ...process.env, TYPELATCH_PAIRED_TASK: taskId } }))
    }
    const expectedPublic = taskId === 'sqlite-rollback' ? 2 : 17
    const expectedHidden = taskId === 'sqlite-rollback' ? 8 : 16
    report.passed = report.typecheck.exitCode === 0 && (report.apiContract === null || report.apiContract.exitCode === 0) && report.publicTests.exitCode === 0 && report.publicTests.pass === expectedPublic && report.publicTests.skipped === 0 && report.hiddenTests.exitCode === 0 && report.hiddenTests.pass === expectedHidden && report.hiddenTests.skipped === 0 && report.integrity.passed !== false
    return report
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    return report
  } finally { rmSync(gradeRoot, { recursive: true, force: true }) }
}

export function prepareTask(taskId, destination, { install = true, baseline = true } = {}) {
  const task = getTask(taskId), workspace = resolve(destination)
  assert(!existsSync(workspace) || readdirSync(workspace).length === 0, 'Task destination must be empty')
  const started = performance.now()
  copyFixture(taskId, workspace)
  const installation = install ? execute('npm', ['ci', '--no-audit', '--no-fund'], workspace) : null
  if (installation) assert.equal(installation.exitCode, 0, `Fixture installation failed: ${installation.stderr}`)
  const files = snapshotTask(workspace)
  const report = { workspace, task, fixtureSha256: digest(JSON.stringify(files)), files, setupMs: Math.round(performance.now() - started), installation, dependencyIdentities: install ? dependencies(workspace) : [], baseline: null, baselineMs: 0 }
  if (baseline) {
    const baselineStarted = performance.now()
    report.baseline = gradeTask(taskId, workspace, files)
    report.baselineMs = Math.round(performance.now() - baselineStarted)
    assert.equal(report.baseline.typecheck.exitCode, 0, 'Baseline must compile')
    assert.equal(report.baseline.publicTests.exitCode, 1, 'Baseline must fail its public reproducer')
    assert.equal(report.baseline.publicTests.fail, 1, 'Exactly one public baseline reproducer must fail')
    assert(report.baseline.hiddenTests.fail > 0, 'Baseline must fail semantic assertions')
    assert.equal(report.baseline.integrity.passed, true, 'Preparation must preserve protected files')
  }
  report.setupMs = Math.round(performance.now() - started)
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, taskId, workspace, output] = process.argv.slice(2)
  const result = mode === 'prepare' ? prepareTask(taskId, workspace) : mode === 'grade' ? gradeTask(taskId, workspace) : (() => { throw new Error('Usage: paired-agent-fixtures.mjs prepare|grade task workspace [report.json]') })()
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ taskId, workspace: result.workspace ?? workspace, passed: result.passed ?? result.baseline?.passed, publicTests: result.publicTests?.pass ?? result.baseline?.publicTests?.pass, hiddenTests: result.hiddenTests?.pass ?? result.baseline?.hiddenTests?.pass, output }))
}
