import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatabase, importContacts } from './batch.ts'

const rows = db => db.selectFrom('contact').selectAll().orderBy('id').execute()
const scenario = (name, run) => test(name, async () => {
  const db = await createDatabase()
  try { await run(db) } finally { await db.destroy() }
})
scenario('valid batches bind unusual names as data', async db => {
  const batch = [{ id: 7, name: "D'Angelo" }, { id: 9, name: "x'); delete from contact; --" }, { id: 11, name: '日本語' }]
  await importContacts(db, batch)
  assert.deepEqual(await rows(db), batch)
})
scenario('conflict with an existing name preserves all earlier rows', async db => {
  const before = [{ id: 1, name: 'old one' }, { id: 2, name: 'old two' }]
  await importContacts(db, before)
  await assert.rejects(importContacts(db, [{ id: 3, name: 'new one' }, { id: 4, name: 'old two' }, { id: 5, name: 'new two' }]), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
  assert.deepEqual(await rows(db), before)
})
scenario('duplicate names inside the same new batch roll back all inserts', async db => {
  await assert.rejects(importContacts(db, [{ id: 10, name: 'a' }, { id: 20, name: 'b' }, { id: 30, name: 'a' }]), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
  assert.deepEqual(await rows(db), [])
})
scenario('primary key conflicts also roll back and propagate their original error', async db => {
  const before = [{ id: 2, name: 'already here' }]
  await importContacts(db, before)
  await assert.rejects(importContacts(db, [{ id: 5, name: 'must disappear' }, { id: 2, name: 'clash' }]), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
  assert.deepEqual(await rows(db), before)
})
scenario('empty batches preserve existing rows', async db => {
  const before = [{ id: 31, name: 'unchanged' }]
  await importContacts(db, before)
  await importContacts(db, [])
  assert.deepEqual(await rows(db), before)
})
scenario('failure on the first row performs no partial deletion or insert', async db => {
  const before = [{ id: 12, name: 'stable' }]
  await importContacts(db, before)
  await assert.rejects(importContacts(db, [{ id: 15, name: 'stable' }, { id: 16, name: 'never inserted' }]))
  assert.deepEqual(await rows(db), before)
})
scenario('frozen input remains unchanged', async db => {
  const batch = Object.freeze([Object.freeze({ id: 100, name: 'frozen' })])
  await importContacts(db, batch)
  assert.deepEqual(await rows(db), batch)
})
scenario('the database accepts another complete batch after rollback', async db => {
  await assert.rejects(importContacts(db, [{ id: 8, name: 'repeat' }, { id: 9, name: 'repeat' }]))
  const after = [{ id: 8, name: 'recovered' }, { id: 9, name: 'complete' }]
  await importContacts(db, after)
  assert.deepEqual(await rows(db), after)
})
