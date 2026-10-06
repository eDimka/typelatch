import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectInstallPins, verifyPublishedPins } from './site-releasecheck.mjs'

const pins = [{ path: 'site/index.html', version: '0.1.1' }]
const published = {
  name: 'typelatch',
  version: '0.1.1',
  dist: {
    tarball: 'https://registry.npmjs.org/typelatch/-/typelatch-0.1.1.tgz',
    integrity: 'sha512-test-fixture',
  },
}
const metadataResponse = (metadata) => new Response(JSON.stringify(metadata))

test('collects installation and launcher pins without treating source version prose as a release', () => {
  const result = collectInstallPins([
    { path: 'site/index.html', text: '<code>npm install --global typelatch@0.1.1</code>' },
    { path: 'README.md', text: 'Source version typelatch@0.2.0 is unreleased.\n```sh\nnpm install -g typelatch@0.1.1\n```' },
    { path: 'docs/USAGE.md', text: 'npx --yes --package=typelatch@0.1.1 typelatch-mcp\nnpx --package typelatch@0.1.1 typelatch --help' },
  ])
  assert.deepEqual(result, [
    { path: 'site/index.html', version: '0.1.1' },
    { path: 'README.md', version: '0.1.1' },
    { path: 'docs/USAGE.md', version: '0.1.1' },
    { path: 'docs/USAGE.md', version: '0.1.1' },
  ])
})

test('rejects missing pins and moving install references', () => {
  for (const text of ['npm install typelatch', 'npm install typelatch@latest', 'npx --package=typelatch@^0.1.1 typelatch-mcp'])
    assert.throws(() => collectInstallPins([{ path: 'README.md', text }]), /requires an exact typelatch version/)
  assert.throws(() => collectInstallPins([{ path: 'README.md', text: 'typelatch@0.1.1' }]), /no Typelatch installation pin/)
})

test('accepts a published pin after checking official metadata once per version', async () => {
  const requests = []
  const versions = await verifyPublishedPins([...pins, { path: 'README.md', version: '0.1.1' }], {
    fetchImpl: async (url) => {
      requests.push(url)
      return metadataResponse(published)
    },
  })
  assert.deepEqual(versions, ['0.1.1'])
  assert.deepEqual(requests, ['https://registry.npmjs.org/typelatch/0.1.1'])
})

test('blocks publication when an installation version is unpublished', async () => {
  await assert.rejects(
    verifyPublishedPins([{ path: 'site/index.html', version: '0.2.0' }], {
      fetchImpl: async () => new Response('"version not found: 0.2.0"', { status: 404 }),
    }),
    /typelatch@0\.2\.0 \(site\/index\.html\): npm registry returned HTTP 404/,
  )
})

test('blocks publication when npm is unavailable or metadata cannot be read', async () => {
  for (const status of [429, 500, 503])
    await assert.rejects(verifyPublishedPins(pins, { fetchImpl: async () => new Response('', { status }) }), /publication is not verified/)
  await assert.rejects(verifyPublishedPins(pins, { fetchImpl: async () => { throw new Error('network offline') } }), /npm registry request failed: network offline/)
  await assert.rejects(verifyPublishedPins(pins, { fetchImpl: async () => new Response('not JSON') }), /invalid JSON/)
})

test('rejects metadata for a different package or version and missing artifact metadata', async () => {
  for (const metadata of [{ ...published, name: 'other-package' }, { ...published, version: '0.2.0' }, null])
    await assert.rejects(verifyPublishedPins(pins, { fetchImpl: async () => metadataResponse(metadata) }), /package identity mismatch/)
  await assert.rejects(verifyPublishedPins(pins, { fetchImpl: async () => metadataResponse({ ...published, dist: {} }) }), /artifact metadata is incomplete/)
})


test('checks direct npx setup and sync pins and rejects moving references', () => {
  assert.deepEqual(collectInstallPins([{ path: 'site/index.html', text: 'npx typelatch@0.3.0 setup\nnpx --yes typelatch@0.3.0 sync' }]), [
    { path: 'site/index.html', version: '0.3.0' },
    { path: 'site/index.html', version: '0.3.0' },
  ])
  for (const command of ['npx typelatch@latest setup', 'npx typelatch setup'])
    assert.throws(() => collectInstallPins([{ path: 'README.md', text: 'npm install typelatch@0.1.1\n' + command }]), /requires an exact typelatch version/)
})
