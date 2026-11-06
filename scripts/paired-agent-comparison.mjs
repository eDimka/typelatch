import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
const placeholder = '$WORKSPACE'
export const normalizableGeneratedFiles = Object.freeze([
  'node_modules/better-sqlite3/build/Makefile',
  'node_modules/better-sqlite3/build/config.gypi',
])
const allowed = new Set(normalizableGeneratedFiles)
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)

function replaceWorkspace(text, aliases) {
  assert(!text.includes(placeholder), 'Generated metadata already contains the comparison placeholder')
  let replacements = 0
  const aliasCounts = []
  for (const alias of aliases) {
    let from = 0, next, output = '', count = 0
    while ((next = text.indexOf(alias, from)) !== -1) {
      const before = text[next - 1], after = text[next + alias.length]
      const leftBoundary = next === 0 || !/[\p{L}\p{N}_./]/u.test(before) || text.slice(next - 2, next) === '-I'
      const rightBoundary = after === undefined || /[\s/"':,)]/u.test(after)
      output += text.slice(from, next)
      if (leftBoundary && rightBoundary) { output += placeholder; count++ }
      else output += alias
      from = next + alias.length
    }
    output += text.slice(from)
    text = output
    replacements += count
    if (count) aliasCounts.push({ alias, replacements: count })
  }
  return { text, replacements, aliases: aliasCounts }
}

export function comparisonManifest(originalFiles, workspace) {
  assert(Array.isArray(originalFiles), 'Original file inventory is required')
  assert(typeof workspace === 'string' && isAbsolute(workspace), 'An absolute workspace is required')
  const aliases = [...new Set([resolve(workspace), realpathSync(workspace)])].sort((a, b) => b.length - a.length)
  const seen = new Set(), normalizations = []
  const files = originalFiles.map(original => {
    assert(original && typeof original.path === 'string' && !isAbsolute(original.path) && original.path.split('/').every(part => part && part !== '.' && part !== '..') && !original.path.includes('\\'), 'Inventory entries must use safe relative paths')
    assert(!seen.has(original.path), 'Duplicate file inventory entry')
    seen.add(original.path)
    assert(['file', 'directory', 'symlink'].includes(original.kind) && validHash(original.sha256), 'Inventory entry needs its captured kind and SHA256')
    const row = { ...original }
    if (!allowed.has(row.path)) return row
    const path = join(workspace, row.path)
    assert(row.kind === 'file' && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Normalizable metadata must remain a regular file')
    const bytes = readFileSync(path)
    assert.equal(digest(bytes), row.sha256, `Generated metadata differs from its captured bytes: ${row.path}`)
    if (Object.hasOwn(row, 'bytes')) assert.equal(bytes.length, row.bytes, `Generated metadata length differs from captured bytes: ${row.path}`)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const normalized = replaceWorkspace(text, aliases)
    if (!normalized.replacements) return row
    row.sha256 = digest(normalized.text)
    if (Object.hasOwn(row, 'bytes')) row.bytes = Buffer.byteLength(normalized.text)
    normalizations.push({ path: row.path, rawSha256: original.sha256, comparisonSha256: row.sha256, rawBytes: bytes.length, comparisonBytes: Buffer.byteLength(normalized.text), replacements: normalized.replacements, aliases: normalized.aliases })
    return row
  })
  return {
    schemaVersion: 1,
    rawManifestSha256: digest(JSON.stringify(originalFiles)),
    comparisonSha256: digest(JSON.stringify(files)),
    files, normalizations,
    rule: 'Only exact workspace paths and their realpath alias are replaced in better-sqlite3 build/Makefile and build/config.gypi. Other bytes and inventory entries remain strict. This comparison does not replace the original raw inventory identity.',
  }
}

export function assertComparableFixtures(left, right) {
  for (const manifest of [left, right]) {
    assert.equal(manifest?.schemaVersion, 1, 'Unknown fixture comparison schema')
    assert(validHash(manifest.rawManifestSha256), 'Original inventory identity is required')
    assert.equal(manifest.comparisonSha256, digest(JSON.stringify(manifest.files)), 'Fixture comparison digest mismatch')
  }
  assert.equal(left.comparisonSha256, right.comparisonSha256, 'Prepared fixture comparison mismatch')
  assert.deepEqual(left.files, right.files, 'Prepared fixture inventory mismatch')
  return true
}
