import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { publicationState, registryPackage, releaseVersion, verifyArtifact } from './release-policy.mjs'

const [phase, directory] = process.argv.slice(2)
assert(['npm', 'github'].includes(phase) && directory, 'Usage: node scripts/release-publish.mjs npm|github <artifact-directory>')
const root = resolve(directory)
const manifest = JSON.parse(readFileSync(join(root, 'release.json'), 'utf8'))
const version = releaseVersion(manifest.version)
assert.equal(manifest.filename, `typelatch-${version.version}.tgz`)
const artifact = join(root, manifest.filename)
const bytes = readFileSync(artifact)
verifyArtifact(manifest, bytes, process.env)
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', timeout: 300_000 })
const remoteTag = run('git', ['ls-remote', 'https://github.com/eDimka/typelatch.git', `refs/tags/${manifest.tag}^{}`]).trim().split(/\s/)[0]
assert.equal(remoteTag, manifest.commit, 'Remote annotated tag no longer points to the tested commit')
const packed = JSON.parse(run('tar', ['-xOf', artifact, 'package/package.json']))
assert.equal(packed.name, manifest.name); assert.equal(packed.version, manifest.version)
assert.equal(readFileSync(join(root, 'SHA256SUMS'), 'utf8'), `${manifest.sha256}  ${manifest.filename}\n`)

if (phase === 'npm') {
  const state = publicationState(manifest, await registryPackage())
  if (state === 'publish') execFileSync('npm', ['publish', artifact, '--access', 'public', '--tag', manifest.distTag, '--provenance', '--ignore-scripts', '--registry', 'https://registry.npmjs.org'], { stdio: 'inherit', timeout: 300_000 })
  else console.log('The exact artifact already exists on npm; resuming verification.')
  let published
  for (let attempt = 0; attempt < 30; attempt++) {
    const inventory = await registryPackage()
    if (inventory.versions[manifest.version]) {
      assert.equal(publicationState(manifest, inventory), 'existing')
      published = inventory.versions[manifest.version]
      break
    }
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  assert(published, 'Published version is not visible in the registry after five minutes')
  assert.equal(published.dist.tarball, `https://registry.npmjs.org/typelatch/-/${manifest.filename}`)
  const response = await fetch(published.dist.tarball, { signal: AbortSignal.timeout(60_000), redirect: 'error' })
  assert(response.ok, `Registry tarball returned ${response.status}`)
  assert(bytes.equals(Buffer.from(await response.arrayBuffer())), 'Registry tarball differs from the tested artifact')
  console.log(`Verified npm bytes and integrity for ${manifest.name}@${manifest.version}`)
} else {
  assert.equal(publicationState(manifest, await registryPackage()), 'existing', 'Verify npm publication before creating a GitHub release')
  const gh = args => run('gh', args)
  const releases = () => JSON.parse(gh(['api', '--paginate', '--slurp', 'repos/eDimka/typelatch/releases'])).flat()
  let release = releases().find(item => item.tag_name === manifest.tag)
  const notes = join(root, 'release-notes.md')
  writeFileSync(notes, manifest.notes)
  if (!release) {
    gh(['release', 'create', manifest.tag, '--verify-tag', '--draft', '--target', manifest.commit, '--title', `Typelatch ${manifest.version}`, '--notes-file', notes, ...(manifest.prerelease ? ['--prerelease'] : [])])
    release = releases().find(item => item.tag_name === manifest.tag)
  }
  assert(release && release.target_commitish === manifest.commit, 'GitHub release targets a different source commit')
  const files = [manifest.filename, 'SHA256SUMS', 'release.json']
  assert(release.assets.every(asset => files.includes(asset.name)), 'Existing release has unexpected assets')
  const verifyAsset = file => {
    const asset = release.assets.find(asset => asset.name === file)
    if (!asset) return false
    const digest = 'sha256:' + createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
    assert.equal(asset.digest, digest, `Existing GitHub asset differs: ${file}`)
    return true
  }
  for (const file of files) {
    if (verifyAsset(file)) continue
    assert(release.draft, `Published release is missing ${file}; never replace released assets`)
    gh(['release', 'upload', manifest.tag, join(root, file)])
  }
  release = releases().find(item => item.tag_name === manifest.tag)
  for (const file of files) assert(verifyAsset(file))
  const latest = !manifest.prerelease && (await registryPackage())['dist-tags'].latest === manifest.version
  if (release.draft) gh(['release', 'edit', manifest.tag, '--draft=false', `--prerelease=${manifest.prerelease}`, `--latest=${latest}`])
  release = releases().find(item => item.tag_name === manifest.tag)
  assert(!release.draft && release.immutable === true, 'GitHub release must be published and immutable')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `latest=${latest}\n`)
  console.log(release.html_url)
}
