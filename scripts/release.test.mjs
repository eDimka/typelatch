import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { releaseVersion, compareVersions, validateRelease, publicationState, verifyArtifact } from './release-policy.mjs'

const metadata = version => ({ name: 'typelatch', version, repository: { url: 'git+https://github.com/eDimka/typelatch.git' } })
const lock = version => ({ name: 'typelatch', version, packages: { '': { name: 'typelatch', version } } })
const release = (tag = 'v0.3.0') => validateRelease(tag, metadata(tag.slice(1)), lock(tag.slice(1)), `# Changelog\n\n## ${tag.slice(1)}\n\nAdded setup.\n\n## 0.1.1\nOld release.\n`)

test('accepts exact stable and explicitly supported prerelease tags', () => {
  assert.deepEqual(releaseVersion('0.3.0'), { version: '0.3.0', tag: 'v0.3.0', prerelease: false, distTag: 'latest' })
  for (const channel of ['alpha', 'beta', 'rc']) assert.equal(release(`v1.2.0-${channel}.0`).distTag, 'next')
})
test('rejects noncanonical tags, ranges, leading zeroes and unsupported prereleases', () => {
  for (const version of ['v1.2.3','01.2.3','1.02.3','1.2','1.2.3.4','1.2.3+build','1.2.3-rc.01','1.2.3-rc','1.2.3-canary.1','1.2.3\n','^1.2.3','9007199254740992.0.0'])
    assert.throws(() => releaseVersion(version), /version/)
  for (const tag of ['1.2.3', 'vv1.2.3', 'v1.2.3\n']) assert.throws(() => release(tag))
})
test('orders prereleases and versions without string or numeric identifier mistakes', () => {
  const ordered = ['0.9.0','0.10.0-alpha.2','0.10.0-alpha.10','0.10.0-beta.0','0.10.0-rc.0','0.10.0','1.0.0']
  for (let i = 1; i < ordered.length; i++) assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1)
  assert.equal(compareVersions('1.0.0','1.0.0'), 0)
})
test('requires tag, both lockfile versions, package identity and changelog agreement', () => {
  assert.equal(release().notes, 'Added setup.\n')
  assert.throws(() => validateRelease('v0.3.0', metadata('0.2.0'), lock('0.3.0'), '## 0.3.0\nAdded.'), /match/)
  const wrong = lock('0.3.0'); wrong.packages[''].version = '0.2.0'
  assert.throws(() => validateRelease('v0.3.0', metadata('0.3.0'), wrong, '## 0.3.0\nAdded.'), /match/)
  assert.throws(() => validateRelease('v0.3.0', { ...metadata('0.3.0'), name: 'other' }, lock('0.3.0'), '## 0.3.0\nAdded.'), /identity/)
  for (const changelog of ['## Unreleased\nAdded.', '## 0.3.0\n\n## 0.2.0\nOld.', '## 0.3.0\nAdded.\n## 0.3.0\nAgain.'])
    assert.throws(() => validateRelease('v0.3.0', metadata('0.3.0'), lock('0.3.0'), changelog), /changelog/i)
})
test('retries only identical published artifacts and never downgrades a distribution tag', () => {
  const manifest = { ...release(), integrity: 'sha512-tested', name: 'typelatch' }
  const packument = { name: 'typelatch', 'dist-tags': { latest: '0.1.1' }, versions: { '0.1.1': {} } }
  assert.equal(publicationState(manifest, packument), 'publish')
  const existing = { ...packument, versions: { ...packument.versions, '0.3.0': { name: 'typelatch', version: '0.3.0', dist: { integrity: manifest.integrity } } } }
  assert.equal(publicationState(manifest, existing), 'existing')
  assert.throws(() => publicationState({ ...manifest, integrity: 'sha512-other' }, existing), /integrity/)
  assert.throws(() => publicationState(manifest, { ...packument, 'dist-tags': { latest: '0.4.0' }, versions: { '0.4.0': {} } }), /newer/)
  const preview = { ...release('v0.4.0-rc.1'), integrity: 'sha512-tested', name: 'typelatch' }
  assert.equal(publicationState(preview, existing), 'publish')
  assert.throws(() => publicationState(preview, { ...existing, 'dist-tags': { latest: '0.3.0', next: '0.4.0-rc.2' } }), /newer/)
  assert.throws(() => publicationState(preview, { ...existing, versions: { ...existing.versions, '0.4.0': {} } }), /newer/)
})
test('checks artifact bytes and workflow identity before privileged publication', () => {
  const bytes = Buffer.from('packed artifact')
  const manifest = { ...release(), name: 'typelatch', commit: 'a'.repeat(40), filename: 'typelatch-0.3.0.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
  const context = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.3.0', GITHUB_SHA: manifest.commit, GITHUB_REPOSITORY: 'eDimka/typelatch' }
  assert.doesNotThrow(() => verifyArtifact(manifest, bytes, context))
  for (const change of [{ GITHUB_ACTIONS: '' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF_NAME: 'v0.4.0' }, { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REPOSITORY: 'someone/fork' }])
    assert.throws(() => verifyArtifact(manifest, bytes, { ...context, ...change }))
  assert.throws(() => verifyArtifact(manifest, Buffer.from('tampered'), context), /hash|integrity/)
  assert.throws(() => verifyArtifact({ ...manifest, filename: '../other.tgz' }, bytes, context), /filename/)
})
