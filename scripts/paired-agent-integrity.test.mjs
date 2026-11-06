import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frozenInputDigest, inventoryTree, verifyFrozenInputs } from './paired-agent-integrity.mjs'
import { createTimedEventRecorder, invocation, resolvedCodexBinary, stopOwnedProcessGroup } from './paired-agent-runner.mjs'

function scratch() { return mkdtempSync(join(tmpdir(), 'typelatch-integrity-test-')) }

test('default inventory includes executable dependencies, builds, empty directories and link targets', t => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules'), { recursive: true }); writeFileSync(join(root, 'node_modules/package.js'), 'export default 1')
  mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist/main.js'), 'console.log(1)')
  mkdirSync(join(root, 'empty')); mkdirSync(join(root, '.git')); writeFileSync(join(root, '.git/config'), 'ignored')
  mkdirSync(join(root, '.typelatch')); writeFileSync(join(root, '.typelatch/cache'), 'ignored')
  symlinkSync('dist/main.js', join(root, 'link'))
  const manifest = inventoryTree(root)
  assert(manifest.entries.some(row => row.path === 'node_modules/package.js' && row.sha256.length === 64))
  assert(manifest.entries.some(row => row.path === 'dist/main.js'))
  assert(manifest.entries.some(row => row.path === 'empty' && row.kind === 'directory'))
  assert(manifest.entries.some(row => row.path === 'link' && row.kind === 'symlink' && row.target === 'dist/main.js'))
  assert(!manifest.entries.some(row => row.path.includes('.git') || row.path.includes('.typelatch')))
  assert.deepEqual(inventoryTree(root), manifest)
})

test('explicit source inventory excludes every nested node_modules directory', t => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'nested/node_modules'), { recursive: true }); writeFileSync(join(root, 'nested/node_modules/p.js'), '1')
  mkdirSync(join(root, 'dist')); writeFileSync(join(root, 'dist/main.js'), '1')
  const manifest = inventoryTree(root, { excludeDirectories: ['.git', '.typelatch', 'node_modules'] })
  assert(!manifest.entries.some(row => row.path.includes('node_modules')))
  assert(manifest.entries.some(row => row.path === 'dist/main.js'))
})

test('frozen verification rejects changed bytes, added files, removed directories and changed symlinks', t => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'source.js'), 'original'); mkdirSync(join(root, 'empty')); symlinkSync('source.js', join(root, 'link'))
  const manifest = { name: 'fixture', ...inventoryTree(root) }
  const frozen = { schemaVersion: 1, manifests: [manifest], files: [] }
  frozen.digest = frozenInputDigest(frozen)
  assert.doesNotThrow(() => verifyFrozenInputs(frozen))
  for (const mutation of [
    () => writeFileSync(join(root, 'source.js'), 'changed'),
    () => writeFileSync(join(root, 'new.js'), 'added'),
    () => rmSync(join(root, 'empty'), { recursive: true }),
    () => { rmSync(join(root, 'link')); symlinkSync('other.js', join(root, 'link')) },
  ]) {
    mutation(); assert.throws(() => verifyFrozenInputs(frozen), /changed|mismatch/i)
    writeFileSync(join(root, 'source.js'), 'original'); rmSync(join(root, 'new.js'), { force: true }); mkdirSync(join(root, 'empty'), { recursive: true }); rmSync(join(root, 'link'), { force: true }); symlinkSync('source.js', join(root, 'link'))
  }
})

test('frozen manifest tampering is detected before consulting current files', t => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'source.js'), 'original')
  const frozen = { schemaVersion: 1, manifests: [{ name: 'fixture', ...inventoryTree(root) }], files: [] }
  frozen.digest = frozenInputDigest(frozen)
  frozen.manifests[0].entries[0].sha256 = '0'.repeat(64)
  assert.throws(() => verifyFrozenInputs(frozen), /digest/i)
})

test('Codex invocation uses the same resolved binary captured in metadata', t => {
  if (spawnSync('/usr/bin/which', ['codex'], { stdio: 'ignore' }).status !== 0) {
    t.skip('Codex CLI is not installed; remaining integrity controls are offline')
    return
  }
  const identity = resolvedCodexBinary()
  assert(identity.path.startsWith('/'))
  assert.equal(identity.sha256.length, 64)
  assert(identity.bytes > 0)
  assert.equal(invocation({ workspace: '/tmp/fixture', prompt: 'test' }).command, identity.path)
})

test('owned process cleanup waits for a SIGTERM resistant process to stop after SIGKILL', async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} })
  const closed = once(child, 'close')
  await once(child.stdout, 'data')
  assert.equal(await stopOwnedProcessGroup(child.pid, { graceMs: 20, killMs: 2000, intervalMs: 10 }), true)
  await closed
  assert.throws(() => process.kill(-child.pid, 0), error => error.code === 'ESRCH')
})

test('timing recorder preserves fragmented UTF8 bytes and exports arrival metadata only', t => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'raw.jsonl'), fd = openSync(path, 'wx', 0o600)
  let now = 100
  const recorder = createTimedEventRecorder(fd, 100, () => now)
  const first = Buffer.from(JSON.stringify({ type: 'item.completed', item: { id: 'first', type: 'command_execution', command: 'echo café', private_reasoning: 'NEVER_EXPORT' } }) + '\n')
  const split = first.indexOf(Buffer.from('é')) + 1
  now = 110; recorder.write(first.subarray(0, split))
  assert.equal(recorder.timing.length, 0)
  now = 125; recorder.write(first.subarray(split))
  const last = Buffer.from(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 5 } }))
  now = 130; recorder.write(last)
  now = 135; recorder.finish(); closeSync(fd)
  assert(readFileSync(path).equals(Buffer.concat([first, last])))
  assert.equal(recorder.timing.length, 2)
  assert.deepEqual(recorder.timing.map(row => [row.line, row.elapsedMs, row.type]), [[1, 25, 'item.completed'], [2, 35, 'turn.completed']])
  assert.equal(recorder.timing[0].itemIdHash.length, 64)
  assert.equal(recorder.timing[0].itemType, 'command_execution')
  assert.doesNotMatch(JSON.stringify(recorder.timing), /NEVER_EXPORT|echo|café|input_tokens/)
})

test('timing recorder records malformed lines without copying their contents', t => {
  const root = scratch(); t.after(() => rmSync(root, { recursive: true, force: true }))
  const fd = openSync(join(root, 'raw.jsonl'), 'wx', 0o600)
  const recorder = createTimedEventRecorder(fd, 0, () => 1)
  recorder.write(Buffer.from('PRIVATE_INVALID\n\n')); recorder.finish(); closeSync(fd)
  assert.deepEqual(recorder.timing, [{ line: 1, elapsedMs: 1, type: 'invalid_json' }, { line: 2, elapsedMs: 1, type: 'blank' }])
})
