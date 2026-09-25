import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../db/database'
import { runMigrations } from '../../db/migrate'
import { toErrorPayload } from '../../lib/errors'
import { insertLink } from '../../sync/linking'
import { applyTx } from '../../sync/store'
import { DOC, MIGRATIONS_DIR, makeEnv, type TestEnv } from '../helpers'

let env: TestEnv
let ws: string
beforeEach(() => {
  env = makeEnv()
  ws = env.core.workspaces.list()[0]!.id
})
afterEach(() => env.cleanup())

function link(readOnly = false, workspaceId = ws) {
  insertLink(env.core.db, {
    workspaceId, apiBaseUrl: 'http://x', remoteWorkspaceId: `r-${workspaceId}`, remoteName: 'R', role: readOnly ? 'viewer' : 'editor',
    clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
  })
}
const dirty = () =>
  (env.core.db.prepare('SELECT entity_type AS t, entity_id AS id, change_seq AS seq FROM sync_dirty ORDER BY rowid').all() as Array<{ t: string; id: string; seq: number }>)
const dirtyOf = (type: string) => dirty().filter((d) => d.t === type).map((d) => d.id)
/** The IPC handler layer maps the trigger's SQLite error; do the same here. */
async function expectReadOnly(p: Promise<unknown>): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'expected the write to be rejected').not.toBeNull()
  expect(toErrorPayload(err).code).toBe('read_only')
}
const clear = () => env.core.db.prepare('DELETE FROM sync_dirty').run()

describe('change capture triggers', () => {
  it('marks nothing for unlinked workspaces', async () => {
    const c = await env.api.createCollection(ws, 'A')
    await env.api.renameCollection(c.id, 'B')
    expect(dirty()).toEqual([])
  })

  it('captures creates, renames, moves, reorders and deletes of every entity type', async () => {
    link()
    const c = await env.api.createCollection(ws, 'A')
    expect(dirtyOf('collection')).toEqual([c.id])
    clear()
    await env.api.renameCollection(c.id, 'B')
    expect(dirtyOf('collection')).toEqual([c.id])

    const f1 = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F1' })
    const f2 = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F2' })
    const r1 = await env.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f1.id, name: 'R1', method: 'GET', url: 'u', documentJson: DOC })
    const r2 = await env.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f1.id, name: 'R2', method: 'GET', url: 'u', documentJson: DOC })
    clear()

    // reorder inside a folder rewrites sibling sort_order: both siblings dirty
    await env.api.moveRequest({ requestId: r2.id, targetCollectionId: c.id, targetFolderId: f1.id, targetIndex: 0 })
    expect(dirtyOf('request').sort()).toEqual([r1.id, r2.id].sort())
    clear()
    // move between folders
    await env.api.moveRequest({ requestId: r1.id, targetCollectionId: c.id, targetFolderId: f2.id, targetIndex: 0 })
    expect(dirtyOf('request')).toContain(r1.id)
    clear()
    await env.api.moveFolder({ folderId: f2.id, targetParentFolderId: f1.id, targetIndex: 0 })
    expect(dirtyOf('folder')).toContain(f2.id)
    clear()
    await env.api.renameRequest(r1.id, 'R1b')
    expect(dirtyOf('request')).toEqual([r1.id])
    clear()
    const upd = await env.api.updateRequest({ requestId: r1.id, name: 'R1b', method: 'POST', url: 'v', documentJson: DOC, expectedVersion: (await env.api.listRequests(c.id)).find((r) => r.id === r1.id)!.version })
    expect(upd.method).toBe('POST')
    expect(dirtyOf('request')).toEqual([r1.id])
    clear()

    // cascade soft delete: every affected row is dirty
    await env.api.deleteFolder(f1.id)
    expect(dirtyOf('folder').sort()).toEqual([f1.id, f2.id].sort())
    expect(dirtyOf('request').sort()).toEqual([r1.id, r2.id].sort())
    clear()
    await env.api.deleteCollection(c.id)
    expect(dirtyOf('collection')).toEqual([c.id])
  })

  it('captures environments and variables (secret edits included) and resolves variable workspaces', async () => {
    link()
    const e = await env.api.createEnvironment(ws, 'Prod')
    const v = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'k', value: 'v', isSecret: false })
    const s = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 's', value: 'hunter2', isSecret: true })
    expect(dirtyOf('environment')).toEqual([e.id])
    expect(dirtyOf('environment_variable').sort()).toEqual([v.id, s.id].sort())
    const row = env.core.db.prepare("SELECT workspace_id FROM sync_dirty WHERE entity_type = 'environment_variable' LIMIT 1").get() as { workspace_id: string }
    expect(row.workspace_id).toBe(ws)
    clear()
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 's', value: 'hunter3', isSecret: true, variableId: s.id })
    expect(dirtyOf('environment_variable')).toEqual([s.id]) // no-op on the wire, eliminated at push time
    clear()
    await env.api.deleteEnvironment(e.id)
    expect(dirtyOf('environment')).toEqual([e.id])
    expect(dirtyOf('environment_variable').sort()).toEqual([v.id, s.id].sort())
  })

  it('captures postman import, version restore (replace and copy) and versions', async () => {
    link()
    const c = await env.api.createCollection(ws, 'Base')
    const f = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F' })
    const r = await env.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f.id, name: 'R', method: 'GET', url: 'u', documentJson: DOC })
    const ver = await env.api.createCollectionVersion({ collectionId: c.id, version: '1.0.0' })
    expect(dirtyOf('collection_version')).toEqual([ver.id])
    clear()

    await env.api.restoreCollectionVersion(ver.id, 'replace')
    expect(dirtyOf('folder')).toContain(f.id) // old row soft-deleted
    expect(dirtyOf('request')).toContain(r.id)
    expect(dirtyOf('folder')).toHaveLength(2) // + the re-created copy
    expect(dirtyOf('request')).toHaveLength(2)
    clear()

    const copy = await env.api.restoreCollectionVersion(ver.id, 'copy')
    expect(dirtyOf('collection')).toEqual([copy.id])
    expect(dirtyOf('folder')).toHaveLength(1)
    expect(dirtyOf('request')).toHaveLength(1)
    clear()

    const imported = await env.api.importPostmanCollection(ws, JSON.stringify({
      info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'Fold', item: [{ name: 'One', request: { method: 'GET', url: 'https://a' } }] }, { name: 'Two', request: { method: 'GET', url: 'https://b' } }],
    }))
    expect(dirtyOf('collection')).toEqual([imported.collection.id])
    expect(dirtyOf('folder')).toHaveLength(1)
    expect(dirtyOf('request')).toHaveLength(2)
  })

  it('does not fire while the engine applies remote changes', async () => {
    link()
    applyTx(env.core.db, () => {
      env.core.db.prepare("INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES ('c1', ?, 'X', 1, 0, 1, 1)").run(ws)
      env.core.db.prepare("UPDATE collections SET name = 'Y' WHERE id = 'c1'").run()
    })
    expect(dirty()).toEqual([])
    expect((env.core.db.prepare('SELECT applying FROM sync_control').get() as { applying: number }).applying).toBe(0)
  })

  it('bumps change_seq on repeated edits and resets the operation id', async () => {
    link()
    const c = await env.api.createCollection(ws, 'A')
    env.core.db.prepare("UPDATE sync_dirty SET op_id = 'op-1'").run()
    await env.api.renameCollection(c.id, 'B')
    const [d] = env.core.db.prepare('SELECT change_seq, op_id FROM sync_dirty').all() as Array<{ change_seq: number; op_id: string | null }>
    expect(d).toEqual({ change_seq: 2, op_id: null })
  })

  it('a workspace delete detaches sync first (no delete storm, no read-only block)', async () => {
    const w = await env.api.createWorkspace('Doomed')
    link(true, w.id)
    await expectReadOnly(env.api.createCollection(w.id, 'nope'))
    await env.api.deleteWorkspace(w.id)
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM cloud_links WHERE workspace_id = ?').get(w.id)).toEqual({ n: 0 })
    expect(dirty()).toEqual([])
  })
})

describe('read-only enforcement', () => {
  it('rejects every synced write of a viewer workspace with the read_only code, but not local-only writes', async () => {
    const c = await env.api.createCollection(ws, 'A')
    const f = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F' })
    const r = await env.api.createRequest({ workspaceId: ws, collectionId: c.id, name: 'R', method: 'GET', url: 'u', documentJson: DOC })
    const e = await env.api.createEnvironment(ws, 'E')
    const s = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 's', value: 'x', isSecret: true })
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'p', value: 'x', isSecret: false })
    link(true)
    await expectReadOnly(env.api.createCollection(ws, 'B'))
    await expectReadOnly(env.api.renameCollection(c.id, 'B'))
    await expectReadOnly(env.api.deleteCollection(c.id))
    await expectReadOnly(env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'G' }))
    await expectReadOnly(env.api.renameFolder(f.id, 'G'))
    await expectReadOnly(env.api.createRequest({ workspaceId: ws, collectionId: c.id, name: 'R2', method: 'GET', url: 'u', documentJson: DOC }))
    await expectReadOnly(env.api.updateRequest({ requestId: r.id, name: 'x', method: 'GET', url: 'u', documentJson: DOC, expectedVersion: 1 }))
    await expectReadOnly(env.api.deleteRequest(r.id))
    await expectReadOnly(env.api.createEnvironment(ws, 'E2'))
    await expectReadOnly(env.api.renameEnvironment(e.id, 'E3'))
    await expectReadOnly(env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'new', value: '1', isSecret: false }))
    await expectReadOnly(env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'p', value: 'changed', isSecret: false }))
    await expectReadOnly(env.api.createCollectionVersion({ collectionId: c.id, version: '1.0.0' }))
    await expectReadOnly(env.api.importPostmanCollection(ws, JSON.stringify({ info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'One', request: { method: 'GET', url: 'https://a' } }] })))
    // Device-local secret values stay editable in a read-only workspace (they never sync).
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 's', value: 'new-local-secret', isSecret: true, variableId: s.id })
    expect(await env.api.revealEnvironmentVariable(s.id)).toBe('new-local-secret')
    // Workspace-level operations and history stay allowed.
    await env.api.renameWorkspace(ws, 'Renamed')
    await env.api.clearHistory(ws)
  })

  it('maps the trigger marker to a read_only IPC error payload', () => {
    expect(toErrorPayload(new Error('slinger:read_only'))).toMatchObject({ code: 'read_only' })
  })

  it('never blocks engine writes (applying = 1)', () => {
    link(true)
    applyTx(env.core.db, () => {
      env.core.db.prepare("INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES ('c9', ?, 'X', 1, 0, 1, 1)").run(ws)
    })
    expect(env.core.db.prepare("SELECT 1 FROM collections WHERE id = 'c9'").get()).toBeTruthy()
  })
})

describe('schema drift guard', () => {
  it('every column of a synced table is classified as synced or ignored', () => {
    const synced: Record<string, string[]> = {
      collections: ['name', 'deleted'],
      folders: ['collection_id', 'parent_folder_id', 'name', 'sort_order', 'deleted'],
      requests: ['collection_id', 'folder_id', 'name', 'method', 'url', 'document_json', 'sort_order', 'deleted'],
      environments: ['name', 'deleted'],
      environment_variables: ['environment_id', 'key', 'value', 'is_secret', 'deleted'],
      collection_versions: ['deleted'],
    }
    const ignored: Record<string, string[]> = {
      // scripts_json (0005): collection/folder scripts are local-only in v1 (the cloud protocol has no field for them)
      collections: ['id', 'workspace_id', 'version', 'created_at', 'updated_at', 'scripts_json'],
      folders: ['id', 'workspace_id', 'version', 'created_at', 'updated_at', 'scripts_json'],
      requests: ['id', 'workspace_id', 'version', 'created_at', 'updated_at'],
      environments: ['id', 'workspace_id', 'version', 'created_at', 'updated_at'],
      environment_variables: ['id', 'secret_ref', 'secret_missing', 'version', 'created_at', 'updated_at'],
      // immutable content columns: covered by the immutability trigger + the INSERT trigger
      collection_versions: ['id', 'workspace_id', 'collection_id', 'version', 'version_major', 'version_minor', 'version_patch', 'version_prerelease', 'notes', 'snapshot_json', 'folder_count', 'request_count', 'created_at'],
    }
    for (const table of Object.keys(synced)) {
      const cols = (env.core.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
      const known = new Set([...synced[table]!, ...ignored[table]!])
      expect(cols.filter((c) => !known.has(c)), `${table} gained a column that is neither synced nor ignored`).toEqual([])
      const trig = (env.core.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(`sync_dirty_${table}_u`) as { sql: string }).sql
      for (const c of synced[table]!) expect(trig, `${table}.${c}`).toMatch(new RegExp(`\\b${c}\\b`))
    }
  })
})

describe('migration 0004', () => {
  it('applies on a database that already holds 0001-0003 data and keeps it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slinger-mig-'))
    try {
      for (const f of ['0001_init.sql', '0002_collection_versions.sql', '0003_integrity.sql']) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
      const db = openDatabase(':memory:')
      runMigrations(db, dir)
      db.prepare("INSERT INTO workspaces (id, name, workspace_type, version, deleted, created_at, updated_at) VALUES ('w', 'W', 'personal', 1, 0, 1, 1)").run()
      db.prepare("INSERT INTO collections (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES ('c', 'w', 'C', 1, 0, 1, 1)").run()
      db.prepare("INSERT INTO environments (id, workspace_id, name, version, deleted, created_at, updated_at) VALUES ('e', 'w', 'E', 1, 0, 1, 1)").run()
      db.prepare("INSERT INTO environment_variables (id, environment_id, key, value, is_secret, version, deleted, created_at, updated_at) VALUES ('v', 'e', 'k', 'x', 0, 1, 0, 1, 1)").run()
      cpSync(join(MIGRATIONS_DIR, '0004_sync.sql'), join(dir, '0004_sync.sql'))
      expect(runMigrations(db, dir)).toEqual(['0004_sync.sql'])
      expect(db.prepare('SELECT name FROM collections').all()).toEqual([{ name: 'C' }])
      expect(db.prepare('SELECT secret_missing FROM environment_variables').all()).toEqual([{ secret_missing: 0 }])
      expect(db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get()).toEqual({ n: 0 })
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
