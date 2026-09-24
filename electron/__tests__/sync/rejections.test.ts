/**
 * Protocol v2 push rejections: the fake server speaks exactly the real server's wire contract (wireContract.ts, also
 * run against the real server in sync-it), and the engine branches on `reason` for each of them, with the legacy
 * `code` as a fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeApplyCtx } from '../../sync/apply'
import { canonicalJson } from '../../sync/mapping'
import { applyPushResponse, buildOps, rejectionReason } from '../../sync/outbox'
import { applyTx, getEntity, getLink } from '../../sync/store'
import type { PushResponse } from '../../sync/types'
import { FakeCloud } from './fakeCloud'
import { DOC, liveState, makeDevice, pendingCount, settle, type Device } from './harness'
import { checkRejectionContract } from './wireContract'

let cloud: FakeCloud
let devices: Device[] = []
beforeEach(async () => {
  cloud = await new FakeCloud().start()
  devices = []
})
afterEach(async () => {
  devices.forEach((d) => d.cleanup())
  await cloud.stop()
})

/** `pull`/`push` sequence of the sync calls recorded since the last `clearRecorded()`. */
const syncCalls = () => cloud.requests.filter((r) => /sync\/(pull|push)$/.test(r.path)).map((r) => r.path.split('/').pop())
/** The first push rejection the server sent (as recorded on the wire). */
const firstRejection = () =>
  cloud.requests
    .filter((r) => /sync\/push$/.test(r.path) && r.response)
    .flatMap((r) => (JSON.parse(r.response!) as PushResponse).rejected)[0]

async function published(seed: (d: Device, ws: string) => Promise<void>) {
  const user = cloud.createUser(`u${cloud.users.size}@example.com`)
  const d = makeDevice(cloud, { userId: user.id })
  devices.push(d)
  await seed(d, d.workspace.id)
  await d.api.publishWorkspace(d.workspace.id)
  const st = await settle(d, d.workspace.id)
  return { user, d, ws: d.workspace.id, remoteId: st.remoteWorkspaceId! }
}

/** A published workspace with collection C, folder F and request R (in F). */
async function withRequest() {
  const ids: { col: string; folder: string; req: string } = { col: '', folder: '', req: '' }
  const p = await published(async (d, ws) => {
    const c = await d.api.createCollection(ws, 'C')
    const f = await d.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F' })
    const r = await d.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: f.id, name: 'R', method: 'GET', url: 'https://x/1', documentJson: DOC })
    Object.assign(ids, { col: c.id, folder: f.id, req: r.id })
  })
  const edit = async (fields: { name?: string; url?: string }) => {
    const cur = (await p.d.api.listRequests(ids.col)).find((r) => r.id === ids.req)!
    await p.d.api.updateRequest({ requestId: ids.req, name: fields.name ?? cur.name, method: cur.method, url: fields.url ?? cur.url, documentJson: DOC, expectedVersion: cur.version })
  }
  return { ...p, ...ids, edit }
}

const serverMatchesDevice = (d: Device, ws: string, remoteId: string) => {
  const server = cloud.live(remoteId).map((e) => `${e.type}:${e.id}:${canonicalJson(cloud.wireOf(e))}`).sort()
  const local = liveState(d, ws).map((e) => `${e.type}:${e.id}:${canonicalJson(e.wire)}`).sort()
  expect(local).toEqual(server)
}

describe('wire contract', () => {
  it('the fake server rejects exactly like the real one (same assertions run in sync-it against slinger-admin)', async () => {
    const owner = cloud.createUser('owner@contract.test')
    await checkRejectionContract({
      baseUrl: cloud.baseUrl,
      ownerToken: cloud.issueTokens(owner.id).accessToken,
      viewerToken: async (wsId) => {
        const v = cloud.createUser(`viewer${cloud.users.size}@contract.test`)
        cloud.setRole(wsId, v.id, 'viewer')
        return cloud.issueTokens(v.id).accessToken
      },
    })
  })
})

describe('version_mismatch', () => {
  it('merges current_payload and pushes again WITHOUT another pull (non-overlapping change)', async () => {
    const { d, ws, remoteId, req, edit } = await withRequest()
    await edit({ url: 'https://x/local' })
    cloud.beforePush = (w) => void cloud.restUpsert(w, 'request', req, { sort_order: 7 })
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(syncCalls()).toEqual(['pull', 'push', 'push'])
    expect(firstRejection()).toMatchObject({ reason: 'version_mismatch', current_version: 2, current_payload: { sort_order: 7 } })
    expect(s).toMatchObject({ state: 'idle', pendingChanges: 0, openConflicts: 0 })
    expect(cloud.entity(req)!.data).toMatchObject({ url: 'https://x/local', sort_order: 7 })
    expect(cloud.entity(req)!.version).toBe(3)
    serverMatchesDevice(d, ws, remoteId)
    // The log entry of the other writer is pulled later and recognised as already known.
    cloud.clearRecorded()
    const s2 = await d.core.sync.syncNow(ws)
    expect(syncCalls()).toEqual(['pull'])
    expect(s2.pendingChanges).toBe(0)
  })

  it('opens an edit_edit conflict from the rejection itself when both sides changed the same group', async () => {
    const { d, ws, req, edit } = await withRequest()
    await edit({ name: 'Mine' })
    cloud.beforePush = (w) => void cloud.restUpsert(w, 'request', req, { name: 'Theirs' })
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(syncCalls()).toEqual(['pull', 'push'])
    expect(s.openConflicts).toBe(1)
    const [c] = await d.api.listSyncConflicts(ws)
    expect(c).toMatchObject({ kind: 'edit_edit', entityId: req })
    expect(c!.groups.filter((g) => g.conflicting).map((g) => g.group)).toEqual(['content'])
    expect(cloud.entity(req)!.data.name).toBe('Theirs') // nothing overwritten remotely
    await d.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_local' })
    await settle(d, ws)
    expect(cloud.entity(req)!.data.name).toBe('Mine')
  })

  it('falls back to pull + retry when current_payload references a parent this device has not pulled yet', async () => {
    const { d, ws, remoteId, col, req, edit } = await withRequest()
    await edit({ url: 'https://x/local' })
    const newFolder = '0190aaaa-0000-7000-8000-000000000001'
    cloud.beforePush = (w) => {
      cloud.restUpsert(w, 'folder', newFolder, { collection_id: col, parent_folder_id: null, name: 'New', sort_order: 0 })
      cloud.restUpsert(w, 'request', req, { folder_id: newFolder })
    }
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(syncCalls()).toEqual(['pull', 'push', 'pull', 'push'])
    expect(s).toMatchObject({ pendingChanges: 0, openConflicts: 0 })
    expect(cloud.entity(req)!.data).toMatchObject({ url: 'https://x/local', folder_id: newFolder })
    serverMatchesDevice(d, ws, remoteId)
  })

  it('a delete that meets a remote edit becomes local_deleted from the rejection', async () => {
    const { d, ws, req } = await withRequest()
    await d.api.deleteRequest(req)
    cloud.beforePush = (w) => void cloud.restUpsert(w, 'request', req, { name: 'Edited elsewhere' })
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(syncCalls()).toEqual(['pull', 'push'])
    expect(s.openConflicts).toBe(1)
    expect((await d.api.listSyncConflicts(ws))[0]).toMatchObject({ kind: 'local_deleted', entityId: req })
    expect(cloud.entity(req)).toBeDefined()
  })
})

describe('not_found', () => {
  it('editing a row the server deleted: the next pull brings the tombstone -> remote_deleted; keep_local re-creates it', async () => {
    const { d, ws, remoteId, req, edit } = await withRequest()
    await edit({ name: 'Edited here' })
    cloud.beforePush = (w) => cloud.restDelete(w, 'request', req)
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ code: 'sync_conflict', reason: 'not_found' })
    expect(syncCalls()).toEqual(['pull', 'push', 'pull']) // frozen after that pull: nothing left to push
    expect(s.openConflicts).toBe(1)
    const [c] = await d.api.listSyncConflicts(ws)
    expect(c).toMatchObject({ kind: 'remote_deleted', entityId: req })
    await d.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_local' })
    await settle(d, ws)
    expect(cloud.entity(req)!.data.name).toBe('Edited here')
    serverMatchesDevice(d, ws, remoteId)
  })

  it('a create whose parent is gone on the server pulls first, then surfaces remote_deleted (never quarantined)', async () => {
    const { d, ws, col } = await withRequest()
    await d.api.createRequest({ workspaceId: ws, collectionId: col, name: 'New here', method: 'GET', url: 'u', documentJson: DOC })
    cloud.beforePush = (w) => cloud.restDelete(w, 'collection', col)
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(syncCalls().slice(0, 3)).toEqual(['pull', 'push', 'pull'])
    const kinds = (await d.api.listSyncConflicts(ws)).map((c) => c.kind)
    expect(kinds).toContain('remote_deleted')
    expect(kinds).not.toContain('rejected')
    expect(s.openConflicts).toBeGreaterThan(0)
  })

  it('deleting something that is already gone counts as done', async () => {
    const { d, ws, req } = await withRequest()
    await d.api.deleteRequest(req)
    cloud.beforePush = (w) => cloud.restDelete(w, 'request', req)
    const s = await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ code: 'not_found', reason: 'not_found' })
    expect(s).toMatchObject({ pendingChanges: 0, openConflicts: 0 })
    expect(getEntity(d.db, 'request', req)).toMatchObject({ remote_deleted: 1 })
  })
})

describe('invalid / too_large / id_in_use', () => {
  it('too_large from the server (a cap the device does not check) quarantines once, with the server message', async () => {
    const { d, ws, req } = await withRequest()
    d.db.prepare('UPDATE requests SET method = ? WHERE id = ?').run('M'.repeat(40), req)
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ code: 'invalid_request', reason: 'too_large' })
    expect(s.openConflicts).toBe(1)
    const [c] = await d.api.listSyncConflicts(ws)
    expect(c).toMatchObject({ kind: 'rejected', entityId: req })
    expect(c!.message).toMatch(/too large/)
    cloud.clearRecorded()
    await d.core.sync.syncNow(ws)
    expect(syncCalls()).toEqual(['pull']) // not retried in a loop
  })

  it('invalid (a method the server does not accept) quarantines and re-arms on edit', async () => {
    const { d, ws, col, req } = await withRequest()
    d.db.prepare('UPDATE requests SET method = ? WHERE id = ?').run('NOT A TOKEN', req)
    const s = await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ code: 'invalid_request', reason: 'invalid' })
    expect(s.openConflicts).toBe(1)
    const cur = (await d.api.listRequests(col)).find((r) => r.id === req)!
    await d.api.updateRequest({ requestId: req, name: cur.name, method: 'PATCH', url: cur.url, documentJson: DOC, expectedVersion: cur.version })
    const s2 = await d.core.sync.syncNow(ws)
    expect(s2).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    expect(cloud.entity(req)!.data.method).toBe('PATCH')
  })

  it('invalid "folder does not exist" (deleted meanwhile) is not quarantined: pull first, then remote_deleted keeps the request', async () => {
    const { d, ws, remoteId, col, req } = await withRequest()
    const other = await d.api.createFolder({ workspaceId: ws, collectionId: col, name: 'Other' })
    await d.core.sync.syncNow(ws)
    await d.api.moveRequest({ requestId: req, targetCollectionId: col, targetFolderId: other.id, targetIndex: 0 })
    cloud.beforePush = (w) => cloud.restDelete(w, 'folder', other.id)
    cloud.clearRecorded()
    await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ code: 'invalid_request', reason: 'invalid', message: expect.stringMatching(/folder_id does not exist/) })
    expect(syncCalls().slice(0, 3)).toEqual(['pull', 'push', 'pull'])
    const open = await d.api.listSyncConflicts(ws)
    expect(open.map((c) => `${c.kind}:${c.entityId}`).sort()).toEqual([`remote_deleted:${other.id}`, `remote_deleted:${req}`].sort())
    // keep_local brings the folder back (re-created) with the request inside
    await d.api.resolveSyncConflict({ conflictId: open.find((c) => c.entityId === other.id)!.id, resolution: 'keep_local' })
    const s = await settle(d, ws)
    expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    expect(cloud.entity(req)!.data).toMatchObject({ folder_id: other.id })
    serverMatchesDevice(d, ws, remoteId)
  })

  it('id_in_use (content republished after unlink) is quarantined with an explanation', async () => {
    const { d, ws } = await published(async (d, ws) => void (await d.api.createCollection(ws, 'Once')))
    await d.api.unlinkWorkspace(ws)
    await d.api.publishWorkspace(ws)
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ code: 'conflict', reason: 'id_in_use' })
    expect(s.openConflicts).toBe(1)
    expect((await d.api.listSyncConflicts(ws))[0]!.message).toMatch(/already used by another cloud workspace/)
  })
})

describe('duplicate_key', () => {
  it('a variable key taken in the cloud meanwhile: the local variable is renamed, both end up everywhere', async () => {
    let envId = ''
    const { d, ws, remoteId } = await published(async (d, ws) => void (envId = (await d.api.createEnvironment(ws, 'Prod')).id))
    const mine = await d.api.upsertEnvironmentVariable({ environmentId: envId, key: 'base_url', value: 'mine', isSecret: false })
    const theirs = '0190aaaa-0000-7000-8000-000000000002'
    cloud.beforePush = (w) => void cloud.restUpsert(w, 'environment_variable', theirs, { environment_id: envId, key: 'base_url', value: 'theirs', is_secret: false })
    await settle(d, ws)
    expect(firstRejection()).toMatchObject({ reason: 'duplicate_key', conflicting_resource_id: theirs })
    const vars = (await d.api.listEnvironmentVariables(envId)).map((v) => `${v.id === mine.id ? 'mine' : 'theirs'}:${v.key}=${v.value}`).sort()
    expect(vars).toEqual(['mine:base_url_conflict=mine', 'theirs:base_url=theirs'])
    expect(pendingCount(d, ws)).toBe(0)
    serverMatchesDevice(d, ws, remoteId)
  })

  it('a version label held by OUR OWN pending delete is not a clash: the create is simply retried after it', async () => {
    let colId = ''
    const { d, ws, remoteId } = await published(async (d, ws) => {
      colId = (await d.api.createCollection(ws, 'C')).id
      await d.api.createCollectionVersion({ collectionId: colId, version: '1.0.0', notes: 'old' })
    })
    const old = (await d.api.listCollectionVersions(colId))[0]!
    await d.api.deleteCollectionVersion(old.id)
    const fresh = await d.api.createCollectionVersion({ collectionId: colId, version: '1.0.0', notes: 'new' })
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    // upserts go before deletes: the create meets the old label once, then passes (no pull in between)
    expect(firstRejection()).toMatchObject({ reason: 'duplicate_key', conflicting_resource_id: old.id })
    expect(syncCalls()).toEqual(['pull', 'push', 'push'])
    expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    expect(cloud.live(remoteId, 'collection_version').map((v) => v.id)).toEqual([fresh.id])
    serverMatchesDevice(d, ws, remoteId)
  })

  it('a version label taken by another device: the local version is hidden as immutable_clash; duplicate re-creates it', async () => {
    let colId = ''
    const { d, ws, remoteId } = await published(async (d, ws) => void (colId = (await d.api.createCollection(ws, 'C')).id))
    const mine = await d.api.createCollectionVersion({ collectionId: colId, version: '2.0.0', notes: 'mine' })
    const theirs = '0190aaaa-0000-7000-8000-000000000003'
    cloud.beforePush = (w) =>
      void cloud.restUpsert(w, 'collection_version', theirs, { collection_id: colId, semver: '2.0.0', notes: 'theirs', snapshot_json: '{}', folder_count: 0, request_count: 0, created_at: '2026-01-01T00:00:00.000Z' })
    await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ reason: 'duplicate_key', conflicting_resource_id: theirs })
    const [c] = await d.api.listSyncConflicts(ws)
    expect(c).toMatchObject({ kind: 'immutable_clash', entityId: mine.id })
    await d.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'duplicate', newVersion: '2.0.1' })
    await settle(d, ws)
    expect(cloud.live(remoteId, 'collection_version').map((v) => v.data.semver).sort()).toEqual(['2.0.0', '2.0.1'])
    serverMatchesDevice(d, ws, remoteId)
  })
})

describe('immutable', () => {
  it('the same version id with different content in the cloud: immutable_clash carrying the cloud copy; keep_remote takes it', async () => {
    let colId = ''
    const { d, ws, remoteId } = await published(async (d, ws) => void (colId = (await d.api.createCollection(ws, 'C')).id))
    const mine = await d.api.createCollectionVersion({ collectionId: colId, version: '3.0.0', notes: 'mine' })
    const wire = { collection_id: colId, semver: '3.0.0', notes: 'cloud copy', snapshot_json: '{}', folder_count: 0, request_count: 0, created_at: '2026-01-01T00:00:00.000Z' }
    cloud.beforePush = (w) => void cloud.restUpsert(w, 'collection_version', mine.id, wire)
    await d.core.sync.syncNow(ws)
    expect(firstRejection()).toMatchObject({ code: 'conflict', reason: 'immutable', current_version: 1, current_payload: { notes: 'cloud copy' } })
    // the pulled log entry of the cloud copy keeps the clash open instead of silently un-hiding the local copy
    await settle(d, ws)
    const [c] = await d.api.listSyncConflicts(ws)
    expect(c).toMatchObject({ kind: 'immutable_clash', entityId: mine.id })
    expect(await d.api.listCollectionVersions(colId)).toEqual([])
    await d.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_remote' })
    const s = await settle(d, ws)
    expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    expect((await d.api.listCollectionVersions(colId)).map((v) => [v.id, v.notes])).toEqual([[mine.id, 'cloud copy']])
    serverMatchesDevice(d, ws, remoteId)
  })
})

describe('read_only', () => {
  it('a viewer push (403 details.reason read_only) switches the link to read-only without a role round trip; changes are kept', async () => {
    const { user, d, ws, remoteId, edit } = await withRequest()
    await edit({ name: 'Made as editor' })
    cloud.beforePush = (w) => cloud.setRole(w, user.id, 'viewer') // downgraded between the role check and the push
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(cloud.requests.filter((r) => /\/v1\/workspaces\/[^/]+$/.test(r.path))).toHaveLength(1) // the cycle's own role check only
    expect(s).toMatchObject({ readOnly: true, role: 'viewer', state: 'idle', pendingChanges: 1 })
    expect(getLink(d.db, ws)!.read_only).toBe(1)
    await expect(d.api.createCollection(ws, 'nope')).rejects.toBeTruthy()
    void remoteId
  })
})

describe('reason vs legacy code', () => {
  const r = (code: string, reason?: string) => ({ code, reason }) as Parameters<typeof rejectionReason>[0]
  it('branches on reason when present and known, otherwise derives it from the legacy code', () => {
    expect(rejectionReason(r('sync_conflict', 'not_found'), 'request')).toBe('not_found')
    expect(rejectionReason(r('conflict', 'duplicate_key'), 'collection')).toBe('duplicate_key')
    expect(rejectionReason(r('invalid_request', 'too_large'), 'request')).toBe('too_large')
    expect(rejectionReason(r('sync_conflict'), 'request')).toBe('version_mismatch')
    expect(rejectionReason(r('not_found'), 'request')).toBe('not_found')
    expect(rejectionReason(r('invalid_request'), 'request')).toBe('invalid')
    expect(rejectionReason(r('conflict'), 'environment_variable')).toBe('duplicate_key')
    expect(rejectionReason(r('conflict'), 'collection_version')).toBe('duplicate_key')
    expect(rejectionReason(r('conflict'), 'folder')).toBe('id_in_use')
    expect(rejectionReason(r('internal_error'), 'folder')).toBe('internal_error')
    expect(rejectionReason(r('not_found', 'some_future_reason'), 'folder')).toBe('not_found')
  })

  it('a legacy response (code only, no current_payload) keeps the pull-then-retry path', async () => {
    const { d, ws, req, edit } = await withRequest()
    await edit({ url: 'https://x/2' })
    const built = buildOps(d.db, ws, Date.now()).ops
    const resp: PushResponse = {
      accepted: [], checkpoint: 0,
      rejected: [{ operation_id: built[0]!.op.operation_id, resource_id: req, code: 'sync_conflict', message: 'stale', current_version: 9 }],
    }
    const out = applyTx(d.db, () => applyPushResponse(makeApplyCtx({ db: d.db, secrets: d.secrets, nowS: 1, effects: [] }, ws), built, resp))
    expect(out).toMatchObject({ resolved: 0, conflicts: 0 })
    expect(out.retry.map((b) => b.id)).toEqual([req])
    expect(pendingCount(d, ws)).toBe(1)
  })

  it('reserved per-operation read_only / forbidden never drop the change', async () => {
    const { d, ws, req, edit } = await withRequest()
    await edit({ url: 'https://x/3' })
    const built = buildOps(d.db, ws, Date.now()).ops
    for (const reason of ['read_only', 'forbidden'] as const) {
      const resp: PushResponse = {
        accepted: [], checkpoint: 0,
        rejected: [{ operation_id: built[0]!.op.operation_id, resource_id: req, code: 'invalid_request', reason, message: 'no', current_version: null }],
      }
      const out = applyTx(d.db, () => applyPushResponse(makeApplyCtx({ db: d.db, secrets: d.secrets, nowS: 1, effects: [] }, ws), built, resp))
      expect(out).toMatchObject({ denied: reason, conflicts: 0, retry: [] })
      expect(pendingCount(d, ws)).toBe(1)
      expect(getEntity(d.db, 'request', req)!.state).toBe('synced')
    }
  })
})
