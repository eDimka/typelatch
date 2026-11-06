import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertComparableFixtures, comparisonManifest } from './paired-agent-comparison.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const generated = ['node_modules/better-sqlite3/build/Makefile', 'node_modules/better-sqlite3/build/config.gypi']
function fixture(t, suffix = '') {
  const root = mkdtempSync(join(tmpdir(), 'typelatch-comparison-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const content = {
    [generated[0]]: `module_root_dir=${realpathSync(root)}/node_modules/better-sqlite3\n-I${root}/node_modules/better-sqlite3/build/config.gypi\nconstant=1${suffix}\n`,
    [generated[1]]: JSON.stringify({ local_prefix: realpathSync(root), target_arch: 'arm64' }),
    'src/main.ts': 'export const value = 1\n',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node': 'EXACT_NATIVE_BYTES',
  }
  const files = Object.entries(content).sort(([a], [b]) => a < b ? -1 : 1).map(([path, value]) => {
    const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, value)
    return { path, kind: 'file', sha256: hash(value) }
  })
  return { root, files }
}

test('only workspace locations in the two generated files may differ', t => {
  const first = fixture(t), second = fixture(t)
  const before = JSON.stringify(first.files)
  const a = comparisonManifest(first.files, first.root), b = comparisonManifest(second.files, second.root)
  assert.notEqual(a.rawManifestSha256, b.rawManifestSha256)
  assert.equal(a.rawManifestSha256, hash(before))
  assert.equal(a.comparisonSha256, b.comparisonSha256)
  assert.equal(a.normalizations.length, 2)
  assert.doesNotThrow(() => assertComparableFixtures(a, b))
  assert.equal(JSON.stringify(first.files), before)
})

test('generated compiler options and ordinary source or native bytes remain strict', t => {
  const first = fixture(t), second = fixture(t, 'CHANGED')
  assert.throws(() => assertComparableFixtures(comparisonManifest(first.files, first.root), comparisonManifest(second.files, second.root)), /mismatch/)
  for (const path of ['src/main.ts', 'node_modules/better-sqlite3/build/Release/better_sqlite3.node']) {
    const changed = first.files.map(row => row.path === path ? { ...row, sha256: hash('changed') } : row)
    assert.throws(() => assertComparableFixtures(comparisonManifest(first.files, first.root), comparisonManifest(changed, first.root)), /mismatch/)
  }
})

test('normalizable bytes must still match their captured original identity', t => {
  const source = fixture(t)
  writeFileSync(join(source.root, generated[0]), 'tampered')
  assert.throws(() => comparisonManifest(source.files, source.root), /captured/)
})

test('no normalization applies to a source path or similar generated filename', t => {
  const first = fixture(t), second = fixture(t)
  for (const source of [first, second]) {
    const path = 'node_modules/better-sqlite3/build/Makefile.extra'
    writeFileSync(join(source.root, path), source.root)
    source.files.push({ path, kind: 'file', sha256: hash(source.root) })
  }
  assert.throws(() => assertComparableFixtures(comparisonManifest(first.files, first.root), comparisonManifest(second.files, second.root)), /mismatch/)
})

test('root prefixes embedded in a different path are not rewritten', t => {
  const first = fixture(t), second = fixture(t)
  for (const source of [first, second]) {
    const path = generated[1], text = JSON.stringify({ local_prefix: source.root + '-other' })
    writeFileSync(join(source.root, path), text)
    source.files.find(row => row.path === path).sha256 = hash(text)
  }
  assert.throws(() => assertComparableFixtures(comparisonManifest(first.files, first.root), comparisonManifest(second.files, second.root)), /mismatch/)
})

test('missing, duplicate, symlink and escaping inventory entries are rejected', t => {
  const source = fixture(t)
  assert.throws(() => comparisonManifest([...source.files, source.files[0]], source.root), /duplicate/i)
  assert.throws(() => comparisonManifest([{ path: '../outside', kind: 'file', sha256: 'a'.repeat(64) }], source.root), /relative/)
  assert.throws(() => comparisonManifest(source.files.map(row => row.path === generated[0] ? { ...row, kind: 'symlink' } : row), source.root), /regular file/)
})

test('comparison metadata is self verifying and does not conceal a changed normalized inventory', t => {
  const source = fixture(t), a = comparisonManifest(source.files, source.root), b = structuredClone(a)
  b.files[0].sha256 = '0'.repeat(64)
  assert.throws(() => assertComparableFixtures(a, b), /digest|mismatch/)
})

test('files without native generated metadata remain byte exact and need no exception', t => {
  const source = fixture(t), rows = source.files.filter(row => !generated.includes(row.path))
  const value = comparisonManifest(rows, source.root)
  assert.equal(value.normalizations.length, 0)
  assert.deepEqual(value.files, rows)
  assert.equal(value.rawManifestSha256, value.comparisonSha256)
})
