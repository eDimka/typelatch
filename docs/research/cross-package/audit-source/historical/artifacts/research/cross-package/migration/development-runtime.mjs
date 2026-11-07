import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const workspace = resolve(process.argv[2]), require = createRequire(join(workspace, 'package.json'))
const root = mkdtempSync(join(tmpdir(), 'typelatch-glob-check-')), results = []
const file = (p, value) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)) }
async function test(id, fn) { try { await fn(); results.push({ id, passed: true }) } catch (e) { results.push({ id, passed: false, error: { name: e.name, message: e.message } }) } }
try {
  await test('cache-metadata-is-file-not-directory', async () => {
    const { findMetadataFiles } = require('./cache/api/lib/cacheList.js'), dir = join(root, 'cache')
    file(join(dir, 'registry.npmjs.org/normal.json'), { versions: {} })
    file(join(dir, 'registry.npmjs.org/decoy.json/nested.json'), { versions: {} })
    assert.deepEqual(await findMetadataFiles({ cacheDir: dir }, ['normal']), ['registry.npmjs.org/normal.json'])
    assert.deepEqual(await findMetadataFiles({ cacheDir: dir }, ['decoy']), [])
  })
  await test('cache-view-excludes-directory-expansion', async () => {
    const { cacheView } = require('./cache/api/lib/cacheView.js'), dir = join(root, 'view')
    file(join(dir, 'registry.npmjs.org/normal.json'), { versions: {}, 'dist-tags': { latest: '1.0.0' } })
    file(join(dir, 'registry.npmjs.org/decoy.json/nested.json'), { versions: {}, 'dist-tags': { latest: '9.9.9' } })
    assert.deepEqual(JSON.parse(await cacheView({ cacheDir: dir, storeDir: join(root, 'store') }, 'normal')), { 'registry.npmjs.org': { cachedVersions: [], nonCachedVersions: [], distTags: { latest: '1.0.0' } } })
    assert.deepEqual(JSON.parse(await cacheView({ cacheDir: dir, storeDir: join(root, 'store') }, 'decoy')), {})
  })
  await test('workspace-patterns-root-ignore-and-manifest-formats', async () => {
    const { findPackages } = require('./fs/find-packages/lib/index.js'), dir = join(root, 'discovery')
    file(join(dir, 'package.json'), { name: 'root' })
    file(join(dir, 'packages/alpha/package.json'), { name: 'alpha' })
    file(join(dir, 'packages/beta/package.yaml'), 'name: beta\n')
    file(join(dir, 'packages/hidden/package.json'), { name: 'hidden' })
    file(join(dir, 'node_modules/noise/package.json'), { name: 'noise' })
    const found = await findPackages(dir, { patterns: ['packages/*', '!packages/hidden'], includeRoot: true })
    assert.deepEqual(found.map(p => p.manifest.name).sort(), ['alpha', 'beta', 'root'])
    const standard = await findPackages(dir)
    assert(!standard.some(p => p.manifest.name === 'noise'))
  })
  await test('bins-recursive-files-without-link-or-path-escape', async () => {
    const { getBinsFromPackageManifest } = require('./pkg-manager/package-bins/lib/index.js'), dir = join(root, 'bins')
    file(join(dir, 'bin/tool'), '#!/usr/bin/env node\n')
    file(join(dir, 'bin/nested/other'), '#!/usr/bin/env node\n')
    file(join(dir, 'outside/not-a-bin'), 'no')
    symlinkSync('../outside', join(dir, 'bin/linked'))
    const found = await getBinsFromPackageManifest({ name: 'sample', directories: { bin: 'bin' } }, dir)
    assert.deepEqual(found.map(p => p.name).sort(), ['other', 'tool'])
    assert.deepEqual(await getBinsFromPackageManifest({ name: 'sample', directories: { bin: '..' } }, dir), [])
    assert.deepEqual(await getBinsFromPackageManifest({ name: '@scope/sample', bin: 'bin/tool' }, dir), [{ name: 'sample', path: join(dir, 'bin/tool') }])
  })
  await test('pack-inherits-license-file-without-directory-contents', async () => {
    const { api } = require('./releasing/plugin-commands-publishing/lib/pack.js'), dir = join(root, 'publish'), project = join(dir, 'pkg')
    file(join(project, 'package.json'), { name: 'migration-example', version: '1.0.0', main: 'index.js' })
    file(join(project, 'index.js'), 'module.exports = 1\n')
    file(join(dir, 'LICENSE.md'), 'Sample license\n')
    file(join(dir, 'LICENSE/private.txt'), 'Not a license file\n')
    const packed = await api({ dir: project, workspaceDir: dir, ignoreScripts: true, rawConfig: {}, argv: { original: [] }, catalogs: {}, nodeLinker: 'isolated', packGzipLevel: 6 })
    const tarball = resolve(project, packed.tarballPath); assert(existsSync(tarball))
    const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' }); assert.equal(listing.status, 0, listing.stderr)
    const entries = listing.stdout.trim().split('\n')
    assert(entries.includes('package/LICENSE.md'))
    assert(!entries.some(entry => entry.startsWith('package/LICENSE/')))
    assert(entries.includes('package/index.js'))
  })
  await test('patch-comparison-ignores-unpublished-files', async () => {
    const project = join(root, 'patch-project'), edit = join(root, 'patch-edit'), original = join(root, 'patch-original')
    const manifest = { name: 'migration-patch-example', version: '1.0.0', files: ['index.js'] }
    for (const dir of [edit, original]) { file(join(dir, 'package.json'), manifest); file(join(dir, 'index.js'), 'module.exports = 1\n') }
    file(join(edit, 'not-published/secret.txt'), 'This must not enter the patch\n')
    const { writeEditDirState } = require('./patching/plugin-commands-patching/lib/stateFile.js')
    writeEditDirState({ editDir: edit, modulesDir: join(project, 'node_modules'), patchedPkg: 'migration-patch-example@1.0.0', applyToAll: true })
    // Replace only the external package-store fetch with a local exact source tree.
    // Production packlist, globbing, staging and git diff remain unmodified.
    const fetchModule = require('./patching/plugin-commands-patching/lib/writePackage.js'), old = fetchModule.writePackage
    fetchModule.writePackage = async (_dep, destination) => { mkdirSync(destination, { recursive: true }); cpSync(original, destination, { recursive: true }) }
    try {
      const { handler } = require('./patching/plugin-commands-patching/lib/patchCommit.js')
      const output = await handler({ dir: project, lockfileDir: project, storeDir: join(root, 'patch-store'), pnpmHomeDir: join(root, 'home'), registries: { default: 'https://registry.npmjs.org/' } }, [edit])
      assert.equal(output, `No changes were found to the following directory: ${edit}`)
      assert(!existsSync(edit + '_tmp'), 'Temporary publishable-file stage must be cleaned')
    } finally { fetchModule.writePackage = old }
  })
} finally { rmSync(root, { recursive: true, force: true }) }
console.log(JSON.stringify({ passed: results.every(r => r.passed), cases: results.length, results }))
process.exitCode = results.every(r => r.passed) ? 0 : 1
