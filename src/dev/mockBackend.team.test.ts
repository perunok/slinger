import { beforeEach, describe, expect, it } from 'vitest'
import type { SyncEvent } from '../../shared/types'
import { createMockBackend } from './mockBackend'

type Backend = ReturnType<typeof createMockBackend>
let b: Backend
let events: SyncEvent[]

const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: { code: string; message: string }) => e)
const statuses = () => events.filter((e): e is Extract<SyncEvent, { type: 'status' }> => e.type === 'status').map((e) => e.status)

async function signIn() {
  await b.startCloudSignIn()
  b.cloud.approveSignIn()
}
async function publishPersonal() {
  const ws = (await b.listWorkspaces()).find((w) => w.name === 'Personal')!
  await signIn()
  await b.publishWorkspace(ws.id)
  await b.cloud.runCycle(ws.id)
  return { ws, remoteId: (await b.getSyncStatus(ws.id)).remoteWorkspaceId! }
}

beforeEach(() => {
  b = createMockBackend({ latencyMs: 0 })
  events = []
  b.onSyncEvent((e) => events.push(e))
})

describe('mock team: members', () => {
  it('is null while not linked and 1 after publishing', async () => {
    const ws = (await b.listWorkspaces()).find((w) => w.name === 'Personal')!
    expect((await b.getSyncStatus(ws.id)).members).toBeNull()
    await publishPersonal()
    expect((await b.getSyncStatus(ws.id)).members).toBe(1)
  })

  it('a downloaded shared workspace has its owner and you', async () => {
    await signIn()
    const payments = (await b.listRemoteWorkspaces()).find((r) => r.name === 'Payments API')!
    const { workspace } = await b.linkRemoteWorkspace({ remoteWorkspaceId: payments.id, localWorkspaceId: null })
    await b.cloud.runCycle(workspace.id)
    expect((await b.getSyncStatus(workspace.id)).members).toBe(2)
    const list = await b.listWorkspaceMembers(workspace.id)
    expect(list.map((m) => [m.displayName, m.role, m.isYou])).toEqual([
      ['Sam Lee', 'owner', false],
      ['Ana Silva', 'editor', true],
    ])
    expect(list.every((m) => m.joinedAt > 0 && m.email.includes('@') && m.id && m.userId)).toBe(true)
  })

  it('setMembers changes the count of a linked workspace and pushes a status event', async () => {
    const { ws, remoteId } = await publishPersonal()
    events.length = 0
    b.cloud.setMembers(remoteId, [
      { name: 'Ana Silva', email: 'ana@example.com', role: 'owner' },
      { name: 'Bo Tran', email: 'bo@example.com', role: 'viewer' },
      { name: 'Cy Ford', email: 'cy@example.com', role: 'admin' },
    ])
    expect(statuses().at(-1)).toMatchObject({ workspaceId: ws.id, members: 3 })
    expect((await b.getSyncStatus(ws.id)).members).toBe(3)
    const list = await b.listWorkspaceMembers(ws.id)
    expect(list).toHaveLength(3)
    expect(list.find((m) => m.isYou)).toMatchObject({ displayName: 'Ana Silva', role: 'owner' })
    // A later cycle reports the same count, like main.
    await b.cloud.runCycle(ws.id)
    expect((await b.getSyncStatus(ws.id)).members).toBe(3)
  })

  it('keeps the join date of people who stay', async () => {
    const { ws, remoteId } = await publishPersonal()
    const before = (await b.listWorkspaceMembers(ws.id))[0]!
    b.cloud.setMembers(remoteId, [{ name: 'Ana Silva', email: 'ana@example.com', role: 'owner' }, { name: 'Bo', email: 'bo@example.com', role: 'editor' }])
    const after = await b.listWorkspaceMembers(ws.id)
    expect(after.find((m) => m.isYou)).toMatchObject({ id: before.id, joinedAt: before.joinedAt })
  })

  it('fails like the other cloud calls: not linked, signed out, offline', async () => {
    const ws = (await b.listWorkspaces()).find((w) => w.name === 'Personal')!
    expect((await rejection(b.listWorkspaceMembers(ws.id)))?.code).toBe('sync_blocked')
    await publishPersonal()
    b.cloud.setOffline(true)
    expect((await rejection(b.listWorkspaceMembers(ws.id)))?.code).toBe('network_error')
    b.cloud.setOffline(false)
    b.cloud.expireAuth()
    expect((await rejection(b.listWorkspaceMembers(ws.id)))?.code).toBe('unauthenticated')
  })

  it('lists nothing once access is revoked', async () => {
    await signIn()
    const docs = (await b.listRemoteWorkspaces()).find((r) => r.name === 'Shared Docs')!
    const { workspace } = await b.linkRemoteWorkspace({ remoteWorkspaceId: docs.id, localWorkspaceId: null })
    b.cloud.revokeAccess(docs.id)
    expect((await rejection(b.listWorkspaceMembers(workspace.id)))?.code).toBe('sync_blocked')
  })

  it('unlinking drops the count', async () => {
    const { ws } = await publishPersonal()
    await b.unlinkWorkspace(ws.id)
    expect((await b.getSyncStatus(ws.id)).members).toBeNull()
  })
})
