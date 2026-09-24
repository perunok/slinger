import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { loadMigrations, runMigrations } from '../db/migrate'
import { MIGRATIONS_DIR } from './helpers'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'slinger-mig-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('migration runner', () => {
  it('applies every numbered file once, in order, and records them', () => {
    const db = openDatabase(':memory:')
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
    expect(runMigrations(db, MIGRATIONS_DIR)).toEqual(files)
    const rows = db.prepare('SELECT id, name, checksum FROM _migrations ORDER BY id').all() as Array<{ id: number; name: string; checksum: string }>
    expect(rows.map((r) => r.name)).toEqual(files)
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true)
    db.close()
  })

  it('is idempotent: a second run applies nothing and changes nothing', () => {
    const db = openDatabase(':memory:')
    runMigrations(db, MIGRATIONS_DIR)
    const before = db.prepare('SELECT * FROM _migrations ORDER BY id').all()
    expect(runMigrations(db, MIGRATIONS_DIR)).toEqual([])
    expect(db.prepare('SELECT * FROM _migrations ORDER BY id').all()).toEqual(before)
    db.close()
  })

  it('applies only new migrations on upgrade', () => {
    const dir = tmp()
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);')
    const db = openDatabase(':memory:')
    expect(runMigrations(db, dir)).toEqual(['0001_a.sql'])
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);')
    expect(runMigrations(db, dir)).toEqual(['0002_b.sql'])
    expect(() => db.prepare('SELECT * FROM b').all()).not.toThrow()
    db.close()
  })

  it('rolls back a failing migration and does not record it', () => {
    const dir = tmp()
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok (id INTEGER);')
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE half (id INTEGER); THIS IS NOT SQL;')
    const db = openDatabase(':memory:')
    expect(() => runMigrations(db, dir)).toThrow()
    expect((db.prepare('SELECT name FROM _migrations').all() as unknown[]).length).toBe(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined()
    db.close()
  })

  it('refuses to start when an applied migration file was edited', () => {
    const dir = tmp()
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);')
    const db = openDatabase(':memory:')
    runMigrations(db, dir)
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER, extra TEXT);')
    expect(() => runMigrations(db, dir)).toThrow(/modified after it was applied/)
    db.close()
  })

  it('refuses a database that is newer than the app', () => {
    const dir = tmp()
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id INTEGER);')
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id INTEGER);')
    const db = openDatabase(':memory:')
    runMigrations(db, dir)
    rmSync(join(dir, '0002_b.sql'))
    expect(() => runMigrations(db, dir)).toThrow(/does not know about/)
    db.close()
  })

  it('rejects duplicate migration numbers and ignores non-migration files', () => {
    const dir = tmp()
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;')
    writeFileSync(join(dir, '0001_b.sql'), 'SELECT 1;')
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(() => loadMigrations(dir)).toThrow(/Duplicate migration number/)
  })

  it('creates the expected schema, including soft-delete columns and the immutability trigger', () => {
    const db = openDatabase(':memory:')
    runMigrations(db, MIGRATIONS_DIR)
    for (const table of ['workspaces', 'collections', 'folders', 'requests', 'environments', 'environment_variables', 'collection_versions']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      expect(cols, table).toContain('deleted')
    }
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='collection_versions_immutable'").get()).toBeTruthy()
    db.close()
  })
})
