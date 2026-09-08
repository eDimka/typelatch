import Database from 'better-sqlite3'
import { Kysely, SqliteDialect } from 'kysely'

export interface Contact {
  id: number
  name: string
}

interface Tables {
  contact: Contact
}

export async function createDatabase() {
  const db = new Kysely<Tables>({
    dialect: new SqliteDialect({ database: new Database(':memory:') })
  })
  await db.schema.createTable('contact')
    .addColumn('id', 'integer', column => column.primaryKey())
    .addColumn('name', 'text', column => column.notNull().unique())
    .execute()
  return db
}

export async function importContacts(db: Kysely<Tables>, contacts: Contact[]) {
  // Let rejection escape the callback so Kysely rolls back the whole batch.
  await db.transaction().execute(async transaction => {
    for (const contact of contacts) {
      await transaction.insertInto('contact').values(contact).execute()
    }
  })
}
