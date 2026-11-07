import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
import { sources, targets } from './prepare-development.mjs'
import { sha, runCheck, sourceManifest } from './grading-common.mjs'
import { gradeWorkspace } from './development-grade.mjs'
const here = import.meta.dirname, output = join(here, 'development-001'), workspace = join(output, 'workspace')
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const reference = new Map(sources.map((path, i) => [path, readFileSync(join(output, 'reference-sources', `${i}.ts`), 'utf8')]))
function oldSource(path, source) {
  if (path.endsWith('/pack.ts')) return source.replace("import { glob } from 'tinyglobby'", "import fg from 'fast-glob'").replace("const LICENSE_GLOB = 'LICEN{S,C}E{,.*}' // cspell:disable-line", "const LICENSE_GLOB = 'LICEN{S,C}E{,.*}' // cspell:disable-line\nconst findLicenses = fg.bind(fg, [LICENSE_GLOB]) as (opts: { cwd: string }) => Promise<string[]>").replace('glob([LICENSE_GLOB], { cwd: opts.workspaceDir, expandDirectories: false })', 'findLicenses({ cwd: opts.workspaceDir })')
  if (path.endsWith('/patchCommit.ts')) return source.replace("import { glob } from 'tinyglobby'", "import glob from 'fast-glob'").replace('    expandDirectories: false,\n', '')
  return source.replace("import { glob } from 'tinyglobby'", "import fastGlob from 'fast-glob'").replaceAll('glob(', 'fastGlob(').replaceAll(', expandDirectories: false', '').replaceAll('    expandDirectories: false,\n', '').replaceAll('      expandDirectories: false,\n', '').replace('  delete globOpts.patterns\n', '')
}
const baseline = new Map([...reference].map(([path, source]) => [path, oldSource(path, source)]))
const set = rows => { for (const [path, source] of rows) writeFileSync(join(workspace, path), source) }
const qualificationFile = join(output, 'qualification.json')
assert(!existsSync(qualificationFile), 'Every qualification outcome is retained')
const record = { schemaVersion: 1, status: 'qualifying', startedAt: new Date().toISOString(), split: 'development', productionPackages: targets.length, reference: 'Current pinned source preserves subsequent fixes; reverse only six original PR9169 source substitutions to create an explicit already-upgraded migration fixture.', results: {} }
const persist = () => write(qualificationFile, record); persist()
try {
  const packageFile = join(workspace, 'package.json'), rootManifest = JSON.parse(readFileSync(packageFile))
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"
  rootManifest.scripts['test:typelatch-benchmark'] = `node ${quote(join(here, 'development-check.mjs'))}`; write(packageFile, rootManifest)
  set(baseline)
  const tracking = sourceManifest(workspace), initial = inventoryTree(workspace)
  write(join(output, 'source-tracking-manifest.json'), tracking); write(join(output, 'initial-manifest.json'), initial)
  record.results.baseline = await gradeWorkspace(workspace, initial); persist()
  assert.equal(record.results.baseline.passed, false); assert.equal(record.results.baseline.checks.result.results[0].passed, false)
  set(reference)
  record.results.reference = await gradeWorkspace(workspace, initial); persist(); assert.equal(record.results.reference.passed, true)
  // A plausible import-only migration compiles but keeps incompatible directory defaults.
  set(new Map([...reference].map(([path, source]) => [path, source.replaceAll(', expandDirectories: false', '').replaceAll('    expandDirectories: false,\n', '').replaceAll('      expandDirectories: false,\n', '')])))
  record.results['import-only-semantic-regression'] = await gradeWorkspace(workspace, initial); persist()
  assert.equal(record.results['import-only-semantic-regression'].checks.result.results[0].passed, true)
  assert.equal(record.results['import-only-semantic-regression'].passed, false)
  assert(record.results['import-only-semantic-regression'].checks.result.results.some(row => row.id === 'cache-metadata-is-file-not-directory' && row.passed === false))
  set(reference); writeFileSync(join(workspace, sources[5]), baseline.get(sources[5]))
  record.results['partial-four-of-five-packages'] = await gradeWorkspace(workspace, initial); persist(); assert.equal(record.results['partial-four-of-five-packages'].passed, false)
  set(reference)
  // Preserve a consumer outside the migration: package-bin traversal validation.
  const bins = reference.get(sources[4]).replace("    if (!isSubdir(pkgPath, binDir)) {\n      return []\n    }\n", '')
  assert.notEqual(bins, reference.get(sources[4])); writeFileSync(join(workspace, sources[4]), bins)
  record.results['unchanged-path-safety-regression'] = await gradeWorkspace(workspace, initial); persist(); assert.equal(record.results['unchanged-path-safety-regression'].passed, false)
  set(baseline)
  record.status = 'qualified'; record.completedAt = new Date().toISOString()
  record.boundary = ['Five production packages are natively compiled using original TS project references.', 'Runtime coverage executes all five packages. Only remote patch-package acquisition is replaced by an exact local source tree; production glob, packlist, stage and git diff execute.', 'Already-upgraded dependency tree is fixed for all arms. Dependency installation and resolution are excluded from the edit task and retained separately as preparation costs.', 'Development task only. This qualification does not support a held-out performance claim.']
  record.harness = ['prepare-development.mjs', 'qualify-development.mjs', 'development-runtime.mjs', 'development-check.mjs', 'development-grade.mjs', 'grading-common.mjs'].map(path => ({ path, sha256: sha(readFileSync(join(here, path))) }))
  persist()
  const descriptor = { id: 'pnpm-glob-migration', category: 'migration', split: 'development', mode: 'edit', description: 'The selected package dependencies have moved from fast-glob to tinyglobby. Complete the production migration across this workspace while preserving package discovery, metadata matching, executable discovery, patch contents and published archive behavior. Keep dependencies and configuration fixed. Run the supplied native validation before and after the change.', workspace, initialManifest: join(output, 'initial-manifest.json'), sourceTrackingManifest: join(output, 'source-tracking-manifest.json'), qualification: { status: record.status, path: qualificationFile, sha256: sha(readFileSync(qualificationFile)) }, graderModule: join(here, 'development-grade.mjs'), publicCases: 7, validationCommand: 'npm run test:typelatch-benchmark', scope: { productionPackages: 5 }, policy: record.boundary }
  write(join(output, 'descriptor.json'), descriptor)
  console.log(JSON.stringify({ status: record.status, descriptor: join(output, 'descriptor.json'), outcomes: Object.fromEntries(Object.entries(record.results).map(([key, value]) => [key, value.passed])) }))
} catch (error) { set(baseline); record.status = 'qualification-failed'; record.error = error.message; persist(); throw error }
