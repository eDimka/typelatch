import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { validateRelease, publicationState, registryPackage } from './release-policy.mjs'

const [mode, tag, destination] = process.argv.slice(2)
assert(['check', 'build'].includes(mode), 'Usage: node scripts/release-build.mjs check|build vX.Y.Z [output]')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const release = validateRelease(tag, json('package.json'), json('package-lock.json'), readFileSync('CHANGELOG.md', 'utf8'))
if (mode === 'build') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Release artifacts are built in GitHub Actions')
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push')
  assert.equal(process.env.GITHUB_REF_TYPE, 'tag')
  assert.equal(process.env.GITHUB_REF_NAME, tag)
  assert.equal(process.env.GITHUB_REPOSITORY, 'eDimka/typelatch')
  assert(destination, 'Artifact destination is required')
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const commit = git('rev-parse', 'HEAD')
  assert.equal(commit, process.env.GITHUB_SHA)
  assert.equal(git('cat-file', '-t', `refs/tags/${tag}`), 'tag', 'Use an annotated release tag')
  git('merge-base', '--is-ancestor', commit, 'origin/main')
  git('diff', '--exit-code', 'HEAD', '--')
  const output = resolve(destination)
  mkdirSync(output, { recursive: true })
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output], { encoding: 'utf8' }))[0]
  assert.equal(packed.name, 'typelatch'); assert.equal(packed.version, release.version)
  const bytes = readFileSync(join(output, packed.filename))
  const manifest = { ...release, name: packed.name, commit, filename: packed.filename, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
  assert.equal(packed.integrity, manifest.integrity)
  publicationState(manifest, await registryPackage())
  writeFileSync(join(output, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(output, 'SHA256SUMS'), `${manifest.sha256}  ${manifest.filename}\n`)
  writeFileSync(join(output, 'release-notes.md'), manifest.notes)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${release.version}\nprerelease=${release.prerelease}\n`)
}
console.log(`Validated ${release.tag}; npm distribution tag: ${release.distTag}`)
