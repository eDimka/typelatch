import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tasks, prepareTask, gradeTask, snapshotTask, taskIntegrity } from './paired-agent-fixtures.mjs'

for (const task of tasks) test(`${task.id}: broken fixture fails and reference repair passes independent grading`, { timeout: 180_000 }, () => {
  const parent = mkdtempSync(join(tmpdir(), 'typelatch-paired-fixtures-test-'))
  const workspace = join(parent, 'workspace')
  try {
    const prepared = prepareTask(task.id, workspace)
    assert.equal(prepared.baseline.passed, false)
    assert.equal(prepared.baseline.publicTests.fail, 1)
    assert(prepared.baseline.hiddenTests.fail > 0)
    assert(prepared.files.some(file => file.path.startsWith('node_modules/')))
    assert(!prepared.files.some(file => file.path.includes('hidden') || file.path.includes('reference/')))
    cpSync(new URL(`./fixtures/paired-agent/grader/reference/${task.id}/`, import.meta.url), workspace, { recursive: true })
    const repaired = gradeTask(task.id, workspace, prepared.files)
    assert.equal(repaired.passed, true, JSON.stringify(repaired))
    assert.equal(repaired.hiddenTests.pass, task.id === 'sqlite-rollback' ? 8 : 16)
    assert.equal(repaired.integrity.passed, true)
    const protectedPath = join(workspace, 'package.json')
    writeFileSync(protectedPath, readFileSync(protectedPath, 'utf8') + '\n')
    const compromised = gradeTask(task.id, workspace, prepared.files)
    assert.equal(compromised.publicTests.exitCode, 0)
    assert.equal(compromised.hiddenTests.exitCode, 0)
    assert.equal(compromised.passed, false)
    assert.deepEqual(compromised.integrity.protectedChanges, ['package.json'])
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('integrity rejects changed dependencies, tests, source links and files outside the editable scope', () => {
  const row = (path, sha256 = 'a', kind = 'file') => ({ path, sha256, kind })
  const before = [row('src/main.ts'), row('node_modules/effect/package.json'), row('test/public.test.mjs')]
  const after = [row('src/main.ts', 'b', 'symlink'), row('node_modules/effect/package.json', 'b'), row('test/public.test.mjs', 'b'), row('answer.json')]
  const result = taskIntegrity('partner-boundary', before, after)
  assert.equal(result.passed, false)
  assert.deepEqual(result.protectedChanges, ['answer.json', 'node_modules/effect/package.json', 'src/main.ts', 'test/public.test.mjs'])
})

test('generated outputs stay separate from protected inventory', () => {
  const parent = mkdtempSync(join(tmpdir(), 'typelatch-paired-inventory-test-'))
  try {
    const prepared = prepareTask('sqlite-rollback', parent, { install: false, baseline: false })
    assert.deepEqual(prepared.files, snapshotTask(parent))
    assert(prepared.files.some(row => row.path === 'batch.test.ts'))
    assert.equal(prepared.dependencyIdentities.length, 0)
  } finally { rmSync(parent, { recursive: true, force: true }) }
})

test('integrity rejects adding and deleting implementation paths', () => {
  const before = [{ path: 'src/main.ts', kind: 'file', sha256: 'a' }]
  const after = [{ path: 'src/replacement.ts', kind: 'file', sha256: 'b' }]
  const result = taskIntegrity('preview-accuracy', before, after)
  assert.equal(result.passed, false)
  assert.deepEqual(result.protectedChanges, ['src/main.ts', 'src/replacement.ts'])
})
