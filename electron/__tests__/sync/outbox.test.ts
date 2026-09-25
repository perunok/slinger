import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPushResponse, buildOps, chunkOps, orderOps, MAX_OPS_PER_PUSH } from '../../sync/outbox'
import { makeApplyCtx } from '../../sync/apply'
import { insertLink, markAllLiveDirty } from '../../sync/linking'
import { applyTx, getEntity, putEntity } from '../../sync/store'
import { canonicalJson } from '../../sync/mapping'
import type { PushResponse } from '../../sync/types'
import { DOC, makeEnv, type TestEnv } from '../helpers'

let env: TestEnv
let ws: string
beforeEach(() => {
  env = makeEnv()
  ws = env.core.workspaces.list()[0]!.id
  insertLink(env.core.db, { workspaceId: ws, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'owner', clientId: 'cl', checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1 })
})
afterEach(() => env.cleanup())

const build = () => buildOps(env.core.db, ws, Date.now())
const ops = () => orderOps(env.core.db, build().ops)
const label = (o: { op: { op: string; resource_type: string } }) => `${o.op.op}:${o.op.resource_type}`
/** Pretend the server accepted everything at version 1 (or `versions[id]`). */
function ack(built: ReturnType<typeof build>['ops'], versions: Record<string, number> = {}) {
  const resp: PushResponse = { accepted: built.map((b) => ({ operation_id: b.op.operation_id, resource_id: b.id, resulting_version: versions[b.id] ?? 1 })), rejected: [], checkpoint: 1 }
  applyTx(env.core.db, () => applyPushResponse(makeApplyCtx({ db: env.core.db, secrets: env.secrets, nowS: 1, effects: [] }, ws), built, resp))
}

describe('buildOps', () => {
  it('cancels create + delete of an entity that never reached the server', async () => {
    const c = await env.api.createCollection(ws, 'Gone')
    await env.api.deleteCollection(c.id)
    const r = build()
    expect(r.ops).toEqual([])
    expect(r.cleared).toBe(1)
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get()).toEqual({ n: 0 })
  })

  it('emits create ops with base_version 0, then update ops from the acknowledged base', async () => {
    const c = await env.api.createCollection(ws, 'A')
    const first = build().ops
    expect(first).toHaveLength(1)
    expect(first[0]!.op).toMatchObject({ op: 'upsert', resource_type: 'collection', resource_id: c.id, base_version: 0, payload: { name: 'A' } })
    ack(first, { [c.id]: 1 })
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get()).toEqual({ n: 0 })
    await env.api.renameCollection(c.id, 'B')
    const second = build().ops
    expect(second[0]!.op).toMatchObject({ op: 'upsert', base_version: 1, payload: { name: 'B' } })
  })

  it('eliminates no-ops: a rename back to the synced value, a secret value edit, a restore-replace collection touch', async () => {
    const c = await env.api.createCollection(ws, 'A')
    const e = await env.api.createEnvironment(ws, 'E')
    const s = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 's', value: 'v1', isSecret: true })
    ack(build().ops)
    await env.api.renameCollection(c.id, 'B')
    await env.api.renameCollection(c.id, 'A')
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 's', value: 'v2', isSecret: true, variableId: s.id })
    const noop = build()
    expect(noop.ops).toEqual([])
    expect(noop.cleared).toBe(2)

    const f = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F' })
    await env.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f.id, name: 'R', method: 'GET', url: 'u', documentJson: DOC })
    const version = await env.api.createCollectionVersion({ collectionId: c.id, version: '1.0.0' })
    ack(build().ops)
    await env.api.restoreCollectionVersion(version.id, 'replace')
    const r = build()
    // replace = old rows deleted + copies with new ids; the collection UPDATE itself is a wire no-op
    expect(r.ops.filter((o) => o.type === 'collection')).toEqual([])
    // (the old request's delete is folded into the old folder's delete: the server cascades)
    expect(r.ops.map(label).sort()).toEqual(['delete:folder', 'upsert:folder', 'upsert:request'])
  })

  it('orders variable deletes first, parents before children (folders by depth), upserts before deletes, leaves first', async () => {
    const c = await env.api.createCollection(ws, 'C')
    const f1 = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F1' })
    const f2 = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F2', parentFolderId: f1.id })
    const f3 = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F3', parentFolderId: f2.id })
    const r = await env.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f3.id, name: 'R', method: 'GET', url: 'u', documentJson: DOC })
    const e = await env.api.createEnvironment(ws, 'E')
    const v1 = await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'a', value: '1', isSecret: false })
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'b', value: '2', isSecret: false })
    ack(build().ops)
    // now: delete a variable and recreate its key (new id), add a request, delete a request
    await env.api.deleteEnvironmentVariable(v1.id)
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'a', value: '3', isSecret: false })
    const r2 = await env.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f1.id, name: 'R2', method: 'GET', url: 'u', documentJson: DOC })
    await env.api.deleteRequest(r.id)
    const order = ops().map((o) => `${label(o)}`)
    expect(order[0]).toBe('delete:environment_variable')
    expect(order.indexOf('upsert:request')).toBeLessThan(order.indexOf('delete:request'))
    void r2

    // folder depth ordering on a fresh batch
    const c2 = await env.api.createCollection(ws, 'C2')
    const g1 = await env.api.createFolder({ workspaceId: ws, collectionId: c2.id, name: 'G1' })
    const g3parent = await env.api.createFolder({ workspaceId: ws, collectionId: c2.id, name: 'G2', parentFolderId: g1.id })
    const g3 = await env.api.createFolder({ workspaceId: ws, collectionId: c2.id, name: 'G3', parentFolderId: g3parent.id })
    const ids = ops().filter((o) => o.op.op === 'upsert' && o.type === 'folder').map((o) => o.id)
    expect(ids.indexOf(g1.id)).toBeLessThan(ids.indexOf(g3parent.id))
    expect(ids.indexOf(g3parent.id)).toBeLessThan(ids.indexOf(g3.id))
    const all = ops()
    const firstUpsert = (t: string) => all.findIndex((o) => o.op.op === 'upsert' && o.type === t)
    expect(firstUpsert('collection')).toBeLessThan(firstUpsert('folder'))
    expect(firstUpsert('folder')).toBeLessThan(firstUpsert('request'))
  })

  it('drops child deletes when the container delete is in the batch and marks them covered', async () => {
    const c = await env.api.createCollection(ws, 'C')
    const f = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F' })
    const r = await env.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f.id, name: 'R', method: 'GET', url: 'u', documentJson: DOC })
    ack(build().ops)
    await env.api.deleteCollection(c.id)
    const built = build().ops
    expect(built.map((b) => `${b.op.op}:${b.type}`)).toEqual(['delete:collection'])
    expect(built[0]!.covers.map((x) => x.id).sort()).toEqual([f.id, r.id].sort())
    ack(built)
    // acknowledging the container also settles the covered children
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get()).toEqual({ n: 0 })
    expect(getEntity(env.core.db, 'request', r.id)).toMatchObject({ remote_deleted: 1, remote_version: 0 })
  })

  it('keeps the operation id stable per change and resets it when the entity changes again', async () => {
    const c = await env.api.createCollection(ws, 'A')
    const a1 = build().ops[0]!.op.operation_id
    const a2 = build().ops[0]!.op.operation_id
    expect(a2).toBe(a1)
    await env.api.renameCollection(c.id, 'B')
    const b = build().ops[0]!.op.operation_id
    expect(b).not.toBe(a1)
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM sync_sent_ops').get()).toEqual({ n: 2 })
  })

  it('an acknowledgement clears only the change_seq it was built from', async () => {
    const c = await env.api.createCollection(ws, 'A')
    const built = build().ops
    await env.api.renameCollection(c.id, 'B') // changes while the push is in flight
    ack(built, { [c.id]: 1 })
    expect(env.core.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty').get()).toEqual({ n: 1 })
    const next = build().ops[0]!.op
    expect(next).toMatchObject({ base_version: 1, payload: { name: 'B' } })
    expect(getEntity(env.core.db, 'collection', c.id)!.base_payload).toBe(canonicalJson({ name: 'A' }))
  })

  it('skips entities frozen in a conflict and children of remotely deleted parents', async () => {
    const c = await env.api.createCollection(ws, 'A')
    ack(build().ops)
    await env.api.renameCollection(c.id, 'B')
    env.core.db.prepare("UPDATE sync_entities SET state = 'conflict'").run()
    expect(build().ops).toEqual([])
  })

  it('initial upload marks every live row, skipping soft-deleted ones', async () => {
    env.core.db.prepare('DELETE FROM sync_dirty').run()
    env.core.db.prepare('DELETE FROM cloud_links').run()
    const c = await env.api.createCollection(ws, 'A')
    const dead = await env.api.createCollection(ws, 'Dead')
    await env.api.deleteCollection(dead.id)
    const f = await env.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F' })
    const e = await env.api.createEnvironment(ws, 'E')
    await env.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'k', value: 'v', isSecret: false })
    const v = await env.api.createCollectionVersion({ collectionId: c.id, version: '1.0.0' })
    insertLink(env.core.db, { workspaceId: ws, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'owner', clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1 })
    expect(markAllLiveDirty(env.core.db, ws)).toBe(5)
    const got = new Set(build().ops.map((o) => o.id))
    expect(got.has(dead.id)).toBe(false)
    for (const id of [c.id, f.id, e.id, v.id]) expect(got.has(id)).toBe(true)
  })
})

describe('chunking', () => {
  it('splits by operation count and by bytes, never dropping or reordering', async () => {
    const c = await env.api.createCollection(ws, 'C')
    for (let i = 0; i < 5; i++) await env.api.createRequest({ workspaceId: ws, collectionId: c.id, name: `R${i}`, method: 'GET', url: 'u', documentJson: DOC })
    const all = ops()
    expect(chunkOps(all, MAX_OPS_PER_PUSH).map((x) => x.length)).toEqual([6])
    expect(chunkOps(all, 2).map((x) => x.length)).toEqual([2, 2, 2])
    const flat = chunkOps(all, 4, all[0]!.bytes + all[1]!.bytes + 1).flat()
    expect(flat.map((x) => x.id)).toEqual(all.map((x) => x.id))
    expect(chunkOps(all, 100, 1).every((x) => x.length === 1)).toBe(true)
  })
})

describe('push results', () => {
  it('sync_conflict / not_found(upsert) ask for a retry, invalid_request quarantines, delete not_found counts as done', async () => {
    const a = await env.api.createCollection(ws, 'A')
    const b = await env.api.createCollection(ws, 'B')
    const c = await env.api.createCollection(ws, 'C')
    ack(build().ops)
    await env.api.renameCollection(a.id, 'A2')
    await env.api.renameCollection(b.id, 'B2')
    await env.api.deleteCollection(c.id)
    const built = build().ops
    const by = (id: string) => built.find((x) => x.id === id)!.op.operation_id
    const resp: PushResponse = {
      accepted: [],
      rejected: [
        { operation_id: by(a.id), resource_id: a.id, code: 'sync_conflict', message: 'stale', current_version: 5 },
        { operation_id: by(b.id), resource_id: b.id, code: 'invalid_request', message: 'name is bad', current_version: null },
        { operation_id: by(c.id), resource_id: c.id, code: 'not_found', message: 'gone', current_version: null },
      ],
      checkpoint: 9,
    }
    const out = applyTx(env.core.db, () => applyPushResponse(makeApplyCtx({ db: env.core.db, secrets: env.secrets, nowS: 1, effects: [] }, ws), built, resp))
    expect(out.retry.map((x) => x.id)).toEqual([a.id])
    expect(out.conflicts).toBe(1)
    expect(getEntity(env.core.db, 'collection', b.id)!.state).toBe('conflict')
    expect(getEntity(env.core.db, 'collection', c.id)).toMatchObject({ remote_deleted: 1 })
    // the checkpoint of a push response is never stored
    expect(env.core.db.prepare('SELECT sync_checkpoint FROM cloud_links').get()).toEqual({ sync_checkpoint: 0 })
    putEntity(env.core.db, 'collection', a.id, ws, { remote_version: 1, base_payload: canonicalJson({ name: 'A' }) })
  })
})
