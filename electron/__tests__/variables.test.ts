import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { runMigrations } from '../db/migrate'
import { toErrorPayload } from '../lib/errors'
import { insertLink } from '../sync/linking'
import { makeEnv, MIGRATIONS_DIR, NIL_UUID, scaffold, type TestEnv } from './helpers'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    return toErrorPayload(e).code
  }
}

describe('migration 0008', () => {
  it('applies on a database that already holds data, and adds no sync capture triggers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slinger-mig-'))
    try {
      for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql') && n < '0008')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
      const db = openDatabase(':memory:')
      runMigrations(db, dir)
      db.prepare("INSERT INTO workspaces (id, name, workspace_type, version, deleted, created_at, updated_at) VALUES ('w', 'W', 'personal', 1, 0, 1, 1)").run()
      db.prepare("INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES ('c', 'w', 'C', 1, 0, 1, 1)").run()
      cpSync(join(MIGRATIONS_DIR, '0008_variables.sql'), join(dir, '0008_variables.sql'))
      expect(runMigrations(db, dir)).toEqual(['0008_variables.sql'])
      expect(db.prepare('SELECT name FROM collections').all()).toEqual([{ name: 'C' }])
      expect(db.prepare('SELECT COUNT(*) AS n FROM collection_variables').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM global_variables').get()).toEqual({ n: 0 })
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('collection_variables', 'global_variables')").all() as Array<{ name: string }>).map((t) => t.name)
      expect(triggers.every((t) => t.startsWith('sync_readonly_'))).toBe(true)
      expect(triggers).toHaveLength(4)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('collection variables repository', () => {
  it('creates, lists in order, updates by id or key, and keeps keys unique among live rows', async () => {
    const { collection } = await scaffold(env)
    const repo = env.core.collectionVariables
    const a = repo.upsert({ collectionId: collection.id, key: 'baseUrl', value: 'https://a' })
    const b = repo.upsert({ collectionId: collection.id, key: 'token', value: 't', enabled: false, description: 'the token' })
    expect(repo.list(collection.id).map((v) => [v.key, v.value, v.enabled, v.description, v.sortOrder])).toEqual([
      ['baseUrl', 'https://a', true, null, 0],
      ['token', 't', false, 'the token', 1],
    ])
    // by key: value replaced, enabled/description kept when undefined
    const b2 = repo.upsert({ collectionId: collection.id, key: 'token', value: '' })
    expect([b2.id, b2.value, b2.enabled, b2.description, b2.version]).toEqual([b.id, '', false, 'the token', 2])
    // rename onto an existing key is refused
    expect(code(() => repo.upsert({ collectionId: collection.id, key: 'token', value: 'x', variableId: a.id }))).toBe('invalid_input')
    // never secret
    expect(code(() => repo.upsert({ collectionId: collection.id, key: 's', value: 'x', isSecret: true }))).toBe('invalid_input')
    // soft delete frees the key
    repo.delete(a.id)
    expect(repo.list(collection.id).map((v) => v.key)).toEqual(['token'])
    const again = repo.upsert({ collectionId: collection.id, key: 'baseUrl', value: 'https://b' })
    expect(again.id).not.toBe(a.id)
    expect(code(() => repo.delete(a.id))).toBe('not_found')
  })

  it('detects version conflicts when expectedVersion is given', async () => {
    const { collection } = await scaffold(env)
    const repo = env.core.collectionVariables
    const v = repo.upsert({ collectionId: collection.id, key: 'k', value: '1' })
    repo.upsert({ collectionId: collection.id, key: 'k', value: '2', expectedVersion: 1 })
    const err = (() => {
      try {
        repo.upsert({ collectionId: collection.id, key: 'k', value: '3', variableId: v.id, expectedVersion: 1 })
      } catch (e) {
        return toErrorPayload(e)
      }
    })()
    expect(err).toMatchObject({ code: 'version_conflict', details: { expectedVersion: 1, currentVersion: 2 } })
  })

  it('reorders without bumping versions and refuses partial lists', async () => {
    const { collection } = await scaffold(env)
    const repo = env.core.collectionVariables
    const [a, b, c] = ['a', 'b', 'c'].map((k) => repo.upsert({ collectionId: collection.id, key: k, value: k }))
    const out = repo.reorder(collection.id, [c!.id, a!.id, b!.id])
    expect(out.map((v) => [v.key, v.version])).toEqual([['c', 1], ['a', 1], ['b', 1]])
    expect(code(() => repo.reorder(collection.id, [a!.id, b!.id]))).toBe('invalid_input')
    expect(code(() => repo.reorder(collection.id, [a!.id, a!.id, b!.id]))).toBe('invalid_input')
  })

  it('bulk replace keeps ids of existing keys, deletes missing ones and follows the given order', async () => {
    const { collection } = await scaffold(env)
    const repo = env.core.collectionVariables
    const a = repo.upsert({ collectionId: collection.id, key: 'a', value: '1' })
    repo.upsert({ collectionId: collection.id, key: 'b', value: '2' })
    const out = repo.replace(collection.id, [{ key: 'c', value: '3', enabled: false }, { key: 'a', value: '1' }])
    expect(out.map((v) => [v.key, v.value, v.enabled])).toEqual([['c', '3', false], ['a', '1', true]])
    expect(out[1]!.id).toBe(a.id)
    expect(out[1]!.version).toBe(1) // unchanged content: only the position moved
    expect(code(() => repo.replace(collection.id, [{ key: 'x', value: '' }, { key: 'x', value: '' }]))).toBe('invalid_input')
  })

  it('cascades with the collection and the workspace', async () => {
    const { workspace, collection } = await scaffold(env)
    const repo = env.core.collectionVariables
    repo.upsert({ collectionId: collection.id, key: 'a', value: '1' })
    await env.api.deleteCollection(collection.id)
    expect(env.core.db.prepare('SELECT deleted FROM collection_variables').all()).toEqual([{ deleted: 1 }])
    expect(code(() => repo.list(collection.id))).toBe('not_found')
    const other = await env.api.createCollection(workspace.id, 'Other')
    repo.upsert({ collectionId: other.id, key: 'b', value: '2' })
    await env.api.deleteWorkspace(workspace.id)
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM collection_variables WHERE deleted = 0').get()).toEqual({ n: 0 })
  })
})

describe('globals repository', () => {
  it('stores secrets only in the keychain, masks them, keeps them on empty upserts and reveals them', async () => {
    const { workspace } = await scaffold(env)
    const repo = env.core.globals
    const s = repo.upsert({ workspaceId: workspace.id, key: 'apiKey', value: 'hunter2', isSecret: true })
    expect(s).toMatchObject({ value: null, isSecret: true, maskedValue: '••••••••' })
    const row = env.core.db.prepare('SELECT value, secret_ref FROM global_variables WHERE id = ?').get(s.id) as { value: string | null; secret_ref: string }
    expect(row).toEqual({ value: null, secret_ref: `slinger:global-var:${s.id}` })
    expect(env.secrets.get(row.secret_ref)).toBe('hunter2')
    // empty value keeps the secret
    repo.upsert({ workspaceId: workspace.id, key: 'apiKey', value: '', isSecret: true, variableId: s.id })
    expect(repo.reveal(s.id)).toBe('hunter2')
    // new secret needs a value
    expect(code(() => repo.upsert({ workspaceId: workspace.id, key: 'x', value: '', isSecret: true }))).toBe('invalid_input')
    // secret -> plain purges the keychain entry
    repo.upsert({ workspaceId: workspace.id, key: 'apiKey', value: 'plain', isSecret: false, variableId: s.id })
    expect(env.secrets.get(row.secret_ref)).toBeNull()
    expect(repo.reveal(s.id)).toBe('plain')
  })

  it('bulk replace keeps an unchanged secret by key and purges deleted secrets', async () => {
    const { workspace } = await scaffold(env)
    const repo = env.core.globals
    const s = repo.upsert({ workspaceId: workspace.id, key: 's', value: 'v1', isSecret: true })
    const t = repo.upsert({ workspaceId: workspace.id, key: 't', value: 'v2', isSecret: true })
    const out = repo.replace(workspace.id, [{ key: 'p', value: 'plain' }, { key: 's', value: '', isSecret: true }])
    expect(out.map((v) => [v.key, v.isSecret])).toEqual([['p', false], ['s', true]])
    expect(repo.reveal(s.id)).toBe('v1')
    expect(env.secrets.get(`slinger:global-var:${t.id}`)).toBeNull()
  })

  it('deletes keychain entries on delete and on workspace delete', async () => {
    const { workspace } = await scaffold(env)
    const repo = env.core.globals
    const a = repo.upsert({ workspaceId: workspace.id, key: 'a', value: '1', isSecret: true })
    const b = repo.upsert({ workspaceId: workspace.id, key: 'b', value: '2', isSecret: true })
    repo.delete(a.id)
    expect(env.secrets.get(`slinger:global-var:${a.id}`)).toBeNull()
    expect(env.secrets.get(`slinger:global-var:${b.id}`)).toBe('2')
    await env.api.deleteWorkspace(workspace.id)
    expect(env.secrets.get(`slinger:global-var:${b.id}`)).toBeNull()
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM global_variables WHERE deleted = 0').get()).toEqual({ n: 0 })
  })

  it('refuses unknown owners and ids', async () => {
    expect(code(() => env.core.globals.list(NIL_UUID))).toBe('not_found')
    expect(code(() => env.core.globals.reveal(NIL_UUID))).toBe('not_found')
    expect(code(() => env.core.collectionVariables.list('nope'))).toBe('invalid_input')
  })
})

describe('local-only and read-only', () => {
  it('variable writes never mark anything dirty for sync, and viewer workspaces refuse them', async () => {
    const { workspace, collection } = await scaffold(env)
    const link = (readOnly: boolean) => {
      env.core.db.prepare('DELETE FROM cloud_links').run()
      insertLink(env.core.db, {
        workspaceId: workspace.id, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: readOnly ? 'viewer' : 'editor',
        clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
      })
    }
    link(false)
    env.core.db.prepare('DELETE FROM sync_dirty').run()
    const cv = env.core.collectionVariables.upsert({ collectionId: collection.id, key: 'a', value: '1' })
    env.core.collectionVariables.setValueFromScript(collection.id, 'b', '2')
    env.core.collectionVariables.reorder(collection.id, env.core.collectionVariables.list(collection.id).map((v) => v.id).reverse())
    const g = env.core.globals.upsert({ workspaceId: workspace.id, key: 'g', value: '1', isSecret: true })
    env.core.globals.replace(workspace.id, [{ key: 'g', value: '', isSecret: true }, { key: 'h', value: 'x' }])
    env.core.collectionVariables.delete(cv.id)
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get()).toEqual({ n: 0 })

    link(true)
    expect(code(() => env.core.collectionVariables.upsert({ collectionId: collection.id, key: 'c', value: '3' }))).toBe('read_only')
    expect(code(() => env.core.collectionVariables.setValueFromScript(collection.id, 'b', '9'))).toBe('read_only')
    expect(code(() => env.core.globals.upsert({ workspaceId: workspace.id, key: 'g', value: 'new', isSecret: true, variableId: g.id }))).toBe('read_only')
    expect(code(() => env.core.globals.delete(g.id))).toBe('read_only')
    expect(env.core.globals.reveal(g.id)).toBe('1')
  })
})
