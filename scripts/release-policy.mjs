import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// A deliberate SemVer subset: numbered alpha, beta and rc previews; no build metadata.
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/
export function releaseVersion(version) {
  const match = typeof version === 'string' && version.match(versionPattern)
  assert(match && match[0] === version && [match[1], match[2], match[3], match[5] ?? '0'].every(value => Number.isSafeInteger(Number(value))), `Invalid release version: ${version}`)
  return { version, tag: `v${version}`, prerelease: Boolean(match[4]), distTag: match[4] ? 'next' : 'latest' }
}
export function compareVersions(a, b) {
  releaseVersion(a); releaseVersion(b)
  const parts = value => { const m = value.match(versionPattern); return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? ['alpha', 'beta', 'rc'].indexOf(m[4]) : 3, Number(m[5] ?? 0)] }
  const left = parts(a), right = parts(b)
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return 0
}
export function validateRelease(tag, pkg, lock, changelog) {
  assert(typeof tag === 'string' && tag.startsWith('v'), 'Release tag must start with v')
  const release = releaseVersion(tag.slice(1))
  assert.equal(tag, release.tag, 'Tag must match the exact version')
  assert(pkg.name === 'typelatch' && lock.name === pkg.name && lock.packages?.['']?.name === pkg.name, 'Unexpected package identity')
  assert.equal(pkg.repository?.url, 'git+https://github.com/eDimka/typelatch.git', 'Unexpected repository identity')
  for (const version of [pkg.version, lock.version, lock.packages[''].version]) assert.equal(version, release.version, 'Tag and package versions must match')
  const sections = [...changelog.matchAll(/^## (.+)\r?$/gm)]
  const matches = sections.filter(section => section[1] === release.version)
  assert.equal(matches.length, 1, 'Changelog must have exactly one section for the version')
  const section = matches[0], next = sections[sections.indexOf(section) + 1]
  const notes = changelog.slice(section.index + section[0].length, next?.index).trim()
  assert(notes && !/\b(?:TODO|TBD)\b/.test(notes), 'Changelog release notes must be complete')
  return { ...release, notes: notes + '\n' }
}
export function publicationState(manifest, packument) {
  assert.equal(packument?.name, 'typelatch', 'Unexpected registry package identity')
  assert(packument.versions && packument['dist-tags'], 'Missing registry version inventory')
  const existing = packument.versions[manifest.version]
  if (existing) {
    assert(existing.name === manifest.name && existing.version === manifest.version, 'Existing registry identity differs')
    assert.equal(existing.dist?.integrity, manifest.integrity, 'Existing registry integrity differs; never overwrite a release')
    return 'existing'
  }
  const stable = Object.keys(packument.versions).filter(version => !releaseVersion(version).prerelease)
  const distribution = packument['dist-tags'][manifest.distTag]
  for (const version of [...stable, ...(distribution ? [distribution] : [])])
    assert(compareVersions(manifest.version, version) > 0, `A newer or equal version ${version} already exists`)
  return 'publish'
}
export function verifyArtifact(manifest, bytes, context) {
  const release = releaseVersion(manifest.version)
  assert.equal(manifest.name, 'typelatch', 'Unexpected artifact identity')
  assert.equal(manifest.filename, `typelatch-${release.version}.tgz`, 'Unexpected artifact filename')
  assert.equal(manifest.tag, release.tag)
  assert.equal(manifest.distTag, release.distTag)
  assert.equal(manifest.prerelease, release.prerelease)
  assert.equal(context.GITHUB_ACTIONS, 'true', 'Publication runs only in GitHub Actions')
  assert.equal(context.GITHUB_EVENT_NAME, 'push', 'Publication requires a pushed tag')
  assert.equal(context.GITHUB_REF_TYPE, 'tag')
  assert.equal(context.GITHUB_REF_NAME, release.tag)
  assert.equal(context.GITHUB_REPOSITORY, 'eDimka/typelatch')
  assert(/^[a-f0-9]{40}$/.test(manifest.commit), 'Invalid source commit')
  assert.equal(context.GITHUB_SHA, manifest.commit, 'Artifact does not match the triggering commit')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.sha256, 'Artifact hash differs')
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), manifest.integrity, 'Artifact integrity differs')
}
export async function registryPackage() {
  const response = await fetch('https://registry.npmjs.org/typelatch', { headers: { accept: 'application/json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(30_000), redirect: 'error' })
  assert(response.ok, `npm registry returned ${response.status}; cannot establish publication state`)
  return response.json()
}
