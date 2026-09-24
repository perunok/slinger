/**
 * Desktop sync engine against a REAL slinger-admin server + throwaway PostgreSQL.
 * Skipped unless SLINGER_SYNC_IT_SERVER_DIR points at slinger-admin/server (see vitest.sync-it.config.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalJson } from '../../sync/mapping'
import { DOC, liveState, makeDevice, pendingCount, type Device } from '../sync/harness'
import { RealCloud, signInDevice, type Json } from './realCloud'

const enabled = !!process.env.SLINGER_SYNC_IT_SERVER_DIR
const PASSWORD = 'sync-it-user-passphrase-1'

describe.skipIf(!enabled)('sync engine against the real server', () => {
  let cloud: RealCloud
  let admin: string
  const devices: Device[] = []
  const emails = { owner: 'owner@it.test', editor: 'editor@it.test', viewer: 'viewer@it.test' }
  let ownerToken: string

  beforeAll(async () => {
    cloud = await RealCloud.start()
    admin = await cloud.adminToken()
    for (const e of Object.values(emails)) await cloud.createUser(admin, e, PASSWORD)
    ownerToken = await cloud.login(emails.owner, PASSWORD)
  })
  afterAll(async () => {
    devices.forEach((d) => d.cleanup())
    await cloud?.stop()
  })

  async function device(email: string, opts: Parameters<typeof makeDevice>[1] = {}): Promise<Device> {
    const d = makeDevice(cloud, { ...opts, signedIn: false })
    devices.push(d)
    await signInDevice(d, cloud, email, PASSWORD)
    return d
  }

  const serverState = async (wsId: string) =>
    (await cloud.snapshotAll(wsId, ownerToken)).map((e) => `${e.resource_type}:${e.resource_id}:${canonicalJson(e.payload)}`).sort()
  const deviceState = (d: Device, ws: string) => liveState(d, ws).map((e) => `${e.type}:${e.id}:${canonicalJson(e.wire)}`).sort()

  it('signs in through the real device flow; publish uploads everything, secrets never reach the server', async () => {
    const a = await device(emails.owner)
    const ws = a.workspace.id
    expect((await a.api.getCloudSession()).user?.email).toBe(emails.owner)
    const col = await a.api.createCollection(ws, 'Payments')
    const folder = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Auth' })
    for (let i = 0; i < 5; i++) await a.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: i % 2 ? folder.id : null, name: `Req ${i}`, method: i % 2 ? 'POST' : 'GET', url: `https://x/${i}`, documentJson: DOC })
    await a.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'first' })
    const env = await a.api.createEnvironment(ws, 'Prod')
    await a.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'host', value: 'api.example.com', isSecret: false })
    await a.api.upsertEnvironmentVariable({ environmentId: env.id, key: 'token', value: 'PLAINTEXT-SECRET-42', isSecret: true })
    await a.api.publishWorkspace(ws)
    const s = await a.core.sync.syncNow(ws)
    expect(s).toMatchObject({ state: 'idle', pendingChanges: 0, initialSyncPending: false, role: 'owner' })
    expect(await a.api.listHistory(ws)).toEqual([]) // cloud traffic never becomes history
    expect(await serverState(s.remoteWorkspaceId!)).toEqual(deviceState(a, ws))
    expect(cloud.server.dump()).not.toContain('PLAINTEXT-SECRET-42')

    // a second device downloads it
    const b = await device(emails.owner)
    const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: s.remoteWorkspaceId!, localWorkspaceId: null })
    const sb = await b.core.sync.syncNow(link.workspace.id)
    expect(sb).toMatchObject({ state: 'idle', initialSyncPending: false })
    expect(deviceState(b, link.workspace.id)).toEqual(deviceState(a, ws))
    const vars = await b.api.listEnvironmentVariables(env.id)
    expect(vars.find((v) => v.key === 'token')).toMatchObject({ isSecret: true, secretMissing: true })
    expect(await b.api.listCollectionVersions(col.id)).toHaveLength(1)
  })

  // ---------------------------------------------------------------------------------------------------------------

  /** A published workspace owned by `owner` with a little content; returns handles. */
  async function published(name = 'Team') {
    const a = await device(emails.owner)
    const ws = a.workspace.id
    await a.api.renameWorkspace(ws, name)
    const col = await a.api.createCollection(ws, 'Shared')
    await a.api.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Ping', method: 'GET', url: 'https://x/ping', documentJson: DOC })
    await a.api.publishWorkspace(ws)
    const s = await a.core.sync.syncNow(ws)
    return { a, ws, col, remoteId: s.remoteWorkspaceId! }
  }

  it('roles: viewer links read-only, editor pushes, downgrade keeps pending changes, revoke and delete stop sync', async () => {
    const { a, ws, col, remoteId } = await published('Roles')
    await cloud.addMember(remoteId, ownerToken, emails.editor, PASSWORD, 'editor')
    await cloud.addMember(remoteId, ownerToken, emails.viewer, PASSWORD, 'viewer')

    // viewer: download only
    const v = await device(emails.viewer)
    await v.api.createCollection(v.workspace.id, 'my local stuff')
    await expect(v.api.linkRemoteWorkspace({ remoteWorkspaceId: remoteId, localWorkspaceId: v.workspace.id })).rejects.toMatchObject({ code: 'sync_blocked' })
    const vl = await v.api.linkRemoteWorkspace({ remoteWorkspaceId: remoteId, localWorkspaceId: null })
    const vs = await v.core.sync.syncNow(vl.workspace.id)
    expect(vs).toMatchObject({ readOnly: true, role: 'viewer', state: 'idle' })
    await expect(v.api.createCollection(vl.workspace.id, 'nope')).rejects.toBeTruthy()

    // editor: pushes; owner receives
    const e = await device(emails.editor)
    const el = await e.api.linkRemoteWorkspace({ remoteWorkspaceId: remoteId, localWorkspaceId: null })
    await e.core.sync.syncNow(el.workspace.id)
    const req = (await e.api.listRequests(col.id))[0]!
    await e.api.renameRequest(req.id, 'Ping (editor)')
    expect((await e.core.sync.syncNow(el.workspace.id)).pendingChanges).toBe(0)
    await a.core.sync.syncNow(ws)
    expect((await a.api.listRequests(col.id))[0]!.name).toBe('Ping (editor)')

    // editor -> viewer while holding an unpushed change: read-only, change kept, discard resets
    await e.api.renameRequest(req.id, 'Ping (offline edit)')
    await cloud.setRole(remoteId, ownerToken, emails.editor, 'viewer')
    const down = await e.core.sync.syncNow(el.workspace.id)
    expect(down).toMatchObject({ readOnly: true, role: 'viewer', pendingChanges: 1, state: 'idle' })
    await expect(e.api.renameRequest(req.id, 'x')).rejects.toBeTruthy()
    expect((await e.api.discardPendingChanges(el.workspace.id)).pendingChanges).toBe(0)
    expect((await e.api.listRequests(col.id))[0]!.name).toBe('Ping (editor)')
    // and back up: a change made now is pushed
    await cloud.setRole(remoteId, ownerToken, emails.editor, 'editor')
    expect((await e.core.sync.syncNow(el.workspace.id)).readOnly).toBe(false)
    await e.api.renameRequest(req.id, 'Ping (editor again)')
    expect((await e.core.sync.syncNow(el.workspace.id)).pendingChanges).toBe(0)

    // membership removed -> accessRevoked, local content stays
    await e.api.renameRequest(req.id, 'unpushed')
    await cloud.removeMember(remoteId, ownerToken, emails.editor)
    const gone = await e.core.sync.syncNow(el.workspace.id)
    expect(gone).toMatchObject({ state: 'accessRevoked', pendingChanges: 1 })
    expect(await e.api.listRequests(col.id)).toHaveLength(1)

    // the whole workspace deleted by an admin -> the owner's device stops as well
    const del = await cloud.call('DELETE', `/v1/admin/workspaces/${remoteId}`, { token: admin })
    expect(del.status).toBeLessThan(300)
    const dead = await a.core.sync.syncNow(ws)
    expect(dead.state).toBe('accessRevoked')
    expect(dead.lastError?.code).toMatch(/workspace_deleted|access_revoked/)
  })

  it('an interrupted initial upload resumes without duplicating anything', async () => {
    let pushes = 0
    const flaky: typeof fetch = async (input, init) => {
      if (String(input).includes('/sync/push') && ++pushes === 2) throw new TypeError('connection reset')
      return fetch(input, init)
    }
    const a = await device(emails.owner, { fetchImpl: flaky })
    const ws = a.workspace.id
    const col = await a.api.createCollection(ws, 'Big')
    await a.api.importPostmanCollection(ws, JSON.stringify({
      info: { name: 'Imp', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: Array.from({ length: 450 }, (_, i) => ({ name: `R${i}`, request: { method: 'GET', url: `https://x/${i}` } })),
    }))
    void col
    await a.api.publishWorkspace(ws)
    const first = await a.core.sync.syncNow(ws)
    expect(first.state).toBe('offline')
    expect(first.initialSyncPending).toBe(true)
    expect(first.pendingChanges).toBeGreaterThan(0)
    const done = await a.core.sync.syncNow(ws)
    expect(done).toMatchObject({ state: 'idle', pendingChanges: 0, initialSyncPending: false })
    const server = await cloud.snapshotAll(done.remoteWorkspaceId!, ownerToken)
    expect(server.filter((e) => e.resource_type === 'request')).toHaveLength(450)
    expect(await serverState(done.remoteWorkspaceId!)).toEqual(deviceState(a, ws))
  })

  it('pushes documents near the size limit in body-limit-safe chunks', async () => {
    const a = await device(emails.owner)
    const ws = a.workspace.id
    const col = await a.api.createCollection(ws, 'Heavy')
    const doc = (i: number) => JSON.stringify({ headers: [], body: `${i}:` + 'x'.repeat(850_000) })
    for (let i = 0; i < 8; i++) await a.api.createRequest({ workspaceId: ws, collectionId: col.id, name: `Doc ${i}`, method: 'POST', url: 'u', documentJson: doc(i) })
    await a.api.createRequest({ workspaceId: ws, collectionId: col.id, name: 'Too big', method: 'POST', url: 'u', documentJson: JSON.stringify({ body: 'y'.repeat(950_000) }) })
    await a.api.publishWorkspace(ws)
    const s = await a.core.sync.syncNow(ws)
    expect(s.state).toBe('idle')
    expect(s.openConflicts).toBe(1) // the 950 KB document is quarantined locally, never sent
    const server = await cloud.snapshotAll(s.remoteWorkspaceId!, ownerToken)
    expect(server.filter((e) => e.resource_type === 'request')).toHaveLength(8)
  })

  it('refuses a server that does not advertise protocol_version 2', async () => {
    const old: typeof fetch = async (input, init) => {
      const res = await fetch(input, init)
      if (!String(input).endsWith('/v1/sync/clients/register')) return res
      const body = (await res.json()) as Json
      delete body.protocol_version
      delete body.features
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'Content-Type': 'application/json' } })
    }
    const a = await device(emails.owner, { fetchImpl: old })
    await expect(a.api.publishWorkspace(a.workspace.id)).rejects.toMatchObject({ code: 'sync_blocked' })
  })

  it('backs off on 5xx and 429 (Retry-After) and recovers', async () => {
    let mode: 'ok' | '503' | '429' = 'ok'
    const flaky: typeof fetch = async (input, init) => {
      if (mode !== 'ok' && String(input).includes('/sync/')) {
        return mode === '503'
          ? new Response(JSON.stringify({ error: { code: 'internal_error', message: 'boom' } }), { status: 503 })
          : new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow' } }), { status: 429, headers: { 'Retry-After': '120' } })
      }
      return fetch(input, init)
    }
    const { a, ws } = await (async () => {
      const dev = await device(emails.owner, { fetchImpl: flaky })
      await dev.api.createCollection(dev.workspace.id, 'Flaky')
      await dev.api.publishWorkspace(dev.workspace.id)
      await dev.core.sync.syncNow(dev.workspace.id)
      return { a: dev, ws: dev.workspace.id }
    })()
    mode = '503'
    await a.api.createCollection(ws, 'Pending')
    const s1 = await a.core.sync.syncNow(ws)
    expect(s1).toMatchObject({ state: 'error', pendingChanges: 1 })
    mode = '429'
    const s2 = await a.core.sync.syncNow(ws)
    expect(s2.state).toBe('error')
    expect(s2.nextRetryAt! - a.clock.now() / 1000).toBeGreaterThanOrEqual(119)
    mode = 'ok'
    expect(await a.core.sync.syncNow(ws)).toMatchObject({ state: 'idle', pendingChanges: 0, lastError: null })
  })

  it('a second account cannot take over ids of another workspace: republish after unlink is quarantined as id-in-use', async () => {
    const { a, ws } = await published('Once')
    await a.api.unlinkWorkspace(ws)
    await a.api.publishWorkspace(ws)
    const s = await a.core.sync.syncNow(ws)
    expect(s.openConflicts).toBeGreaterThan(0)
    expect((await a.api.listSyncConflicts(ws)).every((c) => c.kind === 'rejected')).toBe(true)
    expect(pendingCount(a, ws)).toBeGreaterThan(0)
  })
})
