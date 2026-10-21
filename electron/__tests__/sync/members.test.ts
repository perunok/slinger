import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SyncStatus } from '../../../shared/types'
import { SyncEngine, MEMBER_CHECK_INTERVAL_MS } from '../../sync/engine'
import type { CloudGateway } from '../../cloud/api'
import { FakeCloud } from './fakeCloud'
import { makeDevice, settle, type Device } from './harness'

let cloud: FakeCloud
const devices: Device[] = []
beforeEach(async () => {
  cloud = await new FakeCloud().start()
})
afterEach(async () => {
  for (const d of devices.splice(0)) d.cleanup()
  await cloud.stop()
})

const membersRequests = () => cloud.requestsTo(/\/members$/)

/** A signed-in device whose workspace is published; returns the cloud workspace id as well. */
async function published(name = 'ana@example.com'): Promise<{ dev: Device; ws: string; remoteId: string; userId: string }> {
  const user = cloud.createUser(name, 'Ana Silva')
  const dev = makeDevice(cloud, { userId: user.id })
  devices.push(dev)
  await dev.api.publishWorkspace(dev.workspace.id)
  const st = await settle(dev, dev.workspace.id)
  return { dev, ws: dev.workspace.id, remoteId: st.remoteWorkspaceId!, userId: user.id }
}

describe('team: member count in the sync status', () => {
  it('is unknown while not linked and 1 right after publishing', async () => {
    const user = cloud.createUser('ana@example.com')
    const dev = makeDevice(cloud, { userId: user.id })
    devices.push(dev)
    expect((await dev.api.getSyncStatus(dev.workspace.id)).members).toBeNull()
    await dev.api.publishWorkspace(dev.workspace.id)
    const st = await settle(dev, dev.workspace.id)
    expect(st.members).toBe(1)
  })

  it('counts members the cloud workspace gets later, on a manual sync, and announces the change', async () => {
    const { dev, ws, remoteId } = await published()
    const bob = cloud.createUser('bob@example.com', 'Bob')
    cloud.setRole(remoteId, bob.id, 'editor')
    dev.events.length = 0
    const st = await dev.api.syncNow(ws)
    expect(st.members).toBe(2)
    expect(dev.statusEvents().some((s) => s.members === 2)).toBe(true)
    cloud.setRole(remoteId, bob.id, null)
    expect((await dev.api.syncNow(ws)).members).toBe(1)
  })

  it('reads the members at most once a minute for automatic cycles, but every time for a manual sync', async () => {
    const { dev, ws, remoteId } = await published()
    const bob = cloud.createUser('bob@example.com', 'Bob')
    cloud.setRole(remoteId, bob.id, 'viewer')
    cloud.clearRecorded()
    dev.clock.advance(1_000)
    expect((await dev.core.sync.engine.runCycle(ws)).members).toBe(1) // auto cycle inside the window: not asked
    expect(membersRequests()).toHaveLength(0)
    dev.clock.advance(MEMBER_CHECK_INTERVAL_MS)
    expect((await dev.core.sync.engine.runCycle(ws)).members).toBe(2) // window over
    expect(membersRequests()).toHaveLength(1)
    dev.clock.advance(1_000)
    await dev.core.sync.engine.runCycle(ws)
    expect(membersRequests()).toHaveLength(1)
    await dev.api.syncNow(ws) // forced
    expect(membersRequests()).toHaveLength(2)
  })

  it('keeps the old count when the fetch fails and the cycle still succeeds', async () => {
    const { dev, ws, remoteId } = await published()
    const bob = cloud.createUser('bob@example.com', 'Bob')
    cloud.setRole(remoteId, bob.id, 'editor')
    expect((await dev.api.syncNow(ws)).members).toBe(2)
    cloud.setRole(remoteId, bob.id, null)
    cloud.faults.push({ match: /GET .*\/members$/, action: 'status', status: 503 })
    const st = await dev.api.syncNow(ws)
    expect(st.members).toBe(2) // not reset to null, not updated
    expect(st.lastError).toBeNull()
    expect(st.state).toBe('idle')
    expect((await dev.api.syncNow(ws)).members).toBe(1) // next try works
  })

  it('persists the count (a fresh engine over the same database reports it before any cycle)', async () => {
    const { dev, ws, remoteId } = await published()
    cloud.setRole(remoteId, cloud.createUser('bob@example.com').id, 'editor')
    await dev.api.syncNow(ws)
    expect(dev.db.prepare('SELECT member_count AS n FROM cloud_links WHERE workspace_id = ?').get(ws)).toEqual({ n: 2 })
    const fresh = new SyncEngine({ db: dev.db, secrets: dev.secrets, cloud: {} as CloudGateway, auth: dev.core.sync.auth, clock: dev.clock, emit: () => {}, appVersion: 'x' })
    expect(fresh.status(ws).members).toBe(2)
  })

  it('counts every page of a big workspace', async () => {
    const { dev, ws, remoteId } = await published()
    for (let i = 0; i < 129; i++) cloud.setRole(remoteId, cloud.createUser(`u${i}@example.com`).id, 'viewer')
    cloud.clearRecorded()
    expect((await dev.api.syncNow(ws)).members).toBe(130)
    expect(membersRequests()).toHaveLength(2)
  })

  it('drops the count with the link', async () => {
    const { dev, ws } = await published()
    await dev.api.unlinkWorkspace(ws)
    expect((await dev.api.getSyncStatus(ws)).members).toBeNull()
  })
})

describe('team: listWorkspaceMembers', () => {
  it('lists the active members with their role, join time and who you are, and refreshes the count', async () => {
    const { dev, ws, remoteId, userId } = await published()
    const bob = cloud.createUser('bob@example.com', 'Bob Stone')
    cloud.setRole(remoteId, bob.id, 'editor')
    dev.events.length = 0
    const list = await dev.api.listWorkspaceMembers(ws)
    expect(list).toHaveLength(2)
    const me = list.find((m) => m.userId === userId)!
    expect(me).toMatchObject({ email: 'ana@example.com', displayName: 'Ana Silva', role: 'owner', isYou: true })
    expect(list.find((m) => m.userId === bob.id)).toMatchObject({ email: 'bob@example.com', displayName: 'Bob Stone', role: 'editor', isYou: false })
    expect(me.joinedAt).toBeGreaterThan(1_700_000_000)
    expect(me.id).toBeTruthy()
    const events: SyncStatus[] = dev.statusEvents()
    expect(events.at(-1)!.members).toBe(2)
    expect((await dev.api.getSyncStatus(ws)).members).toBe(2)
  })

  it('always asks the cloud (forced, not throttled)', async () => {
    const { dev, ws } = await published()
    cloud.clearRecorded()
    await dev.api.listWorkspaceMembers(ws)
    await dev.api.listWorkspaceMembers(ws)
    expect(membersRequests()).toHaveLength(2)
  })

  it('is sync_blocked for a workspace that is not linked', async () => {
    const user = cloud.createUser('ana@example.com')
    const dev = makeDevice(cloud, { userId: user.id })
    devices.push(dev)
    await expect(dev.api.listWorkspaceMembers(dev.workspace.id)).rejects.toMatchObject({ code: 'sync_blocked' })
  })

  it('maps network errors like the other cloud calls and leaves the count alone', async () => {
    const { dev, ws } = await published()
    cloud.faults.push({ match: /GET .*\/members$/, action: 'status', status: 503, times: 3 })
    await expect(dev.api.listWorkspaceMembers(ws)).rejects.toMatchObject({ code: 'network_error' })
    expect((await dev.api.getSyncStatus(ws)).members).toBe(1)
  })

  it('validates its argument', async () => {
    const { dev } = await published()
    await expect(dev.api.listWorkspaceMembers('not-a-uuid')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('maps a lost membership to an error', async () => {
    const { dev, ws, remoteId, userId } = await published()
    cloud.setRole(remoteId, userId, null)
    await expect(dev.api.listWorkspaceMembers(ws)).rejects.toMatchObject({ code: 'sync_blocked' })
  })

  it('requires being signed in', async () => {
    const { dev, ws } = await published()
    await dev.api.signOutCloud()
    await expect(dev.api.listWorkspaceMembers(ws)).rejects.toMatchObject({ code: 'unauthenticated' })
  })
})
