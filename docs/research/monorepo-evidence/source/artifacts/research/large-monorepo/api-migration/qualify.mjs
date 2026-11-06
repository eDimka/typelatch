import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'

const here = import.meta.dirname, base = resolve(here, '..'), privateRoot = join(base, 'truth-private/api-migration-research')
const preparedSource = join(base, 'truth-private/maintenance-research/qualification-002/baseline')
const sourceFile = 'config/config/src/checkGlobalBinDir.ts'
const require = createRequire(import.meta.url), loader = require.resolve('tsx')
assert.equal(JSON.parse(readFileSync(require.resolve('tsx/package.json'))).version, '4.23.13')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const snapshot = path => inventoryTree(path, { excludeDirectories: ['.git', '.typelatch'] })
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

function run(command, args, workspace, env = {}, timeout = 60000) {
  const started = performance.now()
  const result = spawnSync(command, args, { cwd: workspace, env: { ...process.env, TZ: 'UTC', TSX_DISABLE_CACHE: '1', ...env }, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 })
  let parsed = null
  try { parsed = JSON.parse(result.stdout.trim()) } catch {}
  return { command, args, exitCode: result.status, signal: result.signal, elapsedMs: performance.now() - started, stdout: result.stdout, stderr: result.stderr, result: parsed, error: result.error?.code ?? null }
}

function integrity(initial, current) {
  const a = new Map(initial.entries.filter(x => x.kind !== 'directory').map(x => [x.path, x])), b = new Map(current.entries.filter(x => x.kind !== 'directory').map(x => [x.path, x]))
  const changed = [], forbidden = []
  for (const path of new Set([...a.keys(), ...b.keys()])) {
    const before = a.get(path), after = b.get(path)
    if (JSON.stringify(before) === JSON.stringify(after)) continue
    changed.push(path)
    if (!before || !after || before.kind !== 'file' || after.kind !== 'file' || before.mode !== after.mode || !/(^|\/)src\/.+\.ts$/u.test(path) || /(^|\/)(?:node_modules|test|tests|__tests__)(\/|$)|\.(?:test|spec|d)\.ts$/u.test(path)) forbidden.push(path)
  }
  return { passed: forbidden.length === 0, changed, forbidden }
}

export function gradeWorkspace(workspace, initial) {
  const before = snapshot(workspace), guard = integrity(initial, before)
  const checks = guard.passed ? run(process.execPath, ['--import', loader, join(privateRoot, 'final-check.mjs')], workspace) : null
  const stable = before.sha256 === snapshot(workspace).sha256
  return { passed: guard.passed && stable && checks?.exitCode === 0 && checks.result?.passed === true && checks.result.cases === 11, integrity: guard, stable, checks }
}

export function prepareQualification(output) {
  assert(!existsSync(output), 'Every qualification attempt needs a new output directory')
  mkdirSync(output, { recursive: true })
  const evidence = { schemaVersion: 1, status: 'preparing', startedAt: new Date().toISOString(), source: { repository: 'https://github.com/pnpm/pnpm', baselineCommit: 'eaae772717d3d36903960af125a2a2ff9d34fe09', upstreamMigration: '3a5bfaa94fdf28db21cae8d6a86bd8d76ab70a84', upstreamParent: '56b065dd47e71c79aa748c81d76369deef95a529', pullRequest: 'https://github.com/pnpm/pnpm/pull/10930', adaptation: 'Isolate one genuine upstream API migration: @pnpm/config changes its direct can-write-to-dir dependency to2.0.0, while the rest of the older monorepo retains its dependency declarations. This is an explicit upgrade fixture, not an existing defect in the untouched old lockfile.' }, results: {} }
  const persist = () => write(join(output, 'qualification.json'), evidence)
  persist()
  try {
    const beforeManifest = readFileSync(join(preparedSource, 'config/config/package.json')), beforeLock = readFileSync(join(preparedSource, 'pnpm-lock.yaml'))
    const baseInventory = snapshot(preparedSource)
    assert.equal(baseInventory.sha256, '4456c2defad3db384f3febb45378aca969fd0d3362c29ce5e4d2843e2690fc6a')
    const baseline = join(output, 'baseline')
    cpSync(preparedSource, baseline, { recursive: true, dereference: false, verbatimSymlinks: true })
    const manifest = JSON.parse(beforeManifest)
    assert.equal(manifest.name, '@pnpm/config'); assert.equal(manifest.dependencies['can-write-to-dir'], 'catalog:')
    manifest.dependencies['can-write-to-dir'] = '2.0.0'
    write(join(baseline, 'config/config/package.json'), manifest)
    const upstreamBytes = readFileSync(join(privateRoot, 'upstream-lock.yaml')), upstream = YAML.parse(upstreamBytes.toString())
    const adapted = YAML.parse(beforeLock.toString())
    const upgradedClosure = ['can-write-to-dir@2.0.0', 'path-temp@3.0.0', 'unique-string@3.0.0', 'crypto-random-string@4.0.0', 'type-fest@1.4.0']
    adapted.importers['config/config'].dependencies['can-write-to-dir'] = { specifier: '2.0.0', version: '2.0.0' }
    for (const name of upgradedClosure) {
      assert(upstream.packages[name] && upstream.snapshots[name], 'Exact upstream dependency closure required')
      if (adapted.packages[name]) assert.deepEqual(adapted.packages[name], upstream.packages[name])
      if (adapted.snapshots[name]) assert.deepEqual(adapted.snapshots[name], upstream.snapshots[name])
      adapted.packages[name] = upstream.packages[name]; adapted.snapshots[name] = upstream.snapshots[name]
    }
    writeFileSync(join(baseline, 'pnpm-lock.yaml'), YAML.stringify(adapted, { lineWidth: 0 }))
    evidence.lockAdaptation = { upstreamLockSha256: sha(upstreamBytes), upgradedClosure, policy: 'Keep every original importer and package/snapshot entry; change only the selected direct edge and add the exact five-package upstream closure. YAML formatting is regenerated. Then require a frozen install; no unrelated resolver changes are accepted.' }
    const installHome = join(output, 'install-home'); mkdirSync(installHome)
    const emptyConfig = join(installHome, 'empty.npmrc'); writeFileSync(emptyConfig, '')
    const pnpm = join(base, 'tools/pnpm/node_modules/pnpm/bin/pnpm.cjs')
    const args = [pnpm, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(base, 'pnpm-store'), '--config.enableGlobalVirtualStore=false', '--config.managePackageManagerVersions=false', '--config.cleanupUnusedCatalogs=false', '--filter=monorepo-root', '--filter=@pnpm/env.system-node-version...', '--filter=@pnpm/filter-workspace-packages...', '--filter=@pnpm/plugin-commands-patching...', '--filter=@pnpm/config...', '--reporter=append-only']
    evidence.install = run(process.execPath, args, baseline, { HOME: installHome, XDG_CONFIG_HOME: join(installHome, 'config'), XDG_CACHE_HOME: join(installHome, 'cache'), npm_config_userconfig: emptyConfig, CI: '1' }, 180000)
    persist(); assert.equal(evidence.install.exitCode, 0, 'Script-disabled isolated upgrade must install successfully')
    const afterLock = readFileSync(join(baseline, 'pnpm-lock.yaml')), oldLock = YAML.parse(beforeLock.toString()), newLock = YAML.parse(afterLock.toString())
    assert.deepEqual(Object.keys(oldLock.importers), Object.keys(newLock.importers))
    for (const [name, importer] of Object.entries(oldLock.importers)) if (name !== 'config/config') assert.deepEqual(newLock.importers[name], importer, `Unrelated lock importer changed: ${name}`)
    const expectedImporter = structuredClone(oldLock.importers['config/config'])
    expectedImporter.dependencies['can-write-to-dir'] = { specifier: '2.0.0', version: '2.0.0' }
    assert.deepEqual(newLock.importers['config/config'], expectedImporter)
    assert.equal(newLock.snapshots['can-write-to-dir@2.0.0'].dependencies['path-temp'], '3.0.0', 'Pin the same transitive version as the real upstream migration')
    assert.equal(newLock.packages['can-write-to-dir@2.0.0'].resolution.integrity, 'sha512-4wXLh+SqvKDzWND9SGE8cWllVMc65LxHVrCePc56IbfrtORUyxTWCVMI8rbGIVRBSNf5C+zbfaken7Abs34AEQ==', 'Dependency bytes must match the real upstream lockfile')
    assert.equal(newLock.packages['path-temp@3.0.0'].resolution.integrity, 'sha512-5lJ7KUrynYR0TTTiU9SELstnX2fhz8qJ1rBfsEaI1IT3WDWcVkrg8T3lTUSJ/LJkIvrolbF0cFcq9shBC0jzxQ==', 'Transitive bytes must match the real upstream lockfile')
    const changedSource = []
    for (const entry of baseInventory.entries.filter(entry => entry.kind === 'file' && !entry.path.split('/').includes('node_modules'))) {
      if (sha(readFileSync(join(baseline, entry.path))) !== entry.sha256) changedSource.push(entry.path)
    }
    assert.deepEqual(changedSource.toSorted(), ['config/config/package.json', 'pnpm-lock.yaml'].toSorted(), 'Only the declared dependency manifest and lockfile may change during installation')
    const packagePath = realpathSync(join(baseline, 'config/config/node_modules/can-write-to-dir'))
    const dependencyManifest = JSON.parse(readFileSync(join(packagePath, 'package.json')))
    assert.equal(dependencyManifest.name, 'can-write-to-dir'); assert.equal(dependencyManifest.version, '2.0.0')
    const declaration = readFileSync(join(packagePath, dependencyManifest.types ?? 'index.d.ts'), 'utf8')
    assert.match(declaration, /canWriteToDirSync/u)
    evidence.upgrade = { importer: 'config/config', beforeManifestSha256: sha(beforeManifest), afterManifestSha256: sha(readFileSync(join(baseline, 'config/config/package.json'))), beforeLockSha256: sha(beforeLock), afterLockSha256: sha(afterLock), package: { name: dependencyManifest.name, version: dependencyManifest.version, root: packagePath, treeSha256: snapshot(packagePath).sha256, declarationSha256: sha(declaration), integrity: newLock.packages['can-write-to-dir@2.0.0'].resolution.integrity, transitive: { name: 'path-temp', version: '3.0.0', integrity: newLock.packages['path-temp@3.0.0'].resolution.integrity } }, unrelatedImportersUnchanged: true, changedSource }
    const rootManifest = JSON.parse(readFileSync(join(baseline, 'package.json')))
    rootManifest.scripts['test:typelatch-benchmark'] = `TZ=UTC TSX_DISABLE_CACHE=1 node --import ${quote(loader)} ${quote(join(here, 'public-check.mjs'))}`
    write(join(baseline, 'package.json'), rootManifest)
    const initial = snapshot(baseline)
    evidence.baselineTreeSha256 = initial.sha256
    write(join(output, 'baseline-manifest.json'), initial)
    const original = readFileSync(join(baseline, sourceFile), 'utf8')
    const oldImport = "import { sync as canWriteToDir } from 'can-write-to-dir'"
    assert.equal(original.split(oldImport).length, 2)
    const reference = original.replace(oldImport, "import { canWriteToDirSync } from 'can-write-to-dir'").replace('return canWriteToDir(dir)', 'return canWriteToDirSync(dir)')
    const asyncControl = original.replace(oldImport, "import { canWriteToDir } from 'can-write-to-dir'")
    for (const [name, source] of [['reference', reference], ['async-control', asyncControl]]) {
      const path = join(output, name); cpSync(baseline, path, { recursive: true, dereference: false, verbatimSymlinks: true }); writeFileSync(join(path, sourceFile), source)
    }
    evidence.reference = { path: sourceFile, beforeSha256: sha(original), afterSha256: sha(reference), mapping: 'The exact upstream import and call-site API substitutions, applied to the older unchanged consumer.' }
    evidence.fixtureAdaptations = ['Full corpus from the qualified pnpm task, including its two prerequisite builds and exact committed symlink restoration.', 'One direct dependency declaration and explicit lockfile upgrade using the exact upstream five-package closure; every unrelated importer and original package/snapshot entry is preserved. YAML formatting regenerated. Frozen install with lifecycle scripts disabled; original committed metadata hook retained. Override cleanupUnusedCatalogs:false for this install so the original workspace config stays byte-identical.', 'Root native test script points to the supplied public upgrade checks. Only the real global-bin validator subsystem executes; no full CLI build/test claim.']
    evidence.harness = ['qualify.mjs', 'case-engine.mjs', 'public-check.mjs'].map(path => ({ path, sha256: sha(readFileSync(join(here, path))) }))
    evidence.privateHarness = { path: 'final-check.mjs', sha256: sha(readFileSync(join(privateRoot, 'final-check.mjs'))) }
    for (const name of ['baseline', 'reference', 'async-control']) {
      const path = join(output, name)
      evidence.results[name] = { public: run(process.execPath, ['--import', loader, join(here, 'public-check.mjs')], path), private: gradeWorkspace(path, initial) }
      persist()
    }
    evidence.publicCommand = run('npm', ['run', 'test:typelatch-benchmark'], baseline)
    evidence.checks = { baselineFailsIntendedCase: evidence.results.baseline.public.result?.results.find(row => row.id === 'writable-global-directory')?.passed === false && evidence.results.baseline.public.result?.results.filter(row => row.id !== 'writable-global-directory').every(row => row.passed), baselineLoadedAndAllCasesExecuted: evidence.results.baseline.private.checks?.result?.cases === 11, referencePasses: evidence.results.reference.public.result?.passed === true && evidence.results.reference.private.passed === true, asyncControlFails: evidence.results['async-control'].private.checks?.result?.failed > 0, publicCommandFailsAsExpected: evidence.publicCommand.exitCode === 1 && evidence.publicCommand.stdout.includes('writable-global-directory'), originalPreparedCorpusUnchanged: snapshot(preparedSource).sha256 === baseInventory.sha256 }
    evidence.status = Object.values(evidence.checks).every(Boolean) ? 'qualified' : 'qualification-failed'; evidence.completedAt = new Date().toISOString(); persist()
    assert.equal(evidence.status, 'qualified', 'Inspect retained failed qualification; do not run a coding agent')
    return { status: evidence.status, output, baselineTreeSha256: initial.sha256, checks: evidence.checks, cases: Object.fromEntries(Object.entries(evidence.results).map(([name, result]) => [name, { publicFailed: result.public.result.failed, privateFailed: result.private.checks.result.failed }])) }
  } catch (error) { evidence.status = 'qualification-failed'; evidence.error = { name: error.name, message: error.message }; persist(); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { assert.equal(process.argv[2], '--prepare'); assert(process.argv[3]); console.log(JSON.stringify(prepareQualification(resolve(process.argv[3])))) }
