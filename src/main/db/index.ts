import { join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import { MIGRATIONS } from './schema'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db

  const file = join(app.getPath('userData'), 'deep-pink.db')
  db = new Database(file)

  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  migrate(db)
  return db
}

function migrate(conn: Database.Database): void {
  const current = conn.pragma('user_version', { simple: true }) as number

  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version]
    conn.transaction(() => {
      conn.exec(sql)
      // pragma values cannot be bound, and `version + 1` is a loop counter.
      conn.pragma(`user_version = ${version + 1}`)
    })()
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}

/** Absolute path of the database file — shown in Settings › Data. */
export function dbPath(): string {
  return join(app.getPath('userData'), 'deep-pink.db')
}
