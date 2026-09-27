import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { runMigrations } from '../db/migrate'
import { toErrorPayload } from '../lib/errors'
import { insertLink } from '../sync/linking'
import { makeEnv, MIGRATIONS_DIR, NIL_UUID, scaffold, type TestEnv } from './helpers'
import { exportCollection } from './exportFixtures'

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

describe('sync capture and read-only', () => {
  it('variable writes mark the variables dirty for sync, and viewer workspaces refuse them (except secret values)', async () => {
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
    const dirty = env.core.db.prepare('SELECT entity_type AS t, entity_id AS id FROM sync_dirty').all() as Array<{ t: string; id: string }>
    expect(dirty.filter((d) => d.t === 'collection_variable')).toHaveLength(2)
    expect(dirty.filter((d) => d.t === 'global_variable')).toHaveLength(2)

    link(true)
    expect(code(() => env.core.collectionVariables.upsert({ collectionId: collection.id, key: 'c', value: '3' }))).toBe('read_only')
    expect(code(() => env.core.collectionVariables.setValueFromScript(collection.id, 'b', '9'))).toBe('read_only')
    expect(code(() => env.core.globals.upsert({ workspaceId: workspace.id, key: 'renamed', value: 'new', isSecret: true, variableId: g.id }))).toBe('read_only')
    expect(code(() => env.core.globals.delete(g.id))).toBe('read_only')
    expect(env.core.globals.reveal(g.id)).toBe('1')
    // this device's value of a secret stays editable (keychain only, like environment variables)
    env.core.globals.upsert({ workspaceId: workspace.id, key: 'g', value: 'new', isSecret: true, variableId: g.id })
    expect(env.core.globals.reveal(g.id)).toBe('new')
  })
})

describe('IPC', () => {
  it('round-trips collection variables and globals through the validated API', async () => {
    const { workspace, collection } = await scaffold(env)
    const a = await env.api.upsertCollectionVariable({ collectionId: collection.id, key: 'a', value: '1' })
    const b = await env.api.upsertCollectionVariable({ collectionId: collection.id, key: 'b', value: '2', enabled: false, description: 'B' })
    expect((await env.api.reorderCollectionVariables(collection.id, [b.id, a.id])).map((v) => v.key)).toEqual(['b', 'a'])
    expect((await env.api.replaceCollectionVariables(collection.id, [{ key: 'a', value: 'x' }])).map((v) => [v.key, v.value])).toEqual([['a', 'x']])
    await env.api.deleteCollectionVariable(a.id)
    expect(await env.api.listCollectionVariables(collection.id)).toEqual([])

    const g = await env.api.upsertGlobalVariable({ workspaceId: workspace.id, key: 'token', value: 's3cret', isSecret: true })
    expect((await env.api.listGlobalVariables(workspace.id))[0]).toMatchObject({ key: 'token', value: null, maskedValue: '••••••••' })
    expect(await env.api.revealGlobalVariable(g.id)).toBe('s3cret')
    await env.api.replaceGlobalVariables(workspace.id, [{ key: 'token', value: '', isSecret: true }, { key: 'p', value: 'v' }])
    expect(await env.api.revealGlobalVariable(g.id)).toBe('s3cret')
    const [, p] = await env.api.listGlobalVariables(workspace.id)
    expect((await env.api.reorderGlobalVariables(workspace.id, [p!.id, g.id])).map((v) => v.key)).toEqual(['p', 'token'])
    await env.api.deleteGlobalVariable(g.id)
    expect(env.secrets.get(`slinger:global-var:${g.id}`)).toBeNull()
  })

  it('rejects malformed arguments before touching the database', async () => {
    const { workspace, collection } = await scaffold(env)
    const bad = [
      () => env.api.listCollectionVariables('nope'),
      () => env.api.upsertCollectionVariable({ collectionId: collection.id, key: '', value: '' }),
      () => env.api.upsertCollectionVariable({ collectionId: collection.id, key: 'k', value: 'v', isSecret: true }),
      () => env.api.upsertCollectionVariable({ collectionId: collection.id, key: 'k', value: 'v', extra: 1 } as never),
      () => env.api.upsertCollectionVariable({ collectionId: collection.id, key: 'k', value: 'x'.repeat(1_000_001) }),
      () => env.api.upsertGlobalVariable({ workspaceId: workspace.id, key: 'k', value: 'v' } as never),
      () => env.api.replaceCollectionVariables(collection.id, [{ key: 'k' }] as never),
      () => env.api.reorderGlobalVariables(workspace.id, ['x']),
      () => env.api.revealGlobalVariable('x'),
    ]
    for (const call of bad) await expect(call()).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('the generic secure store cannot reach the globals secret namespace', async () => {
    const { workspace } = await scaffold(env)
    const g = await env.api.upsertGlobalVariable({ workspaceId: workspace.id, key: 't', value: 'v', isSecret: true })
    const key = `slinger:global-var:${g.id}`
    await expect(env.api.secureStoreGet(key)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.secureStoreSet(key, 'x')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.secureStoreDelete('SLINGER:GLOBAL-VAR:x')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(env.secrets.get(key)).toBe('v')
  })
})

describe('import, export and versions', () => {
  const file = (variable: unknown, name = 'Vars') =>
    JSON.stringify({
      info: { _postman_id: 'aaaaaaaa-1111-4222-8333-944445555666', name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'One', request: { method: 'GET', url: '{{baseUrl}}/one' } }],
      variable,
    })
  const kv = async (collectionId: string) => (await env.api.listCollectionVariables(collectionId)).map((v) => [v.key, v.value, v.enabled, v.description])

  it('a Postman import stores the variable array (disabled kept, values as text, duplicates and empty keys skipped)', async () => {
    const { workspace } = await scaffold(env)
    const r = await env.api.importPostmanCollection(workspace.id, file([
      { key: 'baseUrl', value: 'https://a.test' },
      { key: 'off', value: 'x', disabled: true, description: { content: 'Off for now', type: 'text/plain' } },
      { key: 'n', value: 7, type: 'any' },
      { key: 'baseUrl', value: 'dup' },
      { key: ' ', value: 'no key' },
      'junk',
    ]))
    expect(r.variableCount).toBe(3)
    expect(await kv(r.collection.id)).toEqual([
      ['baseUrl', 'https://a.test', true, null],
      ['off', 'x', false, 'Off for now'],
      ['n', '7', true, null],
    ])
  })

  it('export -> import round trip keeps order, values, disabled flags and descriptions', async () => {
    const { workspace } = await scaffold(env)
    const first = await env.api.importPostmanCollection(workspace.id, file([{ key: 'b', value: '2' }, { key: 'a', value: '1', disabled: true, description: 'A' }]))
    const exported = await exportCollection(env, first.collection.id, { includeSnapshots: false })
    expect(exported.variable).toEqual([{ key: 'b', value: '2', type: 'string' }, { key: 'a', value: '1', type: 'string', disabled: true, description: 'A' }])
    const other = await env.api.createWorkspace('Other')
    const again = await env.api.importPostmanCollection(other.id, JSON.stringify(exported))
    expect(await kv(again.collection.id)).toEqual(await kv(first.collection.id))
  })

  it('an export without variables has no variable key', async () => {
    const { collection } = await scaffold(env)
    expect('variable' in (await exportCollection(env, collection.id))).toBe(false)
  })

  it('re-import (replace) replaces the variables; the safety version holds the previous ones', async () => {
    const { workspace } = await scaffold(env)
    const r = await env.api.importPostmanCollection(workspace.id, file([{ key: 'old', value: '1' }]))
    const res = await env.api.replaceCollectionFromPostman(r.collection.id, file([{ key: 'new', value: '2' }]), 'vars.json')
    expect(res.variableCount).toBe(1)
    expect(await kv(r.collection.id)).toEqual([['new', '2', true, null]])
    const safety = await env.api.getCollectionVersion(res.safetyVersion.id)
    expect(safety.snapshot.collectionVariables).toEqual([{ key: 'old', value: '1' }])
    await env.api.restoreCollectionVersion(res.safetyVersion.id, 'replace')
    expect(await kv(r.collection.id)).toEqual([['old', '1', true, null]])
  })

  it('versions snapshot the variables; restore replace and copy bring them back; older snapshots restore without any', async () => {
    const { collection } = await scaffold(env)
    const repo = env.core.collectionVariables
    // No variables: the snapshot keeps the pre-0008 shape.
    const bare = await env.api.createCollectionVersion({ collectionId: collection.id, version: '0.1.0' })
    const raw = env.core.db.prepare('SELECT snapshot_json FROM collection_versions WHERE id = ?').get(bare.id) as { snapshot_json: string }
    expect(Object.keys(JSON.parse(raw.snapshot_json)).sort()).toEqual(['collectionName', 'folders', 'requests'])

    repo.upsert({ collectionId: collection.id, key: 'a', value: '1', description: 'first' })
    repo.upsert({ collectionId: collection.id, key: 'b', value: '2', enabled: false })
    const v1 = await env.api.createCollectionVersion({ collectionId: collection.id, version: '1.0.0' })
    expect((await env.api.getCollectionVersion(v1.id)).snapshot.collectionVariables).toEqual([
      { key: 'a', value: '1', description: 'first' },
      { key: 'b', value: '2', enabled: false },
    ])
    repo.replace(collection.id, [{ key: 'c', value: '3' }])
    await env.api.restoreCollectionVersion(v1.id, 'replace')
    expect(await kv(collection.id)).toEqual([['a', '1', true, 'first'], ['b', '2', false, null]])
    const copy = await env.api.restoreCollectionVersion(v1.id, 'copy')
    expect(await kv(copy.id)).toEqual([['a', '1', true, 'first'], ['b', '2', false, null]])
    // A snapshot from before collection variables existed restores to no variables.
    await env.api.restoreCollectionVersion(bare.id, 'replace')
    expect(await kv(collection.id)).toEqual([])
  })

  it('the versioned export (info._slinger) carries snapshot variables to another workspace', async () => {
    const { collection } = await scaffold(env)
    env.core.collectionVariables.upsert({ collectionId: collection.id, key: 'k', value: 'v' })
    const version = await env.api.createCollectionVersion({ collectionId: collection.id, version: '1.0.0' })
    env.core.collectionVariables.replace(collection.id, [])
    const exported = await exportCollection(env, collection.id)
    expect(exported.variable).toBeUndefined()
    const other = await env.api.createWorkspace('Other')
    // (the scaffold collection has no requests; an import needs one)
    const exportedWithRequest = { ...exported, item: [{ name: 'One', request: { method: 'GET', url: 'https://x' } }] }
    const imported = await env.api.importPostmanCollection(other.id, JSON.stringify(exportedWithRequest))
    expect(imported.versionHistory?.restored).toBe(1)
    const [v] = await env.api.listCollectionVersions(imported.collection.id)
    expect((await env.api.getCollectionVersion(v!.id)).snapshot.collectionVariables).toEqual([{ key: 'k', value: 'v' }])
    await env.api.restoreCollectionVersion(v!.id, 'replace')
    expect(await kv(imported.collection.id)).toEqual([['k', 'v', true, null]])
    expect(v!.version).toBe(version.version)
  })

  it('an imported snapshot with duplicate variable keys is rejected as a whole (never half-restorable)', async () => {
    const { workspace } = await scaffold(env)
    const snapshot = { collectionName: 'X', collectionVariables: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }], folders: [], requests: [] }
    const text = JSON.stringify({
      info: { name: 'X', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        _slinger: { formatVersion: 1, versions: [{ version: '1.0.0', createdAt: '2026-01-01T00:00:00Z', folderCount: 0, requestCount: 0, snapshot }] } },
      item: [{ name: 'One', request: { method: 'GET', url: 'https://x' } }],
    })
    const r = await env.api.importPostmanCollection(workspace.id, text)
    expect(r.versionHistory?.restored).toBe(0)
    expect(r.versionHistory?.notes.join(' ')).toMatch(/duplicate collection variable/)
  })
})
