import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { create } from 'tar'
import { assertOriginalStudyInputs, assertResumeIdentity, assertResumePreparation, restoredSqliteInput, verifyCandidateArchive } from './paired-agent-candidate.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'typelatch-candidate-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const runtime = join(root, 'package'); mkdirSync(join(runtime, 'dist'), { recursive: true })
  writeFileSync(join(runtime, 'package.json'), JSON.stringify({ name: 'typelatch', version: '0.4.0' }))
  writeFileSync(join(runtime, 'dist/mcp.js'), 'export const version = "candidate"\n')
  const archive = join(root, 'candidate.tgz')
  create({ cwd: root, file: archive, gzip: true, sync: true }, ['package'])
  const data = readFileSync(archive)
  return { root, runtime, archive, name: 'typelatch', version: '0.4.0', sha256: createHash('sha256').update(data).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(data).digest('base64') }
}

test('candidate archive binds the exact installed package without copying it', t => {
  const input = fixture(t)
  mkdirSync(join(input.runtime, 'node_modules/dependency'), { recursive: true })
  writeFileSync(join(input.runtime, 'node_modules/dependency/index.js'), 'separately frozen dependency')
  assert.equal(verifyCandidateArchive(input).packageFileCount, 2)
  writeFileSync(join(input.runtime, 'dist/mcp.js'), 'different bytes with the same package version')
  assert.throws(() => verifyCandidateArchive(input), /archive.*installed|installed.*archive/i)
})

test('candidate archive rejects added files, mismatched hashes and package identity', t => {
  const input = fixture(t)
  assert.throws(() => verifyCandidateArchive({ ...input, integrity: 'sha512-wrong' }), /integrity/i)
  assert.throws(() => verifyCandidateArchive({ ...input, sha256: 'wrong' }), /archive/i)
  assert.throws(() => verifyCandidateArchive({ ...input, version: '0.3.0' }), /version/i)
  writeFileSync(join(input.runtime, 'extra.js'), 'not in archive')
  assert.throws(() => verifyCandidateArchive(input), /archive.*installed|installed.*archive/i)
})

test('candidate archive rejects entries outside its package root', t => {
  const input = fixture(t)
  writeFileSync(join(input.root, 'outside.js'), 'outside package')
  create({ cwd: input.root, file: input.archive, gzip: true, sync: true }, ['package', 'outside.js'])
  const data = readFileSync(input.archive)
  input.sha256 = createHash('sha256').update(data).digest('hex')
  input.integrity = 'sha512-' + createHash('sha512').update(data).digest('base64')
  assert.throws(() => verifyCandidateArchive(input), /package root/i)
})

test('candidate archive rejects links and duplicate entries', t => {
  const input = fixture(t)
  const repack = files => {
    create({ cwd: input.root, file: input.archive, gzip: true, sync: true }, files)
    const data = readFileSync(input.archive)
    input.sha256 = createHash('sha256').update(data).digest('hex')
    input.integrity = 'sha512-' + createHash('sha512').update(data).digest('base64')
  }
  repack(['package', 'package/package.json'])
  assert.throws(() => verifyCandidateArchive(input), /duplicate/i)
  symlinkSync('mcp.js', join(input.runtime, 'dist/link.js'))
  repack(['package'])
  assert.throws(() => verifyCandidateArchive(input), /regular files/i)
})

test('same prompts cannot hide changed fixture or reused harness inputs', () => {
  const original = { frozenInputs: { manifests: [{ name: 'fixtureSourcesAndGraders', sha256: 'fixture' }, { name: 'trustedDependencies:test', sha256: 'deps' }], files: [{ name: 'harness:paired-agent-runner.mjs', sha256: 'runner', bytes: 2 }] } }
  const frozen = { manifests: [...original.frozenInputs.manifests, { name: 'installedTypelatchAndDependencies', sha256: 'candidate' }], files: [...original.frozenInputs.files] }
  assertOriginalStudyInputs(frozen, original)
  assert.throws(() => assertOriginalStudyInputs({ ...frozen, manifests: [{ name: 'fixtureSourcesAndGraders', sha256: 'changed' }] }, original), /original/i)
  assert.throws(() => assertOriginalStudyInputs({ ...frozen, files: [{ ...frozen.files[0], sha256: 'changed' }] }, original), /original/i)
})

test('resume cannot mix frozen inputs or protocols', () => {
  const prior = { protocolSha256: 'protocol', frozenInputs: { digest: 'frozen' } }
  assertResumeIdentity(prior, 'protocol', 'frozen')
  assert.throws(() => assertResumeIdentity(prior, 'other-protocol', 'frozen'), /protocol/i)
  assert.throws(() => assertResumeIdentity(prior, 'protocol', 'other-candidate'), /frozen/i)
})

test('failed or interrupted preparation cannot be silently retried', () => {
  const prior = { runs: [{ id: 'one' }], preparationAttempts: [{ id: 'one', status: 'ready' }] }
  assertResumePreparation(prior)
  for (const status of ['preparing', 'failed']) assert.throws(() => assertResumePreparation({ ...prior, preparationAttempts: [{ id: 'one', status }] }), /preparation/i)
  assert.throws(() => assertResumePreparation({ ...prior, preparationAttempts: [...prior.preparationAttempts, { id: 'two', status: 'preparing' }] }), /preparation/i)
  assert.throws(() => assertResumePreparation({ ...prior, preparationAttempts: [{ id: 'different', status: 'ready' }] }), /preparation/i)
})


test('only the exact recorded SQLite restoration can differ from original trusted bytes', () => {
  const exception = restoredSqliteInput
  const original = { frozenInputs: { manifests: [{ name: exception.name, sha256: exception.originalSha256 }], files: [] } }
  const restored = { manifests: [{ name: exception.name, sha256: exception.restoredSha256, entries: exception.files.map(file => ({ path: file.path, kind: 'file', sha256: file.restoredSha256 })) }], files: [] }
  assert.deepEqual(assertOriginalStudyInputs(restored, original), [exception])
  for (const mutate of [value => { value.manifests[0].sha256 = 'different' }, value => { value.manifests[0].name = 'trustedDependencies:other' }, value => { value.manifests[0].entries[0].sha256 = 'different' }]) {
    const changed = structuredClone(restored); mutate(changed)
    assert.throws(() => assertOriginalStudyInputs(changed, original), /original|restoration/i)
  }
})
