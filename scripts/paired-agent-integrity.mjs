import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hash, resolvedCodexBinary } from './paired-agent-runner.mjs'

const defaultExclusions = ['.git', '.typelatch']
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)

export function inventoryTree(directory, { excludeDirectories = defaultExclusions } = {}) {
  const requestedRoot = resolve(directory)
  assert(lstatSync(requestedRoot).isDirectory() && !lstatSync(requestedRoot).isSymbolicLink(), `Inventory root must be a real directory: ${requestedRoot}`)
  const root = realpathSync(requestedRoot)
  const excluded = [...new Set(excludeDirectories)].sort()
  assert(excluded.every(name => typeof name === 'string' && name.length > 0 && !name.includes('/') && !name.includes('\\')), 'Excluded directories must be simple names')
  function walk(path) {
    const entries = []
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), stat = lstatSync(full), key = relative(root, full).split(sep).join('/')
      if (stat.isDirectory() && excluded.includes(name)) continue
      const row = { path: key, kind: null, mode: stat.mode & 0o777 }
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full)
        entries.push({ ...row, kind: 'symlink', target, sha256: hash(target) })
      } else if (stat.isDirectory()) {
        const children = walk(full)
        entries.push({ ...row, kind: 'directory', sha256: hash(canonical(children)) }, ...children)
      } else if (stat.isFile()) {
        const bytes = readFileSync(full)
        entries.push({ ...row, kind: 'file', bytes: bytes.length, sha256: hash(bytes) })
      } else throw new Error(`Cannot freeze special filesystem entry: ${full}`)
    }
    return entries
  }
  const entries = walk(root)
  return { root, excludeDirectories: excluded, entries, sha256: hash(canonical(entries)) }
}

function fileIdentity(name, path) {
  const full = resolve(path)
  assert(lstatSync(full).isFile() && !lstatSync(full).isSymbolicLink(), `Frozen file must be a regular file: ${full}`)
  const bytes = readFileSync(full)
  return { name, path: realpathSync(full), bytes: bytes.length, mode: lstatSync(full).mode & 0o777, sha256: hash(bytes) }
}

export function frozenInputDigest(frozen) {
  const { digest, ...inputs } = frozen
  return hash(canonical(inputs))
}

function dependencyDirectories(root) {
  const result = []
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!entry.isDirectory() || defaultExclusions.includes(entry.name)) continue
      const full = join(directory, entry.name)
      if (entry.name === 'node_modules') result.push(full)
      else walk(full)
    }
  }
  walk(root)
  return result
}

const within = (root, path) => { const key = relative(root, path); return key === '' || (key !== '..' && !key.startsWith('..' + sep) && !isAbsolute(key)) }

function verifyLinkCoverage(manifests, files) {
  for (const manifest of manifests) for (const row of manifest.entries) {
    if (row.kind !== 'symlink') continue
    const path = join(manifest.root, row.path)
    assert(existsSync(path), `Frozen dependency link is dangling: ${path}`)
    const target = realpathSync(path)
    assert(manifests.some(candidate => within(candidate.root, target) && (target === candidate.root || candidate.entries.some(entry => join(candidate.root, entry.path) === target))) || files.some(file => file.path === target), `Frozen link target is outside recorded inputs: ${path}`)
  }
}

export function freezeInputs(repositoryRoot, runtime) {
  const root = resolve(repositoryRoot), packageRoot = resolve(runtime)
  assert.equal(basename(dirname(packageRoot)), 'node_modules', 'Runtime must be the installed Typelatch package under node_modules')
  const fixtureRoot = join(root, 'scripts/fixtures/paired-agent')
  const manifests = [
    { name: 'fixtureSourcesAndGraders', ...inventoryTree(fixtureRoot, { excludeDirectories: [...defaultExclusions, 'node_modules'] }) },
    { name: 'installedTypelatchAndDependencies', ...inventoryTree(dirname(packageRoot)) },
    ...dependencyDirectories(fixtureRoot).map(path => ({ name: 'trustedDependencies:' + relative(fixtureRoot, path).split(sep).join('/'), ...inventoryTree(path) })),
  ]
  assert(manifests.some(manifest => manifest.name.startsWith('trustedDependencies:')), 'Trusted grader dependencies must be installed before freezing')
  const files = [
    ...['paired-agent.mjs', 'paired-agent-runner.mjs', 'paired-agent-evidence.mjs', 'paired-agent-fixtures.mjs', 'paired-agent-integrity.mjs', 'demo-evidence.mjs'].map(name => fileIdentity('harness:' + name, join(root, 'scripts', name))),
    fileIdentity('codexBinary', resolvedCodexBinary().path),
    fileIdentity('nodeBinary', realpathSync(process.execPath)),
  ]
  verifyLinkCoverage(manifests, files)
  const frozen = { schemaVersion: 1, manifests, files }
  frozen.digest = frozenInputDigest(frozen)
  return frozen
}

export function verifyFrozenInputs(frozen) {
  assert.equal(frozen.schemaVersion, 1, 'Unknown frozen input schema')
  assert.equal(frozen.digest, frozenInputDigest(frozen), 'Frozen input digest mismatch')
  for (const manifest of frozen.manifests) {
    const actual = inventoryTree(manifest.root, { excludeDirectories: manifest.excludeDirectories })
    assert.equal(actual.sha256, manifest.sha256, `Frozen tree changed: ${manifest.name}`)
    assert.deepEqual(actual.entries, manifest.entries, `Frozen tree entries changed: ${manifest.name}`)
  }
  for (const file of frozen.files) assert.deepEqual(fileIdentity(file.name, file.path), file, `Frozen file changed: ${file.name}`)
  verifyLinkCoverage(frozen.manifests, frozen.files)
  return true
}
