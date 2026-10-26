import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCloud } from './fakeCloud'
import { DOC, makeDevice, settle, type Device } from './harness'

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
const dev = (userId: string) => {
  const d = makeDevice(cloud, { userId })
  devices.push(d)
  return d
}
const uuid = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const deferred = (d: Device) => d.db.prepare('SELECT * FROM sync_deferred ORDER BY entity_id').all() as Array<Record<string, unknown>>
const notes = async (d: Device, ws: string) => (await d.api.listSyncConflicts(ws, true)).filter((c) => c.status === 'auto_resolved')
const folderIds = (d: Device) => (d.db.prepare('SELECT id FROM folders WHERE deleted = 0').all() as Array<{ id: string }>).map((r) => r.id).sort()
const requestRow = (d: Device, id: string) => d.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Record<string, unknown> | undefined

/** A cloud workspace with a nested folder chain whose ids sort child-first, behind 250 root folders (two snapshot pages). */
function nestedWorkspace() {
  const user = cloud.createUser(`u${Math.random().toString(36).slice(2)}@example.com`)
  const w = cloud.createWorkspace('Nested', user.id)
  const col = uuid('c', 1)
  cloud.restUpsert(w.id, 'collection', col, { name: 'Col' })
  for (let i = 0; i < 250; i++) cloud.restUpsert(w.id, 'folder', uuid('2', i), { collection_id: col, parent_folder_id: null, name: `F${i}`, sort_order: i })
  // grandparent "f…" (last page), parent "e…" (last page), child "1…" (first page): id order is leaf-first
  const top = uuid('f', 1)
  const mid = uuid('e', 1)
  const leaf = uuid('1', 1)
  cloud.restUpsert(w.id, 'folder', top, { collection_id: col, parent_folder_id: null, name: 'Top', sort_order: 0 })
  cloud.restUpsert(w.id, 'folder', mid, { collection_id: col, parent_folder_id: top, name: 'Mid', sort_order: 0 })
  cloud.restUpsert(w.id, 'folder', leaf, { collection_id: col, parent_folder_id: mid, name: 'Leaf', sort_order: 0 })
  const req = uuid('3', 1)
  cloud.restUpsert(w.id, 'request', req, { collection_id: col, folder_id: leaf, name: 'Deep', method: 'GET', url: 'https://x', document_json: DOC, sort_order: 0 })
  return { user, w, col, top, mid, leaf, req }
}

describe('initial download: folders whose parent comes later', () => {
  for (const legacy of [false, true]) {
    it(`${legacy ? 'an older server (folders by id)' : 'a current server (parent-first)'}: nothing is dropped`, async () => {
      cloud.legacyFolderOrder = legacy
      const n = nestedWorkspace()
      const d = dev(n.user.id)
      const link = await d.api.linkRemoteWorkspace({ remoteWorkspaceId: n.w.id, localWorkspaceId: null })
      const s = await settle(d, link.workspace.id)
      expect(s.state).toBe('idle')
      expect(s.initialSyncPending).toBe(false)
      expect(folderIds(d)).toEqual(cloud.live(n.w.id, 'folder').map((e) => e.id).sort())
      expect(folderIds(d)).toHaveLength(253)
      expect(requestRow(d, n.req)).toMatchObject({ folder_id: n.leaf, deleted: 0 })
      expect(deferred(d)).toEqual([])
      expect(await notes(d, link.workspace.id)).toEqual([]) // settled within the download: nothing to report
      expect(s.pendingChanges).toBe(0)
    })
  }

  it('folder auth (container_auth) survives a folder that waited for its parent', async () => {
    cloud.legacyFolderOrder = true
    const n = nestedWorkspace()
    const auth = JSON.stringify({ type: 'bearer', bearer: [{ key: 'token', value: '{{leaf}}', type: 'string' }] })
    cloud.restUpsert(n.w.id, 'folder', n.leaf, { auth_json: auth })
    cloud.restUpsert(n.w.id, 'folder', n.mid, { auth_json: '{"type":"noauth"}' })
    cloud.restUpsert(n.w.id, 'collection', n.col, { auth_json: auth })
    const d = dev(n.user.id)
    const link = await d.api.linkRemoteWorkspace({ remoteWorkspaceId: n.w.id, localWorkspaceId: null })
    await settle(d, link.workspace.id)
    const authOf = (table: string, id: string) => (d.db.prepare(`SELECT auth_json FROM ${table} WHERE id = ?`).get(id) as { auth_json: string | null }).auth_json
    expect(authOf('folders', n.leaf)).toBe(auth)
    expect(authOf('folders', n.mid)).toBe('{"type":"noauth"}')
    expect(authOf('collections', n.col)).toBe(auth)
    expect(deferred(d)).toEqual([])
    expect((await d.api.getSyncStatus(link.workspace.id)).pendingChanges).toBe(0)
  })

  it('the fake server, like the real one, sends folders parent-first across pages', async () => {
    const n = nestedWorkspace()
    const d = dev(n.user.id)
    const link = await d.api.linkRemoteWorkspace({ remoteWorkspaceId: n.w.id, localWorkspaceId: null })
    cloud.clearRecorded()
    await settle(d, link.workspace.id, 1)
    const pages = cloud.requestsTo(/sync\/snapshot$/)
    expect(pages.length).toBeGreaterThanOrEqual(2)
    // no change was ever deferred: every parent arrived first
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM sync_deferred').get()).toEqual({ n: 0 })
  })
})

async function linked() {
  const user = cloud.createUser(`u${Math.random().toString(36).slice(2)}@example.com`)
  const d = dev(user.id)
  const ws = d.workspace.id
  const col = await d.api.createCollection(ws, 'Shop')
  await d.api.publishWorkspace(ws)
  const st = await settle(d, ws)
  return { d, ws, col: col.id, remote: st.remoteWorkspaceId! }
}

describe('pulled changes that cannot be applied yet are kept and retried', () => {
  it('a request whose folder has not arrived is kept, noted once, and applied when the folder comes', async () => {
    const { d, ws, col, remote } = await linked()
    const folder = uuid('9', 1)
    const req = uuid('3', 7)
    // the server's log has the request before its folder (e.g. written by an older client); here the folder comes later
    cloud.restUpsert(remote, 'request', req, { collection_id: col, folder_id: folder, name: 'Orphan', method: 'GET', url: 'https://x', document_json: DOC, sort_order: 0 })
    await d.core.sync.syncNow(ws)
    expect(requestRow(d, req)).toBeUndefined()
    expect(deferred(d)).toMatchObject([{ entity_id: req, reason: 'missing_parent', op: 'upsert', noted: 1 }])
    const first = await notes(d, ws)
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ entityId: req, label: 'Orphan' })
    // the checkpoint moved on (the change is kept locally, not re-downloaded)
    await d.core.sync.syncNow(ws)
    expect(await notes(d, ws)).toHaveLength(1) // noted once, not on every sync
    cloud.restUpsert(remote, 'folder', folder, { collection_id: col, parent_folder_id: null, name: 'Late', sort_order: 0 })
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    expect(requestRow(d, req)).toMatchObject({ folder_id: folder, name: 'Orphan', deleted: 0 })
    expect(deferred(d)).toEqual([])
    expect(s.pendingChanges).toBe(0)
  })

  it('a later change of the same entity replaces the kept one (a delete drops it)', async () => {
    const { d, ws, col, remote } = await linked()
    const req = uuid('3', 8)
    cloud.restUpsert(remote, 'request', req, { collection_id: col, folder_id: uuid('9', 2), name: 'Orphan', method: 'GET', url: 'https://x', document_json: DOC, sort_order: 0 })
    await d.core.sync.syncNow(ws)
    expect(deferred(d)).toHaveLength(1)
    cloud.restDelete(remote, 'request', req)
    await d.core.sync.syncNow(ws)
    expect(deferred(d)).toEqual([])
    expect(requestRow(d, req)).toBeUndefined()
  })

  it('an operation that fails to apply is kept and applied on a later pull; the failure is noted once', async () => {
    const { d, ws, col, remote } = await linked()
    const req = uuid('3', 9)
    d.db.exec("CREATE TRIGGER boom BEFORE INSERT ON requests WHEN NEW.name = 'Boom' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END")
    cloud.restUpsert(remote, 'request', req, { collection_id: col, folder_id: null, name: 'Boom', method: 'GET', url: 'https://x', document_json: DOC, sort_order: 0 })
    await d.core.sync.syncNow(ws)
    await d.core.sync.syncNow(ws)
    expect(requestRow(d, req)).toBeUndefined()
    expect(deferred(d)).toMatchObject([{ entity_id: req, reason: 'failed', attempts: 2 }])
    const n = await notes(d, ws)
    expect(n).toHaveLength(1)
    expect(n[0]!.message).toContain('simulated failure')
    d.db.exec('DROP TRIGGER boom')
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    expect(requestRow(d, req)).toMatchObject({ name: 'Boom', deleted: 0 })
    expect(deferred(d)).toEqual([])
    expect(s.pendingChanges).toBe(0)
  })

  it('unlink removes kept changes with the rest of the bookkeeping', async () => {
    const { d, ws, col, remote } = await linked()
    cloud.restUpsert(remote, 'request', uuid('3', 10), { collection_id: col, folder_id: uuid('9', 3), name: 'Orphan', method: 'GET', url: 'https://x', document_json: DOC, sort_order: 0 })
    await d.core.sync.syncNow(ws)
    expect(deferred(d)).toHaveLength(1)
    await d.api.unlinkWorkspace(ws)
    expect(deferred(d)).toEqual([])
  })
})

describe('pull progress guard', () => {
  it('a server that says "more" without moving the checkpoint fails the cycle instead of looping', async () => {
    const { d, ws } = await linked()
    const cp = (d.db.prepare('SELECT sync_checkpoint AS c FROM cloud_links').get() as { c: number }).c
    cloud.faults.push({ match: /GET .*sync\/pull$/, action: 'status', status: 200, body: { operations: [], checkpoint: cp, has_more: true }, times: 1000 })
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('error')
    expect(s.lastError?.message).toMatch(/did not move/)
    expect(cloud.requestsTo(/sync\/pull$/).length).toBeLessThan(10)
  })
})

describe('keychain clean-up after a pulled delete', () => {
  it('a secret value that cannot be removed from the keychain is reported in Sync activity', async () => {
    const { d, ws, remote } = await linked()
    const env = await d.api.createEnvironment(ws, 'Prod')
    const v = await d.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'token', value: 's3cret', isSecret: true })
    await settle(d, ws)
    d.secrets.delete = () => {
      throw new Error('keyring locked')
    }
    cloud.restDelete(remote, 'environment_variable', v.id)
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    const n = (await notes(d, ws)).filter((c) => c.entityId === v.id)
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ label: 'token' })
    expect(n[0]!.message).toContain('keyring locked')
  })
})

describe('discarding or keeping while a push is in flight', () => {
  async function inFlight(act: (d: Device, ws: string, reqId: string) => Promise<unknown>) {
    const { d, ws, col, remote } = await linked()
    const r = await d.api.createRequest({ workspaceId: ws, collectionId: col, folderId: null, name: 'Orig', method: 'GET', url: 'https://x', documentJson: DOC })
    await settle(d, ws)
    await d.api.renameRequest(r.id, 'Changed')
    let pending: Promise<unknown> | null = null
    let settledEarly = false
    cloud.beforePush = () => {
      cloud.beforePush = null
      // the user acts while the push of the rename is on the wire
      pending = act(d, ws, r.id).then(() => {
        settledEarly = true
      })
    }
    const cycle = d.core.sync.syncNow(ws)
    await cycle
    await pending
    expect(settledEarly).toBe(true)
    return { d, ws, r, remote }
  }

  it('discard waits for the push to be answered, so the answer cannot undo it', async () => {
    const { d, ws, r } = await inFlight((d, ws, id) => d.api.discardPendingItems(ws, [{ entityType: 'request', entityId: id }]))
    // The rename reached the cloud before the discard ran: the local copy must equal the cloud's (and the agreed base).
    const cloudName = cloud.entity(r.id)!.data.name
    expect(requestRow(d, r.id)!.name).toBe(cloudName)
    const base = JSON.parse((d.db.prepare('SELECT base_payload FROM sync_entities WHERE entity_id = ?').get(r.id) as { base_payload: string }).base_payload)
    expect(base.name).toBe(cloudName)
    expect((await settle(d, ws)).pendingChanges).toBe(0)
    expect(requestRow(d, r.id)!.name).toBe(cloud.entity(r.id)!.data.name)
  })

  it('discard of all pending changes waits too', async () => {
    const { d, ws, r } = await inFlight((d, ws) => d.api.discardPendingChanges(ws))
    expect(requestRow(d, r.id)!.name).toBe(cloud.entity(r.id)!.data.name)
    expect((await settle(d, ws)).pendingChanges).toBe(0)
  })

  it('keep-on-device waits too (the answer cannot clear the choice)', async () => {
    const { d, ws, r } = await inFlight(async (d, ws, id) => {
      await d.api.renameRequest(id, 'Third')
      return d.api.setSyncKept(ws, [{ entityType: 'request', entityId: id }], true)
    })
    expect(requestRow(d, r.id)!.name).toBe('Third')
    expect((await d.api.listSyncKept(ws)).map((i) => i.entityId)).toEqual([r.id])
    await settle(d, ws)
    expect(cloud.entity(r.id)!.data.name).toBe('Changed') // the kept rename stays on this device
  })
})
