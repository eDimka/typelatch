import test from 'node:test'
import assert from 'node:assert/strict'
import { importManifest } from '../dist/index.js'
test('invalid partner data is rejected by the manifest boundary', () => {
  assert.deepEqual(importManifest({ partner: ' ', parcels: [] }), { ok: false, reason: 'invalid-manifest' })
})
