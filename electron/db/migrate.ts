import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './database'

const FILE_RE = /^(\d{4,})_[A-Za-z0-9_-]+\.sql$/

export interface MigrationFile {
  id: number
  name: string
  sql: string
  checksum: string
}

/** Reads numbered `NNNN_name.sql` files from a directory, ordered by number. */
export function loadMigrations(dir: string): MigrationFile[] {
  const files: MigrationFile[] = []
  for (const name of readdirSync(dir)) {
    const match = FILE_RE.exec(name)
    if (!match) continue
    const sql = readFileSync(join(dir, name), 'utf8')
    files.push({
      id: Number(match[1]),
      name,
      sql,
      // Normalize line endings so git autocrlf on Windows does not change checksums.
      checksum: createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'),
    })
  }
  files.sort((a, b) => a.id - b.id)
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.id === files[i - 1]!.id) {
      throw new Error(`Duplicate migration number ${files[i]!.id}: ${files[i - 1]!.name}, ${files[i]!.name}`)
    }
  }
  return files
}

/**
 * Applies every not-yet-applied migration, each in its own transaction, and records it in
 * `_migrations`. Re-running is a no-op. An applied migration whose file content changed, or one
 * that is recorded but missing on disk (database newer than app), aborts startup.
 * Returns the names applied by this call.
 */
export function runMigrations(db: Db, dir: string): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`)

  const files = loadMigrations(dir)
  const applied = new Map(
    (db.prepare('SELECT id, name, checksum FROM _migrations').all() as Array<{
      id: number
      name: string
      checksum: string
    }>).map((r) => [r.id, r]),
  )

  const known = new Set(files.map((f) => f.id))
  for (const row of applied.values()) {
    if (!known.has(row.id)) {
      throw new Error(`Database has migration ${row.name} which this version of Slinger does not know about`)
    }
  }

  const newlyApplied: string[] = []
  for (const file of files) {
    const existing = applied.get(file.id)
    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new Error(`Migration ${file.name} was modified after it was applied; add a new migration instead`)
      }
      continue
    }
    db.transaction(() => {
      db.exec(file.sql)
      db.prepare('INSERT INTO _migrations (id, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        file.id,
        file.name,
        file.checksum,
        Math.floor(Date.now() / 1000),
      )
    })()
    newlyApplied.push(file.name)
  }
  return newlyApplied
}
