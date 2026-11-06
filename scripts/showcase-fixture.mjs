import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export function verifyRecordedFixture(snapshot, manifest) {
  assert.ok(Array.isArray(snapshot.files), 'Historical fixture contains captured files')
  assert.ok(Array.isArray(manifest) && manifest.length > 0, 'Recording identifies captured files')
  assert.deepEqual(
    snapshot.files.map(({ path, sha256 }) => ({ path, sha256 })),
    manifest,
    'Historical fixture identities match the recording',
  )
  const sources = new Map()
  for (const file of snapshot.files) {
    assert.match(file.path, /^examples\/sqlite\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:ts|json)$/, 'Historical fixture path is a direct source file')
    assert.ok(!sources.has(file.path), `Historical fixture path is unique: ${file.path}`)
    assert.equal(typeof file.text, 'string', `Historical fixture contains text: ${file.path}`)
    assert.equal(
      createHash('sha256').update(file.text).digest('hex'),
      file.sha256,
      `Historical fixture matches recorded execution: ${file.path}`,
    )
    sources.set(file.path, file.text)
  }
  return sources
}
