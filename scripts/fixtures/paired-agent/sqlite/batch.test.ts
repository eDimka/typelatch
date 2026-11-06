import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatabase, importContacts } from './batch.ts'

test('commits the whole valid batch and binds a quote as data', async () => {
  const db = await createDatabase()
  try {
    const contacts = [{ id: 1, name: "O'Reilly" }, { id: 2, name: "Robert'); DROP TABLE contact;--" }]
    const compiled = db.insertInto('contact').values(contacts[0]!).compile()
    assert.equal(compiled.sql, 'insert into "contact" ("id", "name") values (?, ?)')
    assert.deepEqual(compiled.parameters, [1, "O'Reilly"])
    await importContacts(db, contacts)
    assert.deepEqual(await db.selectFrom('contact').selectAll().orderBy('id').execute(), contacts)
    console.log(JSON.stringify({ assertion: 'parameter binding and exact round trip', sql: compiled.sql, parameters: compiled.parameters, rows: contacts }))
  } finally {
    await db.destroy()
  }
})

test('UNIQUE failure rolls back an earlier insert in the same batch', async () => {
  const db = await createDatabase()
  try {
    await importContacts(db, [{ id: 1, name: 'existing' }])
    await assert.rejects(importContacts(db, [{ id: 2, name: 'must roll back' }, { id: 3, name: 'existing' }]), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
    const rows = await db.selectFrom('contact').selectAll().execute()
    assert.deepEqual(rows, [{ id: 1, name: 'existing' }])
    console.log(JSON.stringify({ assertion: 'whole batch rollback', rejectedCode: 'SQLITE_CONSTRAINT_UNIQUE', rows }))
  } finally {
    await db.destroy()
  }
})
