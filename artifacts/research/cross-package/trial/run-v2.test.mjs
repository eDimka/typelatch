import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hash } from '../../../../scripts/paired-agent-runner.mjs'
import { inventoryTree } from '../../../../scripts/paired-agent-integrity.mjs'
import * as original from './run.mjs'
import { copyFixture, fixtureCopyConfiguration, inventoryDeclarations, taskPrompt, makePrompts, validationObservation, assertResume } from './run-v2.mjs'

const snapshot = path => inventoryTree(path, { excludeDirectories: ['.git', '.typelatch'] })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'typelatch-run-v2-')), source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'file.ts'), 'export const before = 1\n')
  chmodSync(join(source, 'file.ts'), 0o755)
  writeFileSync(join(source, 'binary'), Buffer.from([0, 255, 1, 2]))
  symlinkSync('file.ts', join(source, 'alias'))
  symlinkSync('missing', join(source, 'dangling'))
  mkdirSync(join(source, '.git')); writeFileSync(join(source, '.git', 'config'), 'old metadata')
  return { root, source, destination: join(root, 'destination'), receiptPath: join(root, 'copy.json') }
}

test('native clone invocation preserves admitted inventory and independent writes with a bound receipt', { skip: process.platform !== 'darwin' }, () => {
  const paths = fixture()
  try {
    const config = fixtureCopyConfiguration('/usr/bin/python3'), before = snapshot(paths.source)
    const receipt = copyFixture({ ...paths, config })
    assert.equal(snapshot(paths.destination).sha256, before.sha256)
    assert.equal(snapshot(paths.source).sha256, before.sha256)
    assert.notEqual(lstatSync(join(paths.source, 'file.ts')).ino, lstatSync(join(paths.destination, 'file.ts')).ino)
    assert.equal(readlinkSync(join(paths.destination, 'dangling')), 'missing')
    assert.equal(receipt.native.clonedFiles, 2); assert.equal(receipt.native.clonedSymlinks, 2)
    assert.equal(receipt.native.excludedGit.length, 1)
    assert.equal(receipt.python.path, realpathSync('/usr/bin/python3'))
    assert.equal(receipt.helperSha256, hash(readFileSync(config.helper)))
    assert.equal(receipt.exitCode, 0); assert.equal(receipt.error, null); assert.equal(receipt.signal, null)
    assert.deepEqual(JSON.parse(readFileSync(paths.receiptPath)), receipt)
    writeFileSync(join(paths.destination, 'file.ts'), 'changed clone\n')
    assert.equal(snapshot(paths.source).sha256, before.sha256)
  } finally { rmSync(paths.root, { recursive: true, force: true }) }
})

test('copy failures retain a failure receipt and cannot overwrite an existing destination', { skip: process.platform !== 'darwin' }, () => {
  const paths = fixture()
  try {
    mkdirSync(paths.destination); writeFileSync(join(paths.destination, 'keep'), 'retained')
    assert.throws(() => copyFixture({ ...paths, config: fixtureCopyConfiguration('/usr/bin/python3') }), /Native fixture clone failed/u)
    const receipt = JSON.parse(readFileSync(paths.receiptPath))
    assert.notEqual(receipt.exitCode, 0); assert.equal(receipt.native, null)
    assert.match(receipt.stderr, /destination must not exist/u)
    assert.equal(readFileSync(join(paths.destination, 'keep'), 'utf8'), 'retained')
  } finally { rmSync(paths.root, { recursive: true, force: true }) }
})

test('changed helper or Python executable identity cannot start a copy', { skip: process.platform !== 'darwin' }, () => {
  const paths = fixture()
  try {
    const originalConfig = fixtureCopyConfiguration('/usr/bin/python3')
    for (const change of [c => { c.helperSha256 = '0'.repeat(64) }, c => { c.python.sha256 = '0'.repeat(64) }]) {
      const config = structuredClone(originalConfig); change(config)
      assert.throws(() => copyFixture({ ...paths, config }), /identity changed/u)
    }
  } finally { rmSync(paths.root, { recursive: true, force: true }) }
})

test('copy helper and resolved Python are mandatory frozen inputs', { skip: process.platform !== 'darwin' }, () => {
  const paths = fixture()
  try {
    const artifact = join(paths.root, 'artifact.json'); writeFileSync(artifact, JSON.stringify({ tarball: 'artifact.tgz' }))
    const spec = { fixtureCopy: fixtureCopyConfiguration('/usr/bin/python3'), typelatchArtifact: { manifest: artifact }, competitorSelection: { evidencePath: '/selection' }, fixtures: {}, arms: {}, sharedFrozenInputs: [], supplementalOutputs: { extractor: '/extractor' }, toolUseQualification: { receipt: '/receipt', sourceSpec: '/source' } }
    const inputs = inventoryDeclarations(spec, '/spec')
    for (const path of [spec.fixtureCopy.helper, spec.fixtureCopy.python.path, join(import.meta.dirname, 'run-v2.mjs')]) assert(inputs.some(row => row.kind === 'file' && row.path === path), path)
  } finally { rmSync(paths.root, { recursive: true, force: true }) }
})

test('task prompts, workflow observation and retained-prefix rules are unchanged', () => {
  for (const [name, current] of Object.entries({ taskPrompt, makePrompts, validationObservation, assertResume })) assert.equal(current.toString(), original[name].toString(), name)
})
