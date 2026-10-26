/**
 * Desktop sync engine against a REAL slinger-admin server + throwaway PostgreSQL.
 * Skipped unless SLINGER_SYNC_IT_SERVER_DIR points at slinger-admin/server (see vitest.sync-it.config.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalJson } from '../../sync/mapping'
import { mulberry32, randomOp } from '../sync/fuzzKit'
import { DOC, liveState, makeDevice, pendingCount, type Device } from '../sync/harness'
import { checkContainerAuthContract, checkLocalOnlyContract, checkRejectionContract, checkVersionAuthorsContract } from '../sync/wireContract'
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
    // section 21: scripts, docs, collection variables, globals (a secret one too)
    const script = JSON.stringify([{ listen: 'prerequest', script: { exec: ['pm.variables.set("x", 1)'], type: 'text/javascript' } }])
    await a.api.setCollectionScripts(col.id, script)
    await a.api.setFolderDescription(folder.id, '# Auth docs')
    await a.api.upsertCollectionVariable({ collectionId: col.id, key: 'base url', value: 'https://pay.example.com' })
    await a.api.upsertGlobalVariable({ workspaceId: ws, key: 'tenant', value: 'acme', isSecret: false })
    await a.api.upsertGlobalVariable({ workspaceId: ws, key: 'api key', value: 'PLAINTEXT-GLOBAL-43', isSecret: true })
    await a.api.publishWorkspace(ws)
    const s = await a.core.sync.syncNow(ws)
    expect(s).toMatchObject({ state: 'idle', pendingChanges: 0, initialSyncPending: false, role: 'owner' })
    expect(await a.api.listHistory(ws)).toEqual([]) // cloud traffic never becomes history
    expect(await serverState(s.remoteWorkspaceId!)).toEqual(deviceState(a, ws))
    expect(cloud.server.dump()).not.toContain('PLAINTEXT-SECRET-42')
    expect(cloud.server.dump()).not.toContain('PLAINTEXT-GLOBAL-43')
    expect((await serverState(s.remoteWorkspaceId!)).filter((x) => /^(collection_variable|global_variable):/.test(x))).toHaveLength(3)

    // a second device downloads it
    const b = await device(emails.owner)
    const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: s.remoteWorkspaceId!, localWorkspaceId: null })
    const sb = await b.core.sync.syncNow(link.workspace.id)
    expect(sb).toMatchObject({ state: 'idle', initialSyncPending: false })
    expect(deviceState(b, link.workspace.id)).toEqual(deviceState(a, ws))
    const vars = await b.api.listEnvironmentVariables(env.id)
    expect(vars.find((v) => v.key === 'token')).toMatchObject({ isSecret: true, secretMissing: true })
    expect((await b.api.listGlobalVariables(link.workspace.id)).map((g) => [g.key, g.secretMissing])).toEqual([['tenant', false], ['api key', true]])
    expect((await b.api.listCollectionVariables(col.id)).map((v) => v.value)).toEqual(['https://pay.example.com'])
    expect((await b.api.listCollections(link.workspace.id))[0]).toMatchObject({ scriptsJson: script })
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

  it.each([1, 2, 3])('an editor made viewer keeps pulling: random work on both sides around the downgrade, automatic and manual syncs (seed %i)', async (seed) => {
    const { a, ws, remoteId } = await published(`Downgrade ${seed}`)
    const email = `downgrade-${seed}@it.test`
    await cloud.createUser(admin, email, PASSWORD)
    await cloud.addMember(remoteId, ownerToken, email, PASSWORD, 'editor')
    const e = await device(email)
    const el = await e.api.linkRemoteWorkspace({ remoteWorkspaceId: remoteId, localWorkspaceId: null })
    const wsE = el.workspace.id
    await e.core.sync.syncNow(wsE)
    const rnd = mulberry32(seed * 9973)
    // Work on both sides; the editor's last edits are not pushed yet when write access goes.
    for (let i = 0; i < 12; i++) await randomOp(a, ws, rnd, i)
    await a.core.sync.syncNow(ws)
    await e.core.sync.syncNow(wsE)
    for (let i = 0; i < 10; i++) await randomOp(e, wsE, rnd, 100 + i)
    await cloud.setRole(remoteId, ownerToken, email, 'viewer')
    // The automatic cycle (role re-read is throttled) and then manual ones, while the owner keeps changing things.
    let st = await e.core.sync.engine.runCycle(wsE)
    expect(st.lastError, `auto cycle: ${JSON.stringify(st.lastError)}`).toBeNull()
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await randomOp(a, ws, rnd, 200 + round * 10 + i)
      await a.core.sync.syncNow(ws)
      st = round === 1 ? await e.core.sync.engine.runCycle(wsE) : await e.core.sync.syncNow(wsE)
      expect(st.lastError, `round ${round}: ${JSON.stringify(st.lastError)}`).toBeNull()
      expect(st).toMatchObject({ readOnly: true, role: 'viewer' })
    }
  })

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

  it('speaks the protocol v2 rejection contract exactly as the fake server does (sync/wireContract.ts)', async () => {
    let viewers = 0
    await checkRejectionContract({
      baseUrl: cloud.baseUrl,
      ownerToken,
      viewerToken: async (wsId) => {
        const email = `contract-viewer-${++viewers}@it.test`
        await cloud.createUser(admin, email, PASSWORD)
        await cloud.addMember(wsId, ownerToken, email, PASSWORD, 'viewer')
        return cloud.login(email, PASSWORD)
      },
    })
  })

  it('speaks the section 21 extensions (scripts/docs, collection variables, globals) exactly as the fake server does', async () => {
    await checkLocalOnlyContract({
      baseUrl: cloud.baseUrl,
      ownerToken,
      viewerToken: async (wsId) => {
        const email = 'contract21-viewer@it.test'
        await cloud.createUser(admin, email, PASSWORD)
        await cloud.addMember(wsId, ownerToken, email, PASSWORD, 'viewer')
        return cloud.login(email, PASSWORD)
      },
    })
  })

  it('speaks the container_auth extension (collection/folder auth) exactly as the fake server does', async () => {
    await checkContainerAuthContract({ baseUrl: cloud.baseUrl, ownerToken, viewerToken: async () => '' })
  })

  it('speaks the version_authors extension (created_by on collection versions) exactly as the fake server does', async () => {
    await checkVersionAuthorsContract({
      baseUrl: cloud.baseUrl,
      ownerToken,
      viewerToken: async () => {
        throw new Error('not needed')
      },
    })
  })

  describe('version authors (feature version_authors) against the real server', () => {
    const me = async (token: string) => ((await cloud.call('GET', '/v1/me', { token })).json.user as Json)
    const serverVersions = async (remoteId: string, colId: string, token = ownerToken) => {
      const res = await cloud.call('GET', `/v1/workspaces/${remoteId}/collections/${colId}/versions`, { token })
      expect(res.status, res.text).toBe(200)
      return res.json.items as Json[]
    }
    const noConflicts = async (d: Device, ws: string) => {
      expect(await d.api.listSyncConflicts(ws)).toEqual([])
      expect(await d.api.getSyncStatus(ws)).toMatchObject({ openConflicts: 0, pendingChanges: 0, state: 'idle' })
    }

    it("a version made on device A shows A's user as its author on device B, with no clash or conflict on either side", async () => {
      const a = await device(emails.owner)
      const ws = a.workspace.id
      const owner = await me(ownerToken)
      const col = await a.api.createCollection(ws, 'Versioned')
      const v = await a.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'first' })
      // Made while signed in: the author is known locally at once.
      expect(v.createdBy).toEqual({ id: owner.id, name: owner.display_name })
      await a.api.publishWorkspace(ws)
      const sa = await a.core.sync.syncNow(ws)
      expect(sa.state).toBe('idle')
      await noConflicts(a, ws)
      // The server recorded the same author (REST view).
      expect(await serverVersions(sa.remoteWorkspaceId!, col.id)).toEqual([
        expect.objectContaining({ id: v.id, semver: '1.0.0', created_by: { id: owner.id, display_name: owner.display_name } }),
      ])
      expect((await a.api.getCollectionVersion(v.id)).createdBy).toEqual({ id: owner.id, name: owner.display_name })

      // Device B (same user) links and downloads: the version arrives with its author.
      const b = await device(emails.owner)
      const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: sa.remoteWorkspaceId!, localWorkspaceId: null })
      const wsB = link.workspace.id
      await b.core.sync.syncNow(wsB)
      const got = await b.api.listCollectionVersions(col.id)
      expect(got.map((x) => [x.id, x.version, x.notes, x.createdBy])).toEqual([[v.id, '1.0.0', 'first', { id: owner.id, name: owner.display_name }]])
      await noConflicts(b, wsB)
      // Another round trip on both sides stays quiet (no immutable clash, nothing to upload).
      await b.core.sync.syncNow(wsB)
      await a.core.sync.syncNow(ws)
      await noConflicts(a, ws)
      await noConflicts(b, wsB)
      expect(await a.api.listCollectionVersions(col.id)).toHaveLength(1)
      expect(await b.api.listCollectionVersions(col.id)).toHaveLength(1)

      // A version B makes later travels back with B's author.
      const v2 = await b.api.createCollectionVersion({ collectionId: col.id, version: '1.1.0' })
      await b.core.sync.syncNow(wsB)
      await a.core.sync.syncNow(ws)
      expect((await a.api.getCollectionVersion(v2.id)).createdBy).toEqual({ id: owner.id, name: owner.display_name })
      await noConflicts(a, ws)
      await noConflicts(b, wsB)
    })

    it("a version made by another member shows that member's name on the owner's device, for sync pushes and REST creates", async () => {
      const { a, ws, col, remoteId } = await published('Authors')
      await cloud.addMember(remoteId, ownerToken, emails.editor, PASSWORD, 'editor')
      const editorToken = await cloud.login(emails.editor, PASSWORD)
      const editor = await me(editorToken)
      const e = await device(emails.editor)
      const el = await e.api.linkRemoteWorkspace({ remoteWorkspaceId: remoteId, localWorkspaceId: null })
      await e.core.sync.syncNow(el.workspace.id)
      const ev = await e.api.createCollectionVersion({ collectionId: col.id, version: '2.0.0', notes: 'by editor' })
      expect(ev.createdBy).toEqual({ id: editor.id, name: editor.display_name })
      await e.core.sync.syncNow(el.workspace.id)
      await a.core.sync.syncNow(ws)
      expect((await a.api.getCollectionVersion(ev.id)).createdBy).toEqual({ id: editor.id, name: editor.display_name })
      await noConflicts(a, ws)
      await noConflicts(e, el.workspace.id)
      // REST creates (dashboard/API) are attributed as well, and reach the desktop with the author.
      const rest = await cloud.call('POST', `/v1/workspaces/${remoteId}/collections/${col.id}/versions`, {
        token: editorToken,
        body: { semver: '2.1.0', snapshot_json: JSON.stringify({ collectionName: 'Shared', folders: [], requests: [] }), notes: 'via rest' },
      })
      expect(rest.status, rest.text).toBe(201)
      expect(rest.json.version.created_by).toEqual({ id: editor.id, display_name: editor.display_name })
      await a.core.sync.syncNow(ws)
      const restVersion = (await a.api.listCollectionVersions(col.id)).find((x) => x.version === '2.1.0')!
      expect(restVersion.createdBy).toEqual({ id: editor.id, name: editor.display_name })
      await noConflicts(a, ws)
    })

    it("the server's created_by is applied to a version whose local author was already set, without a conflict", async () => {
      const a = await device(emails.owner)
      const ws = a.workspace.id
      const owner = await me(ownerToken)
      const col = await a.api.createCollection(ws, 'Stale')
      const v = await a.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
      expect(v.createdBy).toEqual({ id: owner.id, name: owner.display_name })
      // The local author column is out of date (e.g. a display name changed afterwards on the device).
      a.db.prepare("UPDATE collection_versions SET created_by_id = ?, created_by_name = 'Stale Name' WHERE id = ?").run(owner.id, v.id)
      await a.api.publishWorkspace(ws)
      const sa = await a.core.sync.syncNow(ws)
      await noConflicts(a, ws)
      const server = (await serverVersions(sa.remoteWorkspaceId!, col.id))[0]!
      expect(server.created_by).toEqual({ id: owner.id, display_name: owner.display_name }) // the server never trusts the client
      // (A's own push is not echoed back, so its stale local value only changes when the server redelivers the version.)
      // A device that downloads it sees the server's value, never the stale local one.
      const b = await device(emails.owner)
      const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: sa.remoteWorkspaceId!, localWorkspaceId: null })
      await b.core.sync.syncNow(link.workspace.id)
      expect((await b.api.getCollectionVersion(v.id)).createdBy).toEqual({ id: owner.id, name: owner.display_name })
      // Re-linking A (a fresh snapshot of the same workspace) delivers the server's author over A's stale one, with no clash.
      await a.api.unlinkWorkspace(ws)
      const relink = await a.api.linkRemoteWorkspace({ remoteWorkspaceId: sa.remoteWorkspaceId!, localWorkspaceId: ws })
      await a.core.sync.syncNow(relink.workspace.id)
      const after = await a.api.getCollectionVersion(v.id)
      expect(after.createdBy).toEqual({ id: owner.id, name: owner.display_name })
      expect(await a.api.listCollectionVersions(col.id)).toHaveLength(1)
      await noConflicts(a, relink.workspace.id)
    })

    it('an account that only has a legacy-style (no author) local version keeps working: unknown author, no conflict', async () => {
      // Not signed in when the version is made: no local author. The server attributes it to whoever pushes it.
      const a = await device(emails.owner)
      const ws = a.workspace.id
      const owner = await me(ownerToken)
      const col = await a.api.createCollection(ws, 'NoAuthor')
      const v = await a.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
      a.db.prepare('UPDATE collection_versions SET created_by_id = NULL, created_by_name = NULL WHERE id = ?').run(v.id)
      expect((await a.api.getCollectionVersion(v.id)).createdBy).toBeNull()
      await a.api.publishWorkspace(ws)
      const sa = await a.core.sync.syncNow(ws)
      await noConflicts(a, ws)
      expect((await serverVersions(sa.remoteWorkspaceId!, col.id))[0]!.created_by).toEqual({ id: owner.id, display_name: owner.display_name })
      const b = await device(emails.owner)
      const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: sa.remoteWorkspaceId!, localWorkspaceId: null })
      await b.core.sync.syncNow(link.workspace.id)
      expect((await b.api.getCollectionVersion(v.id)).createdBy).toEqual({ id: owner.id, name: owner.display_name })
    })
  })

  describe('team: members of the linked workspace (GET /v1/workspaces/{id}/members)', () => {
    it('listWorkspaceMembers and status.members follow the members the owner adds and removes through the REST API', async () => {
      const { a, ws, remoteId } = await published('Members')
      const owner = (await cloud.call('GET', '/v1/me', { token: ownerToken })).json.user as Json
      expect((await a.api.getSyncStatus(ws)).members).toBe(1)
      const alone = await a.api.listWorkspaceMembers(ws)
      expect(alone).toHaveLength(1)
      expect(alone[0]).toMatchObject({ userId: owner.id, email: emails.owner, displayName: owner.display_name, role: 'owner', isYou: true })

      const added = await cloud.addMember(remoteId, ownerToken, emails.editor, PASSWORD, 'editor')
      a.events.length = 0
      const list = await a.api.listWorkspaceMembers(ws)
      expect(list).toHaveLength(2)
      expect(list.filter((m) => m.isYou)).toHaveLength(1)
      expect(list.find((m) => m.isYou)).toMatchObject({ userId: owner.id, email: emails.owner, role: 'owner' })
      const other = list.find((m) => !m.isYou)!
      expect(other).toMatchObject({ userId: added.userId, email: emails.editor, displayName: 'editor', role: 'editor' })
      expect(other.id).toBe(added.memberId)
      expect(other.joinedAt).toBeGreaterThan(1_700_000_000)
      expect(Math.abs(other.joinedAt - Date.now() / 1000)).toBeLessThan(3600)
      expect((await a.api.getSyncStatus(ws)).members).toBe(2)
      expect(a.statusEvents().at(-1)!.members).toBe(2)

      // A manual sync recounts as well (forced, not throttled) after the owner removes the member again.
      await cloud.removeMember(remoteId, ownerToken, emails.editor)
      expect((await a.core.sync.syncNow(ws)).members).toBe(1)
      expect(await a.api.listWorkspaceMembers(ws)).toHaveLength(1)
    })

    it('the added account sees both members too, with isYou on its own row, and a viewer may read the list', async () => {
      const { a, ws, remoteId } = await published('Members2')
      await cloud.addMember(remoteId, ownerToken, emails.viewer, PASSWORD, 'viewer')
      expect((await a.core.sync.syncNow(ws)).members).toBe(2)
      const v = await device(emails.viewer)
      const link = await v.api.linkRemoteWorkspace({ remoteWorkspaceId: remoteId, localWorkspaceId: null })
      const st = await v.core.sync.syncNow(link.workspace.id)
      expect(st).toMatchObject({ members: 2, role: 'viewer' })
      const list = await v.api.listWorkspaceMembers(link.workspace.id)
      expect(list.map((m) => [m.email, m.role, m.isYou]).sort()).toEqual([[emails.owner, 'owner', false], [emails.viewer, 'viewer', true]].sort())
    })
  })

  describe('push rejections with a writer racing between pull and push', () => {
    /** A device whose next push is preceded by `race` (a REST write by the owner), recording the pull/push sequence. */
    async function racingDevice() {
      const state: { race: (() => Promise<void>) | null; calls: string[] } = { race: null, calls: [] }
      const racing: typeof fetch = async (input, init) => {
        const url = String(input)
        const m = /\/sync\/(pull|push)/.exec(url)
        if (m) state.calls.push(m[1]!)
        if (state.race && url.includes('/sync/push')) {
          const r = state.race
          state.race = null
          await r()
        }
        return fetch(input, init)
      }
      const a = await device(emails.owner, { fetchImpl: racing })
      const ws = a.workspace.id
      const col = await a.api.createCollection(ws, 'Race')
      const folder = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'F' })
      const req = await a.api.createRequest({ workspaceId: ws, collectionId: col.id, folderId: folder.id, name: 'R', method: 'GET', url: 'https://x/1', documentJson: DOC })
      await a.api.publishWorkspace(ws)
      const s = await a.core.sync.syncNow(ws)
      const remoteId = s.remoteWorkspaceId!
      const rest = async (method: string, path: string, body?: unknown) => {
        const res = await cloud.call(method, `/v1/workspaces/${remoteId}${path}`, { token: ownerToken, body })
        if (res.status >= 300) throw new Error(`${method} ${path}: ${res.text}`)
        return res.json
      }
      const edit = async (fields: { name?: string; url?: string }) => {
        const cur = (await a.api.listRequests(col.id)).find((r) => r.id === req.id)!
        await a.api.updateRequest({ requestId: req.id, name: fields.name ?? cur.name, method: cur.method, url: fields.url ?? cur.url, documentJson: DOC, expectedVersion: cur.version })
      }
      return { a, ws, col, folder, req, remoteId, state, rest, edit }
    }

    it('version_mismatch: merged from current_payload and pushed again without another pull', async () => {
      const { a, ws, req, remoteId, state, rest, edit } = await racingDevice()
      await edit({ url: 'https://x/local' })
      state.race = async () => {
        const cur = (await rest('GET', `/requests/${req.id}`)).request as Json
        await rest('PATCH', `/requests/${req.id}`, { sort_order: 7, version: cur.version })
      }
      state.calls.length = 0
      const s = await a.core.sync.syncNow(ws)
      expect(state.calls).toEqual(['pull', 'push', 'push'])
      expect(s).toMatchObject({ state: 'idle', pendingChanges: 0, openConflicts: 0 })
      const server = (await rest('GET', `/requests/${req.id}`)).request as Json
      expect(server).toMatchObject({ url: 'https://x/local', sort_order: 7 })
      expect(await serverState(remoteId)).toEqual(deviceState(a, ws))
    })

    it('not_found: an edit of a request deleted meanwhile becomes remote_deleted after one pull; keep_local re-creates it', async () => {
      const { a, ws, req, remoteId, state, rest, edit } = await racingDevice()
      await edit({ name: 'Edited here' })
      state.race = async () => void (await rest('DELETE', `/requests/${req.id}`))
      state.calls.length = 0
      await a.core.sync.syncNow(ws)
      expect(state.calls).toEqual(['pull', 'push', 'pull'])
      const [c] = await a.api.listSyncConflicts(ws)
      expect(c).toMatchObject({ kind: 'remote_deleted', entityId: req.id })
      await a.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'keep_local' })
      const s = await a.core.sync.syncNow(ws)
      expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
      expect(((await rest('GET', `/requests/${req.id}`)).request as Json).name).toBe('Edited here')
      expect(await serverState(remoteId)).toEqual(deviceState(a, ws))
    })

    it('a move into a folder deleted meanwhile (server: not_found since slinger-admin 9ce4b08, invalid before) pulls first and ends as remote_deleted, not quarantined', async () => {
      const { a, ws, col, req, remoteId, state, rest } = await racingDevice()
      const other = await a.api.createFolder({ workspaceId: ws, collectionId: col.id, name: 'Other' })
      await a.core.sync.syncNow(ws)
      await a.api.moveRequest({ requestId: req.id, targetCollectionId: col.id, targetFolderId: other.id, targetIndex: 0 })
      state.race = async () => void (await rest('DELETE', `/folders/${other.id}`))
      await a.core.sync.syncNow(ws)
      const kinds = (await a.api.listSyncConflicts(ws)).map((c) => c.kind)
      expect(kinds.length).toBeGreaterThan(0)
      expect(kinds.every((k) => k === 'remote_deleted')).toBe(true)
      const folderConflict = (await a.api.listSyncConflicts(ws)).find((c) => c.entityId === other.id)!
      await a.api.resolveSyncConflict({ conflictId: folderConflict.id, resolution: 'keep_local' })
      const s = await a.core.sync.syncNow(ws)
      expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
      expect(await serverState(remoteId)).toEqual(deviceState(a, ws))
    })
  })
})
