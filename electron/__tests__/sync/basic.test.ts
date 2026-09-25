import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCloud } from './fakeCloud'
import { DOC, liveState, makeDevice, pendingCount, settle, type Device } from './harness'

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
const mk = (userId: string) => {
  const d = makeDevice(cloud, { userId })
  devices.push(d)
  return d
}

describe('publish and pull', () => {
  it('uploads a workspace and a second device links and downloads it', async () => {
    const user = cloud.createUser('ana@example.com')
    const a = mk(user.id)
    const col = await a.api.createCollection(a.workspace.id, 'Payments')
    const folder = await a.api.createFolder({ workspaceId: a.workspace.id, collectionId: col.id, name: 'Auth' })
    const req = await a.api.createRequest({ workspaceId: a.workspace.id, collectionId: col.id, folderId: folder.id, name: 'Login', method: 'POST', url: 'https://x/login', documentJson: DOC })
    const env = await a.api.createEnvironment(a.workspace.id, 'Prod')
    await a.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'host', value: 'api.example.com', isSecret: false })
    await a.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'token', value: 'hunter2-secret', isSecret: true })

    const status = await a.api.publishWorkspace(a.workspace.id)
    expect(status.linked).toBe(true)
    const done = await settle(a, a.workspace.id)
    expect(done.state).toBe('idle')
    expect(done.pendingChanges).toBe(0)
    expect(done.initialSyncPending).toBe(false)

    const remote = cloud.live(done.remoteWorkspaceId!)
    expect(remote.map((e) => e.type).sort()).toEqual(['collection', 'environment', 'environment_variable', 'environment_variable', 'folder', 'request'])
    // The secret value never reaches the server (bodies included).
    expect(JSON.stringify(cloud.requests)).not.toContain('hunter2-secret')

    const b = mk(user.id)
    const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: done.remoteWorkspaceId!, localWorkspaceId: null })
    await settle(b, link.workspace.id)
    const bState = liveState(b, link.workspace.id)
    expect(bState.filter((s) => s.type === 'request').map((s) => s.id)).toEqual([req.id])
    const vars = bState.filter((s) => s.type === 'environment_variable')
    expect(vars).toHaveLength(2)
    const tokenVar = (await b.api.listEnvironmentVariables(env.id)).find((v) => v.key === 'token')!
    expect(tokenVar.secretMissing).toBe(true)
    expect(liveState(a, a.workspace.id)).toEqual(liveState(b, link.workspace.id))
  })
})
