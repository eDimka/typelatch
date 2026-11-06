import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'

const here = import.meta.dirname
const corpus = resolve(here, '../pnpm-installed')
const privateRoot = resolve(here, '../truth-private/maintenance-research')
const sourceFile = 'workspace/filter-workspace-packages/src/getChangedPackages.ts'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const require = createRequire(import.meta.url)
const loader = require.resolve('tsx')
assert.equal(JSON.parse(readFileSync(require.resolve('tsx/package.json'))).version, '4.23.13')
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const snapshot = path => inventoryTree(path, { excludeDirectories: ['.git', '.typelatch'] })

function run(command, args, cwd, timeout = 60000) {
  const start = performance.now()
  const result = spawnSync(command, args, { cwd, env: { ...process.env, TZ: 'UTC', TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 })
  let parsed = null
  try { parsed = JSON.parse(result.stdout.trim()) } catch {}
  return { elapsedMs: performance.now() - start, command, args, cwd, exitCode: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, result: parsed }
}

function sourceStable(workspace, allowed = [], checkSymlinks = true) {
  const source = JSON.parse(readFileSync(resolve(here, '../corpus-inventory.json')))
  const mismatches = source.entries.filter(entry => entry.kind === 'file' && !allowed.includes(entry.path) && (!existsSync(join(workspace, entry.path)) || sha256(readFileSync(join(workspace, entry.path))) !== entry.sha256)).map(entry => entry.path)
  if (checkSymlinks) for (const entry of source.entries.filter(item => item.kind === 'symlink')) {
    try { if (readlinkSync(join(workspace, entry.path)) !== entry.target) mismatches.push(entry.path) } catch { mismatches.push(entry.path) }
  }
  return { passed: mismatches.length === 0, mismatches }
}

function guard(initial, current) {
  const before = new Map(initial.entries.filter(x => x.kind !== 'directory').map(x => [x.path, x]))
  const after = new Map(current.entries.filter(x => x.kind !== 'directory').map(x => [x.path, x]))
  const changed = [], forbidden = []
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path), b = after.get(path)
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    changed.push(path)
    if (!a || !b || a.kind !== 'file' || b.kind !== 'file' || a.mode !== b.mode || !/(^|\/)src\/.+\.ts$/u.test(path) || /(^|\/)(?:node_modules|test|tests|__tests__)(\/|$)|\.(?:test|spec|d)\.ts$/u.test(path)) forbidden.push(path)
  }
  return { passed: forbidden.length === 0, changed, forbidden }
}

export function gradeWorkspace(workspace, initial) {
  const before = snapshot(workspace), integrity = guard(initial, before)
  const checks = integrity.passed ? run(process.execPath, ['--import', loader, join(privateRoot, 'final-check.mjs')], workspace) : null
  const stable = before.sha256 === snapshot(workspace).sha256
  return { passed: integrity.passed && stable && checks?.exitCode === 0 && checks.result?.passed === true && checks.result.cases === 15, integrity, stable, checks }
}

export function prepareQualification(output) {
  assert(!existsSync(output), 'Every preparation attempt requires a new directory')
  mkdirSync(output, { recursive: true })
  const evidence = { schemaVersion: 1, status: 'preparing', startedAt: new Date().toISOString(), source: { repository: 'https://github.com/pnpm/pnpm', baselineCommit: 'eaae772717d3d36903960af125a2a2ff9d34fe09', upstreamRepair: 'b809cfdd75145edf12dc56332752946b4b7fb4e1', upstreamParent: 'b34ab3f7e16c99b9064f6a7edc99c7a78b4ba1fe', issue: 'https://github.com/pnpm/pnpm/issues/15481', pullRequest: 'https://github.com/pnpm/pnpm/pull/15493', adaptation: 'Backport the identical --no-renames Git option to the old TypeScript module path. The selected older TS monorepo is not the direct parent of the upstream repair.' }, results: {} }
  const persist = () => writeFileSync(join(output, 'qualification.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 })
  persist()
  try {
    assert(sourceStable(corpus, [], false).passed, 'Atomic installed corpus source changed')
    const baseline = join(output, 'baseline')
    cpSync(corpus, baseline, { recursive: true, dereference: false, verbatimSymlinks: true })
    const committedLinks = JSON.parse(readFileSync(resolve(here, '../corpus-inventory.json'))).entries.filter(entry => entry.kind === 'symlink')
    evidence.committedSymlinkNormalization = []
    for (const entry of committedLinks) {
      const path = join(baseline, entry.path), before = readlinkSync(path)
      if (before === entry.target) continue
      unlinkSync(path); symlinkSync(entry.target, path)
      evidence.committedSymlinkNormalization.push({ path: entry.path, before, after: entry.target, reason: 'Restore exact committed link text; initial prepared corpus had rewritten absolute links.' })
    }
    assert(sourceStable(baseline).passed, 'Normalized source files and committed links must match original inventory')
    const tsc = join(baseline, 'node_modules/typescript/bin/tsc')
    evidence.build = run(process.execPath, [tsc, '--build', 'packages/error'], baseline)
    persist()
    assert.equal(evidence.build.exitCode, 0, 'Only the constants/error prerequisite build must succeed')
    assert(sourceStable(baseline).passed, 'Build changed committed source')
    const manifestPath = join(baseline, 'package.json'), manifest = JSON.parse(readFileSync(manifestPath))
    assert(!Object.hasOwn(manifest.scripts, 'test:typelatch-benchmark'))
    manifest.scripts['test:typelatch-benchmark'] = `TZ=UTC TSX_DISABLE_CACHE=1 node --import ${quote(loader)} ${quote(join(here, 'public-check.mjs'))}`
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    evidence.fixtureAdaptations = [
      'Full source corpus and identical filtered installed dependencies copied with preserved relative symlinks.',
      'Restore seven committed symlink targets to exact source inventory text; preserve the normalization ledger. No provider copy may link outside its corpus.',
      'Build only packages/constants and packages/error with repository TypeScript5.5.4 project references. No lint, lifecycle hooks or full monorepo build.',
      'Add one root validation script invoking external pinned tsx4.23.13 and the public native check. Actual changed-package source executes directly.',
      'Tests create real temporary Git repositories outside the corpus and retain them as qualification evidence.',
      'Private evaluator and reference remain outside the agent workspace; isolation is procedural, not an OS access-control claim.',
    ]
    assert(sourceStable(baseline, ['package.json']).passed)
    const initial = snapshot(baseline)
    evidence.externalSymlinks = initial.entries.filter(entry => entry.kind === 'symlink' && !resolve(dirname(join(baseline, entry.path)), entry.target).startsWith(baseline + sep)).map(entry => ({ path: entry.path, target: entry.target }))
    assert.equal(evidence.externalSymlinks.length, 0, 'Installed or committed links must not escape the maintenance corpus')
    writeFileSync(join(output, 'baseline-manifest.json'), JSON.stringify(initial, null, 2) + '\n', { mode: 0o600 })
    evidence.baselineTreeSha256 = initial.sha256
    const original = readFileSync(join(baseline, sourceFile), 'utf8')
    const needle = "        '--name-only',\n"
    assert.equal(original.split(needle).length, 2)
    const referenceSource = original.replace(needle, needle + "        '--no-renames',\n")
    const overbroadSource = original.replace('return [changedPkgs, ignoreDependentForPkgs]', 'return [changedPkgs.length > 0 ? packageDirs : changedPkgs, ignoreDependentForPkgs]')
    assert.notEqual(original, overbroadSource)
    for (const [name, source] of [['reference', referenceSource], ['overbroad-control', overbroadSource]]) {
      const path = join(output, name)
      cpSync(baseline, path, { recursive: true, dereference: false, verbatimSymlinks: true })
      writeFileSync(join(path, sourceFile), source)
    }
    evidence.reference = { path: sourceFile, beforeSha256: sha256(original), afterSha256: sha256(referenceSource), sourceLinesAdded: ["        '--no-renames',"] }
    evidence.toolchain = { nodeVersion: process.version, nodeSha256: sha256(readFileSync(process.execPath)), typescript: JSON.parse(readFileSync(join(baseline, 'node_modules/typescript/package.json'))).version, tsx: '4.23.13', tsxTreeSha256: snapshot(dirname(require.resolve('tsx/package.json'))).sha256, git: run('git', ['--version'], baseline).stdout.trim() }
    evidence.harness = ['case-engine.mjs', 'public-check.mjs', 'qualify.mjs'].map(path => ({ path, sha256: sha256(readFileSync(join(here, path))) }))
    evidence.privateHarness = { path: 'final-check.mjs', sha256: sha256(readFileSync(join(privateRoot, 'final-check.mjs'))) }
    for (const name of ['baseline', 'reference', 'overbroad-control']) {
      const path = join(output, name)
      evidence.results[name] = { public: run(process.execPath, ['--import', loader, join(here, 'public-check.mjs')], path), private: gradeWorkspace(path, initial) }
      persist()
    }
    evidence.publicCommand = run('npm', ['run', 'test:typelatch-benchmark'], baseline)
    evidence.checks = {
      baselineFailsIntendedCase: evidence.results.baseline.public.result?.results.find(x => x.id === 'move-between-projects')?.passed === false && evidence.results.baseline.public.result?.results.filter(x => x.id !== 'move-between-projects').every(x => x.passed === true),
      baselineHasNoLoadError: evidence.results.baseline.private.checks?.result?.results.every(x => !x.error) === true,
      referencePasses: evidence.results.reference.public.result?.passed === true && evidence.results.reference.private.passed === true,
      overbroadFails: evidence.results['overbroad-control'].private.checks?.result?.failed > 0,
      publicCommandFailsAsExpected: evidence.publicCommand.exitCode === 1 && evidence.publicCommand.stdout.includes('move-between-projects'),
      sourceCorpusUnchanged: sourceStable(corpus, [], false).passed,
    }
    evidence.status = Object.values(evidence.checks).every(Boolean) ? 'qualified' : 'qualification-failed'
    evidence.completedAt = new Date().toISOString()
    persist()
    assert.equal(evidence.status, 'qualified', 'Qualification checks failed; retain attempt and inspect errors')
    return { status: evidence.status, output, baselineTreeSha256: initial.sha256, checks: evidence.checks, cases: Object.fromEntries(Object.entries(evidence.results).map(([k,v]) => [k, { publicFailed: v.public.result.failed, privateFailed: v.private.checks.result.failed, privateCases: v.private.checks.result.cases }])) }
  } catch (error) {
    evidence.status = 'qualification-failed'
    evidence.error = { name: error.name, message: error.message }
    persist()
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], '--prepare')
  assert(process.argv[3], 'Provide a fresh output directory')
  console.log(JSON.stringify(prepareQualification(resolve(process.argv[3]))))
}
