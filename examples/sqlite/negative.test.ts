import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDatabase } from './batch.ts'

test('negative control: omitting the transaction must fail the atomicity assertion', async () => {
  const db = await createDatabase()
  try {
    await db.insertInto('contact').values({ id: 1, name: 'existing' }).execute()
    await assert.rejects(async () => {
      for (const row of [{ id: 2, name: 'must roll back' }, { id: 3, name: 'existing' }]) {
        await db.insertInto('contact').values(row).execute()
      }
    }, { code: 'SQLITE_CONSTRAINT_UNIQUE' })
    // This intentionally fails: without a transaction, id 2 remains committed.
    assert.deepEqual(await db.selectFrom('contact').selectAll().orderBy('id').execute(), [{ id: 1, name: 'existing' }])
  } finally {
    await db.destroy()
  }
})
