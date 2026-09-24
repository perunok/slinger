import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tokenKey } from '../../cloud/auth'
import { FakeCloud } from './fakeCloud'
import { DOC, FakeClock, converge, liveState, makeDevice, makePair, pendingCount, settle, type Device } from './harness'

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
const dev = (userId: string, opts: Parameters<typeof makeDevice>[1] = {}) => {
  const d = makeDevice(cloud, { userId, ...opts })
  devices.push(d)
  return d
}
const rt = (d: Device, ws: string) => d.db.prepare('SELECT * FROM cloud_links WHERE workspace_id = ?').get(ws) as Record<string, unknown>
const pushes = () => cloud.requests.filter((r) => r.method === 'POST' && /sync\/push$/.test(r.path))
const pushedOps = () => pushes().flatMap((r) => (JSON.parse(r.body) as { operations: Array<{ operation_id: string; resource_id: string; op: string; resource_type: string; base_version: number }> }).operations)

async function published(opts: { seed?: (d: Device, ws: string) => Promise<void> } = {}) {
  const user = cloud.createUser('ana@example.com')
  const d = dev(user.id)
  await opts.seed?.(d, d.workspace.id)
  await d.api.publishWorkspace(d.workspace.id)
  const st = await settle(d, d.workspace.id)
  return { user, d, ws: d.workspace.id, remoteId: st.remoteWorkspaceId! }
}
const col = (d: Device, ws: string, name = 'C') => d.api.createCollection(ws, name)
const req = (d: Device, ws: string, colId: string, name = 'R', folderId: string | null = null) =>
  d.api.createRequest({ workspaceId: ws, collectionId: colId, folderId, name, method: 'GET', url: 'https://x', documentJson: DOC })

describe('cycle mechanics', () => {
  it('pulls before it pushes, and takes the checkpoint from pull only', async () => {
    const { d, ws, remoteId } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    cloud.clearRecorded()
    const c = (await d.api.listCollections(ws))[0]!
    await d.api.renameCollection(c.id, 'Renamed')
    await d.core.sync.syncNow(ws)
    const order = cloud.requests.filter((r) => /sync\/(pull|push)$/.test(r.path)).map((r) => r.path.split('/').pop())
    expect(order[0]).toBe('pull')
    expect(order).toContain('push')
    expect(order.indexOf('push')).toBeGreaterThan(order.indexOf('pull'))
    // Our own op advanced the server checkpoint, but the stored checkpoint only covers what we PULLED.
    const serverCp = cloud.workspaces.get(remoteId)!.checkpoint
    expect(rt(d, ws).sync_checkpoint).toBe(serverCp - 1)
    await d.core.sync.syncNow(ws)
    expect(rt(d, ws).sync_checkpoint).toBe(serverCp) // the echo was pulled and recognised
    expect(pendingCount(d, ws)).toBe(0)
  })

  it('never writes request history (cloud traffic is not user traffic)', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    await d.core.sync.syncNow(ws)
    expect(await d.api.listHistory(ws)).toEqual([])
  })

  it('a large import is pushed parents-first in resumable chunks of at most 200 operations', async () => {
    const { d, ws } = await published()
    cloud.clearRecorded()
    const items = Array.from({ length: 450 }, (_, i) => ({ name: `Req ${i}`, request: { method: 'GET', url: `https://x/${i}` } }))
    await d.api.importPostmanCollection(ws, JSON.stringify({ info: { name: 'Big', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: items }))
    await d.core.sync.syncNow(ws)
    const sizes = pushes().map((r) => (JSON.parse(r.body) as { operations: unknown[] }).operations.length)
    expect(sizes.length).toBeGreaterThanOrEqual(3)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200)
    const ops = pushedOps()
    expect(ops[0]!.resource_type).toBe('collection') // the parent goes first
    expect(cloud.live((rt(d, ws).remote_workspace_id as string), 'request')).toHaveLength(450)
    expect(pendingCount(d, ws)).toBe(0)
  })

  it('keeps 50 rapid edits of one entity as ONE operation', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    const c = (await d.api.listCollections(ws))[0]!
    cloud.clearRecorded()
    for (let i = 0; i < 50; i++) await d.api.renameCollection(c.id, `Name ${i}`)
    await d.core.sync.syncNow(ws)
    expect(pushedOps()).toHaveLength(1)
    expect(cloud.entity(c.id)!.data.name).toBe('Name 49')
  })
})

describe('idempotency and lost responses', () => {
  it('a lost push response is replayed with the SAME operation id and applied exactly once', async () => {
    const { d, ws, remoteId } = await published()
    const c = await col(d, ws, 'Lost')
    cloud.faults.push({ match: /POST .*sync\/push$/, action: 'drop-after' })
    const s1 = await d.core.sync.syncNow(ws)
    expect(s1.state).toBe('offline')
    expect(cloud.live(remoteId, 'collection')).toHaveLength(1) // applied server-side
    expect(pendingCount(d, ws)).toBe(1)
    cloud.clearRecorded()
    const s2 = await d.core.sync.syncNow(ws)
    expect(s2.state).toBe('idle')
    expect(pendingCount(d, ws)).toBe(0)
    expect(cloud.workspaces.get(remoteId)!.log.filter((o) => o.resource_id === c.id)).toHaveLength(1)
    // the first attempt's op id is the one that came back as an echo (sent-ops table is empty again)
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM sync_sent_ops').get()).toEqual({ n: 0 })
  })

  it('a push that never reached the server is retried unchanged', async () => {
    const { d, ws, remoteId } = await published()
    await col(d, ws, 'Retry')
    cloud.faults.push({ match: /POST .*sync\/push$/, action: 'drop-before' })
    expect((await d.core.sync.syncNow(ws)).state).toBe('offline')
    const firstOp = pushedOps().at(-1)!
    expect(cloud.live(remoteId, 'collection')).toHaveLength(0)
    await d.core.sync.syncNow(ws)
    expect(pushedOps().at(-1)!.operation_id).toBe(firstOp.operation_id)
    expect(cloud.live(remoteId, 'collection')).toHaveLength(1)
  })

  it('lost response + an edit before the retry converges through echo recognition (no conflict)', async () => {
    const { d, ws, remoteId } = await published()
    const c = await col(d, ws, 'V1')
    cloud.faults.push({ match: /POST .*sync\/push$/, action: 'drop-after' })
    await d.core.sync.syncNow(ws)
    await d.api.renameCollection(c.id, 'V2') // changes again while the first op is unacknowledged
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    expect(s.openConflicts).toBe(0)
    await d.core.sync.syncNow(ws)
    expect(cloud.entity(c.id)!.data.name).toBe('V2')
    expect(cloud.entity(c.id)!.version).toBe(2)
    expect(pendingCount(d, ws)).toBe(0)
    void remoteId
  })

  it('a crash between accept and clear re-converges: accepted ops are simply re-sent and answered from the log', async () => {
    const { d, ws, remoteId } = await published()
    const c = await col(d, ws, 'Crash')
    await d.core.sync.syncNow(ws)
    // Simulate the crash: put the bookkeeping back as if the ack transaction never committed.
    d.db.prepare("DELETE FROM sync_entities WHERE entity_id = ?").run(c.id)
    d.db.prepare("INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq, op_id) VALUES ('collection', ?, ?, 1, ?)").run(c.id, ws, cloud.workspaces.get(remoteId)!.log.find((o) => o.resource_id === c.id)!.operation_id)
    d.db.prepare("INSERT INTO sync_sent_ops (op_id, workspace_id, entity_type, entity_id, sent_at) SELECT op_id, workspace_id, entity_type, entity_id, 1 FROM sync_dirty WHERE entity_id = ?").run(c.id)
    d.db.prepare('UPDATE cloud_links SET sync_checkpoint = 0').run()
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    expect(pendingCount(d, ws)).toBe(0)
    expect(cloud.workspaces.get(remoteId)!.log.filter((o) => o.resource_id === c.id)).toHaveLength(1)
  })
})

describe('authentication', () => {
  it('refreshes once on 401 even for concurrent calls, persisting the rotated pair before use', async () => {
    const user = cloud.createUser('a@x.com')
    const d = dev(user.id)
    cloud.expireAccessTokens()
    cloud.clearRecorded()
    const r = await Promise.all([d.api.listRemoteWorkspaces(), d.api.listRemoteWorkspaces(), d.api.listRemoteWorkspaces()])
    expect(r).toHaveLength(3)
    expect(cloud.requestsTo(/\/auth\/refresh$/)).toHaveLength(1)
    const stored = JSON.parse(d.secrets.get(tokenKey(cloud.baseUrl))!) as { accessToken: string; refreshToken: string }
    expect(cloud.requestsTo(/\/workspaces$/).at(-1)!.userId).toBe(user.id)
    expect(stored.refreshToken).not.toBe('')
  })

  it('a revoked refresh token signs the session out: links and pending changes stay', async () => {
    const { user, d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    cloud.revokeAllRefreshTokens(user.id)
    cloud.expireAccessTokens()
    await d.api.createCollection(ws, 'While signed out')
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('signedOut')
    expect(s.linked).toBe(true)
    expect(s.pendingChanges).toBe(1)
    expect(d.secrets.get(tokenKey(cloud.baseUrl))).toBeNull()
    expect((await d.api.getCloudSession()).status).toBe('signedOut')
    expect(d.events.some((e) => e.type === 'auth' && e.session.status === 'signedOut')).toBe(true)
  })

  it('a network failure while refreshing does not burn the refresh token', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    const before = d.secrets.get(tokenKey(cloud.baseUrl))
    cloud.expireAccessTokens()
    cloud.faults.push({ match: /POST \/v1\/auth\/refresh$/, action: 'drop-before' })
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('offline')
    expect(d.secrets.get(tokenKey(cloud.baseUrl))).toBe(before)
    expect((await d.core.sync.syncNow(ws)).state).toBe('idle')
  })

  it('requires sign-in for cloud calls', async () => {
    const user = cloud.createUser('a@x.com')
    const d = dev(user.id, { signedIn: false })
    await expect(d.api.listRemoteWorkspaces()).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(d.api.publishWorkspace(d.workspace.id)).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('re-registers when the server no longer knows the client id', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    cloud.forgetClients()
    await d.api.createCollection(ws, 'After reset')
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    expect(s.pendingChanges).toBe(0)
    expect(cloud.requestsTo(/clients\/register$/).length).toBeGreaterThanOrEqual(2)
  })
})

describe('roles and access', () => {
  it('downgrade to viewer: pending changes are kept, writes become read_only, upgrade resumes pushing', async () => {
    const { user, d, ws, remoteId } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    await d.api.createCollection(ws, 'Made as editor')
    cloud.setRole(remoteId, user.id, 'viewer')
    const s = await d.core.sync.syncNow(ws)
    expect(s.readOnly).toBe(true)
    expect(s.role).toBe('viewer')
    expect(s.pendingChanges).toBe(1)
    expect(s.state).toBe('idle') // pull-only, not an error
    await expect(d.api.createCollection(ws, 'nope')).rejects.toBeTruthy()
    cloud.setRole(remoteId, user.id, 'editor')
    const s2 = await d.core.sync.syncNow(ws)
    expect(s2.readOnly).toBe(false)
    expect(s2.pendingChanges).toBe(0)
    expect(cloud.live(remoteId, 'collection')).toHaveLength(2)
  })

  it('discardPendingChanges resets a downgraded workspace to the cloud state', async () => {
    const { user, d, ws, remoteId } = await published({ seed: async (d, ws) => void (await col(d, ws, 'Keep')) })
    const keep = (await d.api.listCollections(ws))[0]!
    await d.api.renameCollection(keep.id, 'Local rename')
    await d.api.createCollection(ws, 'Never pushed')
    cloud.setRole(remoteId, user.id, 'viewer')
    await d.core.sync.syncNow(ws)
    const s = await d.api.discardPendingChanges(ws)
    expect(s.pendingChanges).toBe(0)
    expect((await d.api.listCollections(ws)).map((c) => c.name)).toEqual(['Keep'])
  })

  it('removed membership -> accessRevoked; deleted workspace -> accessRevoked (workspace_deleted); content stays', async () => {
    const { user, d, ws, remoteId } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    await d.api.createCollection(ws, 'Pending')
    cloud.setRole(remoteId, user.id, null)
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('accessRevoked')
    expect(s.lastError?.code).toBe('access_revoked')
    expect(s.pendingChanges).toBe(1)
    expect(await d.api.listCollections(ws)).toHaveLength(2)
    cloud.deleteWorkspace(remoteId)
    const s2 = await d.core.sync.syncNow(ws)
    expect(s2.state).toBe('accessRevoked')
    expect(s2.lastError?.code).toBe('workspace_deleted')
    await d.api.unlinkWorkspace(ws)
    expect((await d.api.getSyncStatus(ws)).state).toBe('unlinked')
    expect(await d.api.listCollections(ws)).toHaveLength(2)
  })

  it('an old server (protocol_version < 2) is refused before anything is uploaded', async () => {
    const old = await new FakeCloud({ protocolVersion: 1 }).start()
    try {
      const user = old.createUser('a@x.com')
      const d = makeDevice(old, { userId: user.id })
      devices.push(d)
      await col(d, d.workspace.id)
      await expect(d.api.publishWorkspace(d.workspace.id)).rejects.toMatchObject({ code: 'sync_blocked' })
      expect(old.requests.filter((r) => /sync\/push$/.test(r.path))).toHaveLength(0)
    } finally {
      await old.stop()
    }
  })
})

describe('failures, backoff and quarantine', () => {
  it('goes offline on network errors, keeps collecting edits, and recovers', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    cloud.faults.push({ match: /./, action: 'drop-before', times: 50 })
    await d.api.createCollection(ws, 'Offline 1')
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('offline')
    expect(s.lastError?.code).toBeTruthy()
    await d.api.createCollection(ws, 'Offline 2')
    cloud.faults.length = 0
    const ok = await d.core.sync.syncNow(ws)
    expect(ok.state).toBe('idle')
    expect(ok.pendingChanges).toBe(0)
    expect(ok.lastError).toBeNull()
  })

  it('backs off exponentially (5s, 10s, 20s ... capped at 5 min) and reports nextRetryAt', async () => {
    const user = cloud.createUser('backoff@x.com')
    const d = dev(user.id, { clock: new FakeClock(1_900_000_000_000) })
    const ws = d.workspace.id
    await col(d, ws)
    await d.api.publishWorkspace(ws)
    await settle(d, ws)
    cloud.faults.push({ match: /./, action: 'status', status: 503, times: 100 })
    const waits: number[] = []
    for (let i = 0; i < 9; i++) {
      const s = await d.core.sync.syncNow(ws)
      expect(s.state).toBe('error')
      waits.push(s.nextRetryAt! - d.clock.now() / 1000)
    }
    expect(waits.slice(0, 4)).toEqual([5, 10, 20, 40])
    expect(waits.at(-1)).toBe(300)
  })

  it('honours Retry-After on 429', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    cloud.faults.push({ match: /./, action: 'status', status: 429, headers: { 'Retry-After': '90' }, body: { error: { code: 'rate_limited', message: 'slow down' } } })
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('error')
    expect(s.nextRetryAt! - d.clock.now() / 1000).toBeGreaterThanOrEqual(89)
  })

  it('halves the chunk on 413 until it fits; a single operation that still does not fit is quarantined', async () => {
    const { d, ws, remoteId } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    cloud.pushBodyLimit = 40_000
    const c = (await d.api.listCollections(ws))[0]!
    const big = JSON.stringify({ headers: [], body: 'x'.repeat(9_000) })
    for (let i = 0; i < 12; i++) {
      await d.api.createRequest({ workspaceId: ws, collectionId: c.id, name: `R${i}`, method: 'POST', url: 'u', documentJson: big })
    }
    const s = await d.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    expect(cloud.live(remoteId, 'request')).toHaveLength(12)
    expect(pushes().some((r) => (JSON.parse(r.body) as { operations: unknown[] }).operations.length < 12)).toBe(true)
    // one request larger than the server accepts: quarantined, not retried forever
    cloud.pushBodyLimit = 20_000
    await d.api.createRequest({ workspaceId: ws, collectionId: c.id, name: 'Huge', method: 'POST', url: 'u', documentJson: JSON.stringify({ body: 'y'.repeat(30_000) }) })
    const s2 = await d.core.sync.syncNow(ws)
    expect(s2.openConflicts).toBe(1)
    expect((await d.api.listSyncConflicts(ws))[0]).toMatchObject({ kind: 'rejected', label: 'Huge' })
  })

  it('quarantines oversized/invalid items locally, keeps syncing everything else, and re-arms on edit', async () => {
    const { d, ws, remoteId } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    const c = (await d.api.listCollections(ws))[0]!
    const huge = JSON.stringify({ body: 'z'.repeat(950_000) })
    const bad = await d.api.createRequest({ workspaceId: ws, collectionId: c.id, name: 'Too big', method: 'POST', url: 'u', documentJson: huge })
    const long = await d.api.createRequest({ workspaceId: ws, collectionId: c.id, name: 'n'.repeat(300), method: 'GET', url: 'u', documentJson: DOC })
    await req(d, ws, c.id, 'Fine')
    const env = await d.api.createEnvironment(ws, 'E')
    await d.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'has space', value: '1', isSecret: false })
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(ws)
    expect(s.openConflicts).toBe(3)
    const sentIds = pushedOps().map((o) => o.resource_id)
    expect(sentIds).not.toContain(bad.id)
    expect(sentIds).not.toContain(long.id)
    expect(cloud.live(remoteId, 'request').map((e) => e.data.name)).toEqual(['Fine'])
    const messages = (await d.api.listSyncConflicts(ws)).map((x) => x.message).join('\n')
    expect(messages).toMatch(/1000|950|KB/)
    // a second cycle does not retry them
    cloud.clearRecorded()
    await d.core.sync.syncNow(ws)
    expect(pushedOps()).toEqual([])
    // editing re-arms: shrink the document
    const cur = (await d.api.listRequests(c.id)).find((r) => r.id === bad.id)!
    await d.api.updateRequest({ requestId: bad.id, name: 'Too big', method: 'POST', url: 'u', documentJson: DOC, expectedVersion: cur.version })
    const s3 = await d.core.sync.syncNow(ws)
    expect(s3.openConflicts).toBe(2)
    expect(cloud.entity(bad.id)).toBeDefined()
  })

  it('a server-side invalid_request quarantines the entity with the server message', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    const c = (await d.api.listCollections(ws))[0]!
    const r = await req(d, ws, c.id, 'X')
    // The server refuses names that trim to nothing after its own validation.
    d.db.prepare("UPDATE requests SET name = '   ' WHERE id = ?").run(r.id)
    const s = await d.core.sync.syncNow(ws)
    expect(s.openConflicts).toBe(1)
    const [k] = await d.api.listSyncConflicts(ws)
    expect(k).toMatchObject({ kind: 'rejected' })
    expect(k!.message).toMatch(/cloud rejected/i)
  })
})

describe('linking', () => {
  it('link-existing merges local content with the remote (union) and de-duplicates environments by name', async () => {
    const p = await makePair(cloud, async (a, ws) => {
      const c = await col(a, ws, 'Shared')
      await req(a, ws, c.id, 'RemoteReq')
      const e = await a.api.createEnvironment(ws, 'Prod')
      await a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'host', value: 'remote.example.com', isSecret: false })
      await a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'token', value: 'remote-secret-a', isSecret: true })
    })
    const c = dev(p.userId, { deviceName: 'C' })
    const lc = await col(c, c.workspace.id, 'Shared') // same NAME, different id: unioned, never merged silently
    await req(c, c.workspace.id, lc.id, 'LocalReq')
    const le = await c.api.createEnvironment(c.workspace.id, 'prod') // case-insensitive name match
    await c.api.upsertEnvironmentVariable({ environmentId: le.id, key: 'host', value: 'local.example.com', isSecret: false })
    await c.api.upsertEnvironmentVariable({ environmentId: le.id, key: 'token', value: 'local-secret-c', isSecret: true })
    await c.api.upsertEnvironmentVariable({ environmentId: le.id, key: 'only_local', value: '1', isSecret: false })
    const preview = await c.api.previewRemoteWorkspace(p.remoteId)
    expect(preview).toMatchObject({ remoteEmpty: false, role: 'owner', linkedLocalWorkspaceId: null })
    await c.api.linkRemoteWorkspace({ remoteWorkspaceId: p.remoteId, localWorkspaceId: c.workspace.id })
    await settle(c, c.workspace.id)
    await converge(p)

    expect((await c.api.listCollections(c.workspace.id)).map((x) => x.name).sort()).toEqual(['Shared', 'Shared'])
    const envs = await c.api.listEnvironments(c.workspace.id)
    expect(envs.map((e) => e.name)).toEqual(['Prod'])
    const vars = await c.api.listEnvironmentVariables(envs[0]!.id)
    expect(vars.map((v) => `${v.key}=${v.value}`).sort()).toEqual(['host=remote.example.com', 'only_local=1', 'token=null'])
    // the local secret value moved onto the remote variable: usable on this device, never uploaded
    const token = vars.find((v) => v.key === 'token')!
    expect(token.secretMissing).toBe(false)
    expect(await c.api.revealEnvironmentVariable(token.id)).toBe('local-secret-c')
    expect(JSON.stringify(cloud.requests)).not.toContain('local-secret-c')
    expect(cloud.live(p.remoteId, 'environment')).toHaveLength(1)
    // everything converged for everyone (A, B and C)
    await c.core.sync.syncNow(c.workspace.id)
    await converge(p)
    const cState = liveState(c, c.workspace.id)
    expect(cState).toEqual(liveState(p.a, p.wsA))
    expect(cState).toEqual(liveState(p.b, p.wsB))
  })

  it('preview reports what the remote workspace holds', async () => {
    const p = await makePair(cloud, async (a, ws) => {
      const c = await col(a, ws, 'Shared')
      const f = await a.api.createFolder({ workspaceId: ws, collectionId: c.id, name: 'F' })
      await req(a, ws, c.id, 'R1', f.id)
      await req(a, ws, c.id, 'R2')
      await a.api.createEnvironment(ws, 'E')
    })
    const viewer = cloud.createUser('v@x.com')
    cloud.setRole(p.remoteId, viewer.id, 'viewer')
    const v = dev(viewer.id)
    expect(await v.api.previewRemoteWorkspace(p.remoteId)).toMatchObject({
      remoteEmpty: false, role: 'viewer', counts: { collections: 1, folders: 1, requests: 2, environments: 1, truncated: false },
    })
    const empty = cloud.createWorkspace('Empty', p.userId)
    expect(await p.a.api.previewRemoteWorkspace(empty.id)).toMatchObject({ remoteEmpty: true, counts: { collections: 0, requests: 0 } })
  })

  it('refuses unsafe links with sync_blocked', async () => {
    const p = await makePair(cloud, async (a, ws) => void (await col(a, ws)))
    await expect(p.b.api.linkRemoteWorkspace({ remoteWorkspaceId: p.remoteId, localWorkspaceId: p.wsB })).rejects.toMatchObject({ code: 'sync_blocked' }) // already linked
    await expect(p.a.api.publishWorkspace(p.wsA)).rejects.toMatchObject({ code: 'sync_blocked' })
    const other = dev(p.userId)
    await other.api.linkRemoteWorkspace({ remoteWorkspaceId: p.remoteId, localWorkspaceId: null })
    const second = await other.api.createWorkspace('Second')
    await expect(other.api.linkRemoteWorkspace({ remoteWorkspaceId: p.remoteId, localWorkspaceId: second.id })).rejects.toMatchObject({ code: 'sync_blocked' }) // remote already linked here
    // viewer + local content: must download into a new workspace instead
    const viewer = cloud.createUser('v@x.com')
    cloud.setRole(p.remoteId, viewer.id, 'viewer')
    const v = dev(viewer.id)
    await col(v, v.workspace.id, 'mine')
    await expect(v.api.linkRemoteWorkspace({ remoteWorkspaceId: p.remoteId, localWorkspaceId: v.workspace.id })).rejects.toMatchObject({ code: 'sync_blocked' })
    const dl = await v.api.linkRemoteWorkspace({ remoteWorkspaceId: p.remoteId, localWorkspaceId: null })
    const st = await settle(v, dl.workspace.id)
    expect(st.readOnly).toBe(true)
    expect(st.role).toBe('viewer')
    await expect(v.api.createCollection(dl.workspace.id, 'x')).rejects.toBeTruthy()
    expect(await v.api.listCollections(dl.workspace.id)).toHaveLength(1)
  })

  it('an interrupted initial download resumes from its cursor', async () => {
    const user = cloud.createUser('a@x.com')
    const w = cloud.createWorkspace('Big', user.id)
    const c = 'c0000000-0000-4000-8000-000000000001'
    cloud.restUpsert(w.id, 'collection', c, { name: 'Col' })
    for (let i = 0; i < 450; i++) cloud.restUpsert(w.id, 'request', `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { collection_id: c, folder_id: null, name: `R${i}`, method: 'GET', url: 'u', document_json: DOC, sort_order: i })
    const d = dev(user.id)
    cloud.faults.push({ match: /GET .*sync\/snapshot$/, action: 'status', status: 500, skip: 1 }) // page 1 ok, page 2 fails
    const link = await d.api.linkRemoteWorkspace({ remoteWorkspaceId: w.id, localWorkspaceId: null })
    const s1 = await d.core.sync.syncNow(link.workspace.id)
    expect(s1.state).toBe('error')
    expect(s1.initialSyncPending).toBe(true)
    const cursor = rt(d, link.workspace.id).snapshot_cursor as string
    expect(cursor).toBeTruthy() // page 1 was applied and remembered
    expect((await d.api.listRequests(c)).length).toBeGreaterThan(0)
    cloud.clearRecorded()
    const s = await d.core.sync.syncNow(link.workspace.id)
    expect(s.state).toBe('idle')
    expect(s.initialSyncPending).toBe(false)
    expect(cloud.requestsTo(/sync\/snapshot$/)[0]!.query.get('cursor')).toBe(cursor) // resumed, not restarted
    expect((await d.api.listRequests(c)).length).toBe(450)
  })

  it('unlink removes bookkeeping only: content and remote data stay', async () => {
    const { d, ws, remoteId } = await published({ seed: async (d, ws) => void (await col(d, ws)) })
    await d.api.unlinkWorkspace(ws)
    expect((await d.api.getSyncStatus(ws)).linked).toBe(false)
    for (const t of ['sync_entities', 'sync_dirty', 'sync_conflicts', 'sync_sent_ops', 'cloud_links']) {
      expect(d.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 })
    }
    expect(await d.api.listCollections(ws)).toHaveLength(1)
    expect(cloud.live(remoteId, 'collection')).toHaveLength(1)
    await d.api.createCollection(ws, 'after unlink') // no dirty capture, no read-only
    expect(pendingCount(d, ws)).toBe(0)
  })

  it('republishing content whose ids already exist remotely is quarantined as "id in use" instead of looping', async () => {
    const { d, ws } = await published({ seed: async (d, ws) => void (await col(d, ws, 'Once')) })
    await d.api.unlinkWorkspace(ws)
    await d.api.publishWorkspace(ws)
    const s = await settle(d, ws)
    expect(s.openConflicts).toBe(1)
    expect((await d.api.listSyncConflicts(ws))[0]!.message).toMatch(/already used by another cloud workspace/)
    void s
  })
})

describe('secrets never leave the device', () => {
  it('secret toggles sync metadata only; the other device gets secretMissing and can set its own value', async () => {
    const p = await makePair(cloud, async (a, ws) => {
      const e = await a.api.createEnvironment(ws, 'E')
      await a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'plain', value: 'p1', isSecret: false })
    })
    const e = (await p.a.api.listEnvironments(p.wsA))[0]!
    const v = (await p.a.api.listEnvironmentVariables(e.id))[0]!
    await p.a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'plain', value: 'now-secret-hunter2', isSecret: true, variableId: v.id })
    await converge(p)
    expect(cloud.entity(v.id)!.data).toMatchObject({ is_secret: true, value: null })
    // plaintext -> secret remotely: B already holds the old plaintext, which moves into its keychain
    const held = (await p.b.api.listEnvironmentVariables(e.id)).find((x) => x.id === v.id)!
    expect(held).toMatchObject({ isSecret: true, secretMissing: false, value: null })
    expect(await p.b.api.revealEnvironmentVariable(v.id)).toBe('p1')
    // a variable born secret on A has no value on B
    const born = await p.a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'born', value: 'hunter2-born', isSecret: true })
    await converge(p)
    const onB = (await p.b.api.listEnvironmentVariables(e.id)).find((x) => x.id === born.id)!
    expect(onB).toMatchObject({ isSecret: true, secretMissing: true, value: null })
    await expect(p.b.api.revealEnvironmentVariable(onB.id)).rejects.toMatchObject({ code: 'not_found' })
    const setB = await p.b.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'born', value: 'b-own-secret', isSecret: true, variableId: onB.id })
    expect(setB.secretMissing).toBe(false)
    await converge(p)
    expect(pendingCount(p.b, p.wsB)).toBe(0)
    expect(JSON.stringify(cloud.requests)).not.toContain('hunter2')
    expect(JSON.stringify(cloud.requests)).not.toContain('b-own-secret')
    // secret -> plaintext takes the value from the payload
    await p.a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'plain', value: 'plain-again', isSecret: false, variableId: v.id })
    await converge(p)
    expect((await p.b.api.listEnvironmentVariables(e.id)).find((x) => x.id === v.id)).toMatchObject({ isSecret: false, value: 'plain-again' })
    expect(p.b.secrets.get(`slinger:env-var:${v.id}`)).toBeNull() // keychain entry purged
  })
})

describe('clock', () => {
  it('uses the injected clock for lastSyncedAt', async () => {
    const clock = new FakeClock(1_900_000_000_000)
    const user = cloud.createUser('a@x.com')
    const d = dev(user.id, { clock })
    await d.api.publishWorkspace(d.workspace.id)
    const s = await settle(d, d.workspace.id)
    expect(s.lastSyncedAt).toBe(1_900_000_000)
  })
})
