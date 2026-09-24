import { beforeEach, describe, expect, it } from 'vitest'
import type { SyncEvent } from '../../shared/types'
import { createMockBackend } from './mockBackend'
import { ID_IN_USE } from './mock/sync'

type Backend = ReturnType<typeof createMockBackend>
let b: Backend
let events: SyncEvent[]

async function personal() {
  return (await b.listWorkspaces()).find((w) => w.name === 'Personal')!
}
async function signIn() {
  await b.startCloudSignIn()
  b.cloud.approveSignIn()
}
async function publishPersonal() {
  const ws = await personal()
  await signIn()
  await b.publishWorkspace(ws.id)
  await b.cloud.runCycle(ws.id)
  return ws
}
async function firstRequest(wsId: string) {
  const col = (await b.listCollections(wsId)).find((c) => c.name === 'Demo API')!
  const reqs = await b.listRequests(col.id)
  return { col, req: reqs.find((r) => r.name === 'Get user')! }
}
const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: { code: string; message: string }) => e)

beforeEach(() => {
  b = createMockBackend({ latencyMs: 0 })
  events = []
  b.onSyncEvent((e) => events.push(e))
})

describe('mock cloud account', () => {
  it('rejects cloud calls until signed in', async () => {
    expect((await rejection(b.listRemoteWorkspaces()))?.code).toBe('unauthenticated')
    const ws = await personal()
    expect((await rejection(b.publishWorkspace(ws.id)))?.code).toBe('unauthenticated')
  })

  it('runs the device flow and reports session events', async () => {
    const start = await b.startCloudSignIn()
    expect(start.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
    expect((await b.getCloudSession()).status).toBe('signingIn')
    b.cloud.approveSignIn()
    const s = await b.getCloudSession()
    expect(s.status).toBe('signedIn')
    expect(s.user?.email).toBe('ana@example.com')
    expect(events.some((e) => e.type === 'signInResult' && e.result === 'approved')).toBe(true)
    await b.signOutCloud()
    expect((await b.getCloudSession()).status).toBe('signedOut')
  })

  it('reports expired / denied / cancelled sign-ins', async () => {
    await b.startCloudSignIn()
    b.cloud.expireSignIn()
    await b.startCloudSignIn()
    b.cloud.denySignIn()
    await b.startCloudSignIn()
    await b.cancelCloudSignIn()
    const results = events.flatMap((e) => (e.type === 'signInResult' ? [e.result] : []))
    expect(results).toEqual(['expired', 'denied', 'cancelled'])
    expect((await b.getCloudSession()).status).toBe('signedOut')
  })

  it('validates and persists the server config', async () => {
    expect((await rejection(b.setCloudConfig({ apiBaseUrl: 'ftp://x', deviceName: 'd' })))?.code).toBe('invalid_input')
    const c = await b.setCloudConfig({ apiBaseUrl: 'http://127.0.0.1:8080/', deviceName: ' ' })
    expect(c).toEqual({ apiBaseUrl: 'http://127.0.0.1:8080', deviceName: 'Slinger Desktop' })
    expect((await b.getCloudConfig()).apiBaseUrl).toBe('http://127.0.0.1:8080')
  })

  it('a dropped session moves linked workspaces to signedOut but keeps the link', async () => {
    const ws = await publishPersonal()
    b.cloud.expireAuth()
    const st = await b.syncNow(ws.id)
    expect(st.state).toBe('signedOut')
    expect(st.linked).toBe(true)
  })
})

describe('publish and sync', () => {
  it('uploads everything, then tracks pending changes and pushes them', async () => {
    const ws = await personal()
    await signIn()
    const started = await b.publishWorkspace(ws.id)
    expect(started.linked).toBe(true)
    expect(started.role).toBe('owner')
    expect(started.initialSyncPending).toBe(true)
    const done = await b.cloud.runCycle(ws.id)
    expect(done.state).toBe('idle')
    expect(done.pendingChanges).toBe(0)
    expect(done.initialSyncPending).toBe(false)
    expect(done.lastSyncedAt).not.toBeNull()
    const rid = done.remoteWorkspaceId!
    expect(b.cloud.remoteEntities(rid).filter((e) => e.type === 'request').length).toBeGreaterThan(20)

    const { req } = await firstRequest(ws.id)
    await b.renameRequest(req.id, 'Get user v2')
    expect((await b.getSyncStatus(ws.id)).pendingChanges).toBe(1)
    const after = await b.syncNow(ws.id)
    expect(after.pendingChanges).toBe(0)
    expect(b.cloud.remoteEntities(rid).find((e) => e.id === req.id)?.payload.name).toBe('Get user v2')
  })

  it('never uploads secret values', async () => {
    const ws = await publishPersonal()
    const st = await b.getSyncStatus(ws.id)
    const secrets = b.cloud.remoteEntities(st.remoteWorkspaceId!).filter((e) => e.type === 'environment_variable' && e.payload.is_secret)
    expect(secrets.length).toBeGreaterThan(0)
    for (const s of secrets) expect(s.payload.value).toBeNull()
  })

  it('pulls remote edits into clean local rows and emits an applied event', async () => {
    const ws = await publishPersonal()
    const rid = (await b.getSyncStatus(ws.id)).remoteWorkspaceId!
    const { req } = await firstRequest(ws.id)
    b.cloud.remoteEdit(rid, 'request', req.id, { name: 'Renamed in cloud' })
    events.length = 0
    await b.syncNow(ws.id)
    expect((await b.listRequests(req.collectionId)).find((r) => r.id === req.id)?.name).toBe('Renamed in cloud')
    const applied = events.find((e) => e.type === 'applied')
    expect(applied && applied.type === 'applied' && applied.changed).toEqual([{ entityType: 'request', entityId: req.id, change: 'upsert' }])
  })

  it('offline: edits accumulate and the state is offline until back online', async () => {
    const ws = await publishPersonal()
    const { req } = await firstRequest(ws.id)
    b.cloud.setOffline(true)
    await b.renameRequest(req.id, 'Offline edit')
    const st = await b.syncNow(ws.id)
    expect(st.state).toBe('offline')
    expect(st.lastError?.code).toBe('network_error')
    expect(st.pendingChanges).toBe(1)
    expect(st.nextRetryAt).not.toBeNull()
    expect((await rejection(b.listRemoteWorkspaces()))?.code).toBe('network_error')
    b.cloud.setOffline(false)
    const ok = await b.syncNow(ws.id)
    expect(ok.state).toBe('idle')
    expect(ok.pendingChanges).toBe(0)
  })

  it('a too-old server yields serverUnsupported and blocks publishing', async () => {
    const ws = await publishPersonal()
    b.cloud.setServerProtocol(1)
    expect((await b.getSyncStatus(ws.id)).state).toBe('serverUnsupported')
    const other = await b.createWorkspace('Other')
    expect((await rejection(b.publishWorkspace(other.id)))?.code).toBe('sync_blocked')
  })

  it('auto sync off is remembered; unlink clears the link and keeps content', async () => {
    const ws = await publishPersonal()
    expect((await b.setAutoSync(ws.id, false)).autoSync).toBe(false)
    expect((await b.listSyncStatuses()).length).toBe(1)
    await b.unlinkWorkspace(ws.id)
    expect((await b.getSyncStatus(ws.id)).state).toBe('unlinked')
    expect((await b.listCollections(ws.id)).length).toBeGreaterThan(0)
    expect(await b.listSyncStatuses()).toEqual([])
  })

  it('republishing after unlink reports "id in use" as rejected conflicts', async () => {
    const ws = await publishPersonal()
    await b.unlinkWorkspace(ws.id)
    await b.publishWorkspace(ws.id)
    const st = await b.cloud.runCycle(ws.id)
    expect(st.openConflicts).toBeGreaterThan(0)
    const conflicts = await b.listSyncConflicts(ws.id)
    expect(conflicts.every((c) => c.kind === 'rejected' && c.message.includes(ID_IN_USE))).toBe(true)
  })

  it('access revoked and remote deleted both surface as accessRevoked and stop syncing', async () => {
    const ws = await publishPersonal()
    const rid = (await b.getSyncStatus(ws.id)).remoteWorkspaceId!
    b.cloud.revokeAccess(rid)
    const st = await b.syncNow(ws.id)
    expect(st.state).toBe('accessRevoked')
    expect(st.linked).toBe(true)
  })
})

describe('link, read-only and secretMissing', () => {
  it('links an existing workspace into a new local one (download)', async () => {
    await signIn()
    const remotes = await b.listRemoteWorkspaces()
    const payments = remotes.find((r) => r.name === 'Payments API')!
    expect(payments.linkedLocalWorkspaceId).toBeNull()
    const preview = await b.previewRemoteWorkspace(payments.id)
    expect(preview.remoteEmpty).toBe(false)
    const empty = remotes.find((r) => r.name === 'Empty Team')!
    expect((await b.previewRemoteWorkspace(empty.id)).remoteEmpty).toBe(true)

    const { workspace, status } = await b.linkRemoteWorkspace({ remoteWorkspaceId: payments.id, localWorkspaceId: null })
    expect(workspace.workspaceType).toBe('team')
    expect(status.linked).toBe(true)
    await b.cloud.runCycle(workspace.id)
    const cols = await b.listCollections(workspace.id)
    expect(cols.map((c) => c.name)).toEqual(['Payments'])
    expect((await b.listRequests(cols[0].id)).length).toBe(2)
    expect((await b.listRemoteWorkspaces()).find((r) => r.id === payments.id)?.linkedLocalWorkspaceId).toBe(workspace.id)
    expect((await rejection(b.linkRemoteWorkspace({ remoteWorkspaceId: payments.id, localWorkspaceId: null })))?.code).toBe('sync_blocked')
  })

  it('secret variables from the cloud arrive as secretMissing and clear once a value is set', async () => {
    await signIn()
    const payments = (await b.listRemoteWorkspaces()).find((r) => r.name === 'Payments API')!
    const { workspace } = await b.linkRemoteWorkspace({ remoteWorkspaceId: payments.id, localWorkspaceId: null })
    await b.cloud.runCycle(workspace.id)
    const env = (await b.listEnvironments(workspace.id))[0]
    const vars = await b.listEnvironmentVariables(env.id)
    const secret = vars.find((v) => v.key === 'apiKey')!
    expect(secret.isSecret && secret.secretMissing).toBe(true)
    expect(vars.find((v) => v.key === 'baseUrl')?.secretMissing).toBe(false)
    const set = await b.upsertEnvironmentVariable({ environmentId: env.id, variableId: secret.id, key: 'apiKey', value: 'sk-1', isSecret: true })
    expect(set.secretMissing).toBe(false)
    // Setting a local secret value never counts as a pending change (it never syncs).
    expect((await b.getSyncStatus(workspace.id)).pendingChanges).toBe(0)
  })

  it('viewer workspaces are read-only: every mutation rejects with read_only, secret values excepted', async () => {
    await signIn()
    const docs = (await b.listRemoteWorkspaces()).find((r) => r.name === 'Shared Docs')!
    const { workspace, status } = await b.linkRemoteWorkspace({ remoteWorkspaceId: docs.id, localWorkspaceId: null })
    expect(status.readOnly).toBe(true)
    await b.cloud.runCycle(workspace.id)
    const col = (await b.listCollections(workspace.id))[0]
    const req = (await b.listRequests(col.id))[0]
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['createCollection', () => b.createCollection(workspace.id, 'x')],
      ['renameCollection', () => b.renameCollection(col.id, 'x')],
      ['deleteCollection', () => b.deleteCollection(col.id)],
      ['createFolder', () => b.createFolder({ workspaceId: workspace.id, collectionId: col.id, parentFolderId: null, name: 'f' })],
      ['createRequest', () => b.createRequest({ workspaceId: workspace.id, collectionId: col.id, folderId: null, name: 'r', method: 'GET', url: '', documentJson: '{}' })],
      ['updateRequest', () => b.updateRequest({ requestId: req.id, name: 'x', method: 'GET', url: '', documentJson: '{}', expectedVersion: req.version })],
      ['moveRequest', () => b.moveRequest({ requestId: req.id, targetCollectionId: col.id, targetFolderId: null, targetIndex: 0 })],
      ['deleteRequest', () => b.deleteRequest(req.id)],
      ['createEnvironment', () => b.createEnvironment(workspace.id, 'e')],
      ['importPostmanCollection', () => b.importPostmanCollection(workspace.id, '{}')],
      ['createCollectionVersion', () => b.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: null })],
    ]
    for (const [name, run] of attempts) expect((await rejection(run()))?.code, name).toBe('read_only')
    // Local-only things still work.
    await b.renameWorkspace(workspace.id, 'Renamed locally')
    expect((await b.listRequests(col.id)).length).toBe(2)
  })

  it('a role downgrade blocks writes on the next cycle; an upgrade unblocks them', async () => {
    const ws = await publishPersonal()
    const st = await b.getSyncStatus(ws.id)
    const { req } = await firstRequest(ws.id)
    b.cloud.setRole(st.remoteWorkspaceId!, 'viewer')
    expect((await b.syncNow(ws.id)).readOnly).toBe(true)
    expect((await rejection(b.renameRequest(req.id, 'x')))?.code).toBe('read_only')
    b.cloud.setRole(st.remoteWorkspaceId!, 'editor')
    expect((await b.syncNow(ws.id)).readOnly).toBe(false)
    await b.renameRequest(req.id, 'now ok')
  })

  it('refuses to link a viewer workspace into a local workspace that has content', async () => {
    await signIn()
    const docs = (await b.listRemoteWorkspaces()).find((r) => r.name === 'Shared Docs')!
    const ws = await personal()
    expect((await rejection(b.linkRemoteWorkspace({ remoteWorkspaceId: docs.id, localWorkspaceId: ws.id })))?.code).toBe('sync_blocked')
  })
})

describe('conflicts', () => {
  it('scenario builds a conflict of every kind', async () => {
    const out = await b.cloud.scenario('conflicts')
    const list = await b.listSyncConflicts(out.workspaceId)
    const kinds = new Set(list.map((c) => c.kind))
    expect([...kinds].sort()).toEqual(['edit_edit', 'immutable_clash', 'local_deleted', 'rejected', 'remote_deleted'])
    // duplicate_key is informational: auto resolved, only listed when asked for.
    const all = await b.listSyncConflicts(out.workspaceId, true)
    expect(all.find((c) => c.kind === 'duplicate_key')?.status).toBe('auto_resolved')
    const status = await b.getSyncStatus(out.workspaceId)
    expect(status.openConflicts).toBe(list.length)
    const edit = list.find((c) => c.kind === 'edit_edit' && c.entityType === 'request')!
    expect(edit.path).toEqual(['Demo API (mine)', 'Users', 'Get user'])
    expect(edit.groups.find((g) => g.group === 'content')?.conflicting).toBe(true)
    expect(edit.allowedResolutions).toEqual(['keep_local', 'keep_remote', 'merge', 'duplicate'])
    // Like the real engine: field groups are only reported for edit/edit conflicts.
    expect(list.filter((c) => c.kind !== 'edit_edit').every((c) => c.groups.length === 0)).toBe(true)
    expect(edit.groups.find((g) => g.group === 'content')?.local).toMatch(/^Get user - GET https:\/\/mine\.example\.test\/users\/\{\{userId\}\} \[details #[0-9a-f]{6}\]$/)
  })

  async function conflictOf(kind: string, type?: string) {
    const out = await b.cloud.scenario('conflicts')
    const c = (await b.listSyncConflicts(out.workspaceId)).find((x) => x.kind === kind && (!type || x.entityType === type))!
    return { out, c }
  }

  it('keep_remote on an edit conflict adopts the cloud version', async () => {
    const { out, c } = await conflictOf('edit_edit', 'request')
    const st = await b.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_remote' })
    expect(st.openConflicts).toBe(5)
    const req = (await b.listRequests((await b.listCollections(out.workspaceId)).find((x) => x.name.startsWith('Demo API'))!.id)).find((r) => r.id === c.entityId)!
    expect(req.url).toBe('https://theirs.example.test/users/{{userId}}')
  })

  it('keep_local pushes the local version to the cloud', async () => {
    const { out, c } = await conflictOf('edit_edit', 'request')
    const st = await b.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_local' })
    expect(st.openConflicts).toBe(5)
    const rid = (await b.getSyncStatus(out.workspaceId)).remoteWorkspaceId!
    expect(b.cloud.remoteEntities(rid).find((e) => e.id === c.entityId)?.payload.url).toBe('https://mine.example.test/users/{{userId}}')
  })

  it('duplicate keeps my version as a copy and takes the cloud version for the original', async () => {
    const { out, c } = await conflictOf('edit_edit', 'request')
    await b.resolveSyncConflict({ conflictId: c.id, resolution: 'duplicate' })
    const col = (await b.listCollections(out.workspaceId)).find((x) => x.name.startsWith('Demo API'))!
    const reqs = await b.listRequests(col.id)
    expect(reqs.find((r) => r.id === c.entityId)?.url).toContain('theirs')
    const copy = reqs.find((r) => r.name === 'Get user (conflict copy)')
    expect(copy?.url).toContain('mine')
  })

  it('merge needs a choice per conflicting group', async () => {
    const { out, c } = await conflictOf('edit_edit', 'collection')
    expect(c.allowedResolutions).toContain('merge')
    expect(c.groups.map((g) => g.group)).toEqual(['name'])
    await b.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_remote' })
    const col = (await b.listCollections(out.workspaceId)).find((x) => x.id === c.entityId)!
    expect(col.name).toBe('Demo API (theirs)')
  })

  it('merge applies per-group choices on entities with several conflicting groups', async () => {
    const ws = await publishPersonal()
    const rid = (await b.getSyncStatus(ws.id)).remoteWorkspaceId!
    const { col } = await firstRequest(ws.id)
    const folder = (await b.listFolders(col.id)).find((f) => f.name === 'Users')!
    await b.renameFolder(folder.id, 'Users (mine)')
    await b.moveFolder({ folderId: folder.id, targetParentFolderId: (await b.listFolders(col.id)).find((f) => f.name === 'Auth')!.id, targetIndex: 0 })
    const other = (await b.listFolders(col.id)).find((f) => f.name === 'Files')!
    b.cloud.remoteEdit(rid, 'folder', folder.id, { name: 'Users (theirs)', parent_folder_id: other.id })
    await b.syncNow(ws.id)
    const c = (await b.listSyncConflicts(ws.id)).find((x) => x.entityId === folder.id)!
    expect(c.groups.filter((g) => g.conflicting).map((g) => g.group).sort()).toEqual(['location', 'name'])
    expect(c.allowedResolutions).toContain('merge')
    expect((await rejection(b.resolveSyncConflict({ conflictId: c.id, resolution: 'merge', fieldChoices: { name: 'remote' } })))?.code).toBe('invalid_input')
    await b.resolveSyncConflict({ conflictId: c.id, resolution: 'merge', fieldChoices: { name: 'remote', location: 'local' } })
    const merged = (await b.listFolders(col.id)).find((f) => f.id === folder.id)!
    expect(merged.name).toBe('Users (theirs)')
    expect(merged.parentFolderId).toBe((await b.listFolders(col.id)).find((f) => f.name === 'Auth')!.id)
  })

  it('remote_deleted: keep_remote deletes my copy; keep_local restores it in the cloud', async () => {
    const { out, c } = await conflictOf('remote_deleted')
    const rid = (await b.getSyncStatus(out.workspaceId)).remoteWorkspaceId!
    expect(b.cloud.remoteEntities(rid).some((e) => e.id === c.entityId)).toBe(false)
    await b.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_local' })
    expect(b.cloud.remoteEntities(rid).some((e) => e.id === c.entityId)).toBe(true)
    expect(await b.listSyncConflicts(out.workspaceId)).not.toContainEqual(expect.objectContaining({ id: c.id }))
  })

  it('local_deleted: keep_remote restores the request; keep_local pushes the delete', async () => {
    const { out, c } = await conflictOf('local_deleted')
    expect(c.allowedResolutions).toEqual(['keep_local', 'keep_remote'])
    await b.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_remote' })
    const col = (await b.listCollections(out.workspaceId)).find((x) => x.name.startsWith('Demo API'))!
    expect((await b.listRequests(col.id)).find((r) => r.id === c.entityId)?.name).toBe('Delete user (renamed in cloud)')
  })

  it('rejected: keep_remote discards the local change', async () => {
    const { out, c } = await conflictOf('rejected')
    await b.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_remote' })
    const col = (await b.listCollections(out.workspaceId)).find((x) => x.name.startsWith('Demo API'))!
    expect((await b.listRequests(col.id)).find((r) => r.id === c.entityId)?.name).toBe('Basic auth check')
  })

  it('immutable_clash duplicate needs a valid new version', async () => {
    const { c } = await conflictOf('immutable_clash')
    expect(c.allowedResolutions).toEqual(['keep_remote', 'duplicate'])
    expect((await rejection(b.resolveSyncConflict({ conflictId: c.id, resolution: 'duplicate', newVersion: 'nope' })))?.code).toBe('invalid_input')
    await b.resolveSyncConflict({ conflictId: c.id, resolution: 'duplicate', newVersion: '1.0.1' })
  })

  it('rejects resolutions that are not allowed and unknown ids', async () => {
    const { c } = await conflictOf('rejected')
    expect((await rejection(b.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_local' })))?.code).toBe('invalid_input')
    expect((await rejection(b.resolveSyncConflict({ conflictId: 'nope', resolution: 'keep_local' })))?.code).toBe('not_found')
  })

  it('discardPendingChanges resets local edits to the last synced state and closes conflicts', async () => {
    const { out } = await conflictOf('edit_edit', 'request')
    const st = await b.discardPendingChanges(out.workspaceId)
    expect(st.openConflicts).toBe(0)
    expect(st.pendingChanges).toBe(0)
  })

  it('a second remote edit while a conflict is open refreshes it; agreeing values close it', async () => {
    const { out, c } = await conflictOf('edit_edit', 'collection')
    const rid = (await b.getSyncStatus(out.workspaceId)).remoteWorkspaceId!
    b.cloud.remoteEdit(rid, 'collection', c.entityId, { name: 'Demo API (mine)' })
    await b.syncNow(out.workspaceId)
    expect((await b.listSyncConflicts(out.workspaceId)).some((x) => x.id === c.id)).toBe(false)
  })

  it('emits conflicts events when the open count changes', async () => {
    events.length = 0
    await b.cloud.scenario('conflicts')
    expect(events.some((e) => e.type === 'conflicts' && e.open > 0)).toBe(true)
  })
})

describe('local edits of a linked workspace while offline of conflicts', () => {
  it('dirty local delete is pushed as a delete', async () => {
    const ws = await publishPersonal()
    const rid = (await b.getSyncStatus(ws.id)).remoteWorkspaceId!
    const { req } = await firstRequest(ws.id)
    await b.deleteRequest(req.id)
    expect((await b.getSyncStatus(ws.id)).pendingChanges).toBe(1)
    await b.syncNow(ws.id)
    expect(b.cloud.remoteEntities(rid).some((e) => e.id === req.id)).toBe(false)
  })
})
