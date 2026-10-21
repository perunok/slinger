/**
 * Who created a collection version (sync feature `version_authors`, docs/SYNC_DESIGN.md section 21): the server's
 * `created_by` is split off every remote payload before anything is compared or stored and written to the local
 * row's author columns. Two devices against the fake server, plus direct apply-level checks.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyRemoteOp, applySnapshotEntity, hideClashingVersion, makeApplyCtx, splitAuthor } from '../../sync/apply'
import { applyTx, getEntity, getLink } from '../../sync/store'
import { CLIENT_FEATURES } from '../../sync/mapping'
import { FakeCloud } from './fakeCloud'
import { checkVersionAuthorsContract } from './wireContract'
import { makeDevice, pendingCount, settle, type Device } from './harness'

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

const authorOf = (d: Device, id: string) => d.api.getCollectionVersion(id).then((v) => v.createdBy)

/** A signed-in device (session user known, like after a sign-in in the app). */
async function signedIn(email: string, name: string, deviceName?: string) {
  const user = cloud.createUser(email, name)
  const d = makeDevice(cloud, { userId: user.id, deviceName })
  devices.push(d)
  await d.core.sync.auth.getSession()
  return { user, d }
}

/** Alice publishes a workspace with collection C and version 1.0.0; Bob (editor) links it. */
async function aliceAndBob() {
  const alice = await signedIn('alice@example.com', 'Alice')
  const ws = alice.d.workspace.id
  const col = await alice.d.api.createCollection(ws, 'C')
  const v = await alice.d.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0', notes: 'first' })
  await alice.d.api.publishWorkspace(ws)
  const st = await settle(alice.d, ws)
  const remoteId = st.remoteWorkspaceId!
  const bob = await signedIn('bob@example.com', 'Bob', 'B')
  cloud.setRole(remoteId, bob.user.id, 'editor')
  const link = await bob.d.api.linkRemoteWorkspace({ remoteWorkspaceId: remoteId, localWorkspaceId: null })
  await settle(bob.d, link.workspace.id)
  return { alice, bob, col, v, ws, wsB: link.workspace.id, remoteId }
}

describe('contract (the fake speaks what the real server speaks)', () => {
  it('checkVersionAuthorsContract', async () => {
    const owner = cloud.createUser('owner@example.com', 'Olivia Owner')
    await checkVersionAuthorsContract({
      baseUrl: cloud.baseUrl,
      ownerToken: cloud.issueTokens(owner.id).accessToken,
      viewerToken: async () => {
        throw new Error('not needed')
      },
    })
  })
})

describe('splitAuthor', () => {
  it('removes created_by from collection_version payloads only and reads id/display_name', () => {
    const p = { semver: '1.0.0', created_by: { id: 'u1', display_name: ' Ann ' } }
    expect(splitAuthor('collection_version', p)).toEqual({ payload: { semver: '1.0.0' }, author: { id: 'u1', name: 'Ann' } })
    expect(splitAuthor('collection_version', { semver: '1', created_by: { id: null, display_name: 'Gone' } }).author).toEqual({ id: null, name: 'Gone' })
    expect(splitAuthor('collection_version', { semver: '1', created_by: null })).toEqual({ payload: { semver: '1' }, author: null })
    expect(splitAuthor('collection_version', { semver: '1', created_by: 'garbage' }).author).toBeNull()
    expect(splitAuthor('collection_version', { semver: '1', created_by: { id: 5, display_name: '' } }).author).toBeNull()
    const q = { name: 'x', created_by: { id: 'u', display_name: 'n' } }
    expect(splitAuthor('collection', q)).toEqual({ payload: q, author: null })
    const same = { semver: '1' }
    expect(splitAuthor('collection_version', same).payload).toBe(same)
  })
  it('the client declares the feature', () => {
    expect(CLIENT_FEATURES).toContain('version_authors')
  })
})

describe('creating and pulling versions', () => {
  it('a version made while signed in records the signed-in user; not signed in: unknown', async () => {
    const { d } = await signedIn('alice@example.com', 'Alice')
    const col = await d.api.createCollection(d.workspace.id, 'C')
    const v = await d.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
    expect(v.createdBy).toEqual({ id: expect.any(String), name: 'Alice' })
    expect((await d.api.listCollectionVersions(col.id))[0]!.createdBy).toEqual(v.createdBy)

    const anon = makeDevice(cloud)
    devices.push(anon)
    const c2 = await anon.api.createCollection(anon.workspace.id, 'C')
    expect((await anon.api.createCollectionVersion({ collectionId: c2.id, version: '1.0.0' })).createdBy).toBeNull()
  })

  it('a pulled version shows its author, with no conflict and nothing left to upload', async () => {
    const { alice, bob, v, wsB } = await aliceAndBob()
    expect(await authorOf(bob.d, v.id)).toEqual({ id: alice.user.id, name: 'Alice' })
    expect((await bob.d.api.getSyncStatus(wsB)).openConflicts).toBe(0)
    expect(pendingCount(bob.d, wsB)).toBe(0)
    // The author is never in the stored merge base.
    expect(getEntity(bob.d.db, 'collection_version', v.id)!.base_payload).not.toContain('created_by')
  })

  it('an author the other device made later arrives with the pull', async () => {
    const { alice, bob, col, wsB } = await aliceAndBob()
    const v2 = await bob.d.api.createCollectionVersion({ collectionId: col.id, version: '1.1.0' })
    expect(v2.createdBy).toEqual({ id: bob.user.id, name: 'Bob' })
    await settle(bob.d, wsB)
    await settle(alice.d, alice.d.workspace.id)
    expect(await authorOf(alice.d, v2.id)).toEqual({ id: bob.user.id, name: 'Bob' })
    expect((await alice.d.api.getSyncStatus(alice.d.workspace.id)).openConflicts).toBe(0)
  })

  it('a local version made without a known author is confirmed by the server with its author and no clash', async () => {
    const user = cloud.createUser('carol@example.com', 'Carol')
    const d = makeDevice(cloud, { userId: user.id }) // the session user is not loaded: the version has no author yet
    devices.push(d)
    const ws = d.workspace.id
    const col = await d.api.createCollection(ws, 'C')
    const v = await d.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
    expect(v.createdBy).toBeNull()
    await d.api.publishWorkspace(ws)
    await settle(d, ws)
    expect(await authorOf(d, v.id)).toEqual({ id: user.id, name: 'Carol' })
    expect((await d.api.getSyncStatus(ws)).openConflicts).toBe(0)
    expect(pendingCount(d, ws)).toBe(0)
    expect((await d.api.listCollectionVersions(col.id)).map((x) => x.version)).toEqual(['1.0.0'])
  })

  it('the server value wins over a different local author', async () => {
    const { alice, v, ws } = await aliceAndBob()
    alice.d.db.prepare("UPDATE collection_versions SET created_by_id = 'x', created_by_name = 'Somebody else' WHERE id = ?").run(v.id)
    // A re-delivery of the version (snapshot after a relink, or a log replay) carries the server's author.
    const entity = cloud.entity(v.id)!
    cloud.restUpsert(entity.ws, 'collection_version', v.id, entity.data, { id: alice.user.id, name: 'Alice' }) // bumps nothing in content
    await settle(alice.d, ws)
    expect(await authorOf(alice.d, v.id)).toEqual({ id: alice.user.id, name: 'Alice' })
    expect((await alice.d.api.getSyncStatus(ws)).openConflicts).toBe(0)
  })

  it('a legacy version (no author on the server) stays unknown, and never overwrites a local author', async () => {
    const { alice, bob, col, ws, wsB, remoteId } = await aliceAndBob()
    const id = '00000000-0000-4000-8000-0000000000a1'
    const data = { collection_id: col.id, semver: '0.9.0', notes: null, snapshot_json: JSON.stringify({ collectionName: 'C', folders: [], requests: [] }), folder_count: 0, request_count: 0, created_at: '2026-01-01T00:00:00.000Z' }
    cloud.restUpsert(remoteId, 'collection_version', id, data, null)
    await settle(bob.d, wsB)
    expect(await authorOf(bob.d, id)).toBeNull()
    // Apply-level: a null from the server keeps a local author.
    const vid = (await alice.d.api.listCollectionVersions(col.id)).find((x) => x.version === '1.0.0')!.id
    expect(await authorOf(alice.d, vid)).not.toBeNull()
    const wire = cloud.wireOf(cloud.entity(vid)!)
    const ctx = makeApplyCtx({ db: alice.d.db, secrets: alice.d.secrets, nowS: 1, effects: [] }, ws)
    applyTx(alice.d.db, () =>
      applyRemoteOp(ctx, { operation_id: 'o1', workspace_id: remoteId, resource_type: 'collection_version', resource_id: vid, op: 'upsert', resulting_version: 1, payload: { ...wire, created_by: null }, occurred_at: '', checkpoint: 99 }),
    )
    expect(await authorOf(alice.d, vid)).toEqual({ id: alice.user.id, name: 'Alice' })
  })

  it('a deleted account keeps its name and loses its id', async () => {
    const { alice, bob, v, wsB } = await aliceAndBob()
    cloud.users.delete(alice.user.id)
    // Force a re-delivery to Bob (a snapshot-like replay of the same version).
    const entity = cloud.entity(v.id)!
    cloud.restUpsert(entity.ws, 'collection_version', v.id, entity.data, { id: alice.user.id, name: 'Alice' })
    await settle(bob.d, wsB)
    expect(await authorOf(bob.d, v.id)).toEqual({ id: null, name: 'Alice' })
  })

  it('an older server (feature absent) leaves authors untouched and downloads unknown authors', async () => {
    cloud.versionAuthors = false
    const alice = await signedIn('alice@example.com', 'Alice')
    const ws = alice.d.workspace.id
    const col = await alice.d.api.createCollection(ws, 'C')
    const v = await alice.d.api.createCollectionVersion({ collectionId: col.id, version: '1.0.0' })
    await alice.d.api.publishWorkspace(ws)
    const st = await settle(alice.d, ws)
    expect(await authorOf(alice.d, v.id)).toEqual({ id: alice.user.id, name: 'Alice' }) // local author kept
    expect((await alice.d.api.getSyncStatus(ws)).openConflicts).toBe(0)
    const bob = await signedIn('bob@example.com', 'Bob')
    cloud.setRole(st.remoteWorkspaceId!, bob.user.id, 'editor')
    const link = await bob.d.api.linkRemoteWorkspace({ remoteWorkspaceId: st.remoteWorkspaceId!, localWorkspaceId: null })
    await settle(bob.d, link.workspace.id)
    expect(await authorOf(bob.d, v.id)).toBeNull()
    // The server upgrades: the next deliveries carry authors, old versions stay unknown, nothing clashes.
    cloud.versionAuthors = true
    const v2 = await alice.d.api.createCollectionVersion({ collectionId: col.id, version: '1.1.0' })
    await settle(alice.d, ws)
    await settle(bob.d, link.workspace.id)
    expect(await authorOf(bob.d, v2.id)).toEqual({ id: alice.user.id, name: 'Alice' })
    // The feature appeared on Bob's link and the log was replayed once: a version the old server stored without an author stays unknown.
    expect(await authorOf(bob.d, v.id)).toBeNull()
    expect((await bob.d.api.getSyncStatus(link.workspace.id)).openConflicts).toBe(0)
    expect(pendingCount(bob.d, link.workspace.id)).toBe(0)
    expect((await alice.d.api.getSyncStatus(ws)).openConflicts).toBe(0)
  })
})

describe('the feature appears on an existing link', () => {
  it('versions already synced to this device get their authors once (the pull is rewound), with no conflict and no upload', async () => {
    const { alice, bob, v, wsB } = await aliceAndBob()
    // This is Bob's device right after the app update: his link was made before it knew the feature, and the versions
    // it holds (pulled earlier) have no author, although the server has recorded them.
    bob.d.db.prepare('UPDATE collection_versions SET created_by_id = NULL, created_by_name = NULL').run()
    bob.d.db.prepare('UPDATE cloud_links SET sync_features = NULL').run()
    expect(await authorOf(bob.d, v.id)).toBeNull()
    const checkpoint = getLink(bob.d.db, wsB)!.sync_checkpoint
    expect(checkpoint).toBeGreaterThan(0)
    cloud.requests.length = 0
    const s = await settle(bob.d, wsB)
    const afters = () => cloud.requests.filter((r) => /sync\/pull$/.test(r.path)).map((r) => r.query.get('after_checkpoint'))
    expect(afters()).toContain('0') // the log was replayed from the start
    expect(await authorOf(bob.d, v.id)).toEqual({ id: alice.user.id, name: 'Alice' })
    expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    expect(getLink(bob.d.db, wsB)!.sync_checkpoint).toBe(checkpoint) // caught up again after the replay
    expect(getEntity(bob.d.db, 'collection_version', v.id)!.base_payload).not.toContain('created_by')
    // One replay only: with the feature known, an unknown author is not replayed again.
    bob.d.db.prepare('UPDATE collection_versions SET created_by_id = NULL, created_by_name = NULL').run()
    cloud.requests.length = 0
    await settle(bob.d, wsB)
    expect(await authorOf(bob.d, v.id)).toBeNull()
    expect(afters()).not.toContain('0')
  })

  it('without versions that lack an author nothing is replayed', async () => {
    const { bob, wsB } = await aliceAndBob()
    bob.d.db.prepare('UPDATE cloud_links SET sync_features = NULL').run()
    const checkpoint = getLink(bob.d.db, wsB)!.sync_checkpoint
    cloud.requests.length = 0
    await settle(bob.d, wsB, 1)
    expect(cloud.requests.filter((r) => /sync\/pull$/.test(r.path)).map((r) => r.query.get('after_checkpoint'))).not.toContain('0')
    expect(getLink(bob.d.db, wsB)!.sync_checkpoint).toBe(checkpoint)
  })
})

describe('resolving an immutable clash keeps the authors', () => {
  /** Alice signed in; her version 3.0.0 clashes with a different cloud copy under the same id, made by Bob. */
  async function sameIdClash() {
    const alice = await signedIn('alice@example.com', 'Alice')
    const bob = cloud.createUser('bob@example.com', 'Bob')
    const ws = alice.d.workspace.id
    const col = await alice.d.api.createCollection(ws, 'C')
    await alice.d.api.publishWorkspace(ws)
    const st = await settle(alice.d, ws)
    const mine = await alice.d.api.createCollectionVersion({ collectionId: col.id, version: '3.0.0', notes: 'mine' })
    expect(mine.createdBy).toEqual({ id: alice.user.id, name: 'Alice' })
    const wire = { collection_id: col.id, semver: '3.0.0', notes: 'cloud copy', snapshot_json: '{}', folder_count: 0, request_count: 0, created_at: '2026-01-01T00:00:00.000Z' }
    cloud.beforePush = (w) => void cloud.restUpsert(w, 'collection_version', mine.id, wire, { id: bob.id, name: 'Bob' })
    await alice.d.core.sync.syncNow(ws)
    await settle(alice.d, ws)
    const [c] = await alice.d.api.listSyncConflicts(ws)
    expect(c).toMatchObject({ kind: 'immutable_clash', entityId: mine.id })
    return { alice, bob, ws, col, mine, c: c!, remoteId: st.remoteWorkspaceId! }
  }

  it('the clash keeps the cloud author next to the conflict, never inside the conflict copies', async () => {
    const { alice, mine } = await sameIdClash()
    const row = alice.d.db.prepare("SELECT remote_author, remote_json, local_json FROM sync_conflicts WHERE entity_id = ? AND status = 'open'").get(mine.id) as { remote_author: string; remote_json: string; local_json: string }
    expect(JSON.parse(row.remote_author)).toMatchObject({ name: 'Bob' })
    expect(row.remote_json).not.toContain('created_by')
    expect(row.local_json).not.toContain('created_by')
  })

  it('keep cloud: the version taken from the cloud shows the cloud author', async () => {
    const { alice, bob, ws, col, mine, c } = await sameIdClash()
    await alice.d.api.resolveSyncConflict({ conflictId: c.id, resolution: 'keep_remote' })
    const s = await settle(alice.d, ws)
    expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    const [v] = await alice.d.api.listCollectionVersions(col.id)
    expect(v).toMatchObject({ id: mine.id, notes: 'cloud copy', createdBy: { id: bob.id, name: 'Bob' } })
  })

  it('duplicate: the new label keeps the creator of the local version, and "keep cloud" side keeps the cloud author', async () => {
    const { alice, bob, ws, col, mine, c } = await sameIdClash()
    await alice.d.api.resolveSyncConflict({ conflictId: c.id, resolution: 'duplicate', newVersion: '3.0.1' })
    const s = await settle(alice.d, ws)
    expect(s).toMatchObject({ openConflicts: 0, pendingChanges: 0 })
    const byLabel = Object.fromEntries((await alice.d.api.listCollectionVersions(col.id)).map((v) => [v.version, v]))
    expect(byLabel['3.0.0']).toMatchObject({ id: mine.id, notes: 'cloud copy', createdBy: { id: bob.id, name: 'Bob' } })
    expect(byLabel['3.0.1']).toMatchObject({ notes: 'mine', createdBy: { id: alice.user.id, name: 'Alice' } })
  })

  it('a label clash under another id: duplicate keeps the local creator', async () => {
    const alice = await signedIn('alice@example.com', 'Alice')
    const ws = alice.d.workspace.id
    const col = await alice.d.api.createCollection(ws, 'C')
    await alice.d.api.publishWorkspace(ws)
    await settle(alice.d, ws)
    const mine = await alice.d.api.createCollectionVersion({ collectionId: col.id, version: '2.0.0', notes: 'mine' })
    cloud.beforePush = (w) =>
      void cloud.restUpsert(w, 'collection_version', '0190aaaa-0000-7000-8000-000000000003', { collection_id: col.id, semver: '2.0.0', notes: 'theirs', snapshot_json: '{}', folder_count: 0, request_count: 0, created_at: '2026-01-01T00:00:00.000Z' }, { id: 'u-other', name: 'Other' })
    await alice.d.core.sync.syncNow(ws)
    const [c] = await alice.d.api.listSyncConflicts(ws)
    expect(c).toMatchObject({ kind: 'immutable_clash', entityId: mine.id })
    await alice.d.api.resolveSyncConflict({ conflictId: c!.id, resolution: 'duplicate', newVersion: '2.0.1' })
    await settle(alice.d, ws)
    const byLabel = Object.fromEntries((await alice.d.api.listCollectionVersions(col.id)).map((v) => [v.version, v]))
    expect(byLabel['2.0.1']).toMatchObject({ notes: 'mine', createdBy: { id: alice.user.id, name: 'Alice' } })
    expect(byLabel['2.0.0']).toMatchObject({ notes: 'theirs', createdBy: { name: 'Other' } })
  })
})

describe('apply level', () => {
  it('a re-delivered version with created_by is not an immutable clash, and the stored base has no author', async () => {
    const { alice, v, ws, remoteId } = await aliceAndBob()
    const wire = cloud.wireOf(cloud.entity(v.id)!)
    const ctx = makeApplyCtx({ db: alice.d.db, secrets: alice.d.secrets, nowS: 1, effects: [] }, ws)
    applyTx(alice.d.db, () => {
      applySnapshotEntity(ctx, { resource_type: 'collection_version', resource_id: v.id, version: 1, payload: { ...wire, created_by: { id: 'u9', display_name: 'Zed' } } })
      applyRemoteOp(ctx, { operation_id: 'o2', workspace_id: remoteId, resource_type: 'collection_version', resource_id: v.id, op: 'upsert', resulting_version: 2, payload: { ...wire, created_by: { id: 'u9', display_name: 'Zed' } }, occurred_at: '', checkpoint: 100 })
    })
    expect(alice.d.db.prepare("SELECT COUNT(*) AS n FROM sync_conflicts WHERE status = 'open'").get()).toEqual({ n: 0 })
    expect(alice.d.db.prepare('SELECT deleted FROM collection_versions WHERE id = ?').get(v.id)).toEqual({ deleted: 0 })
    expect(await authorOf(alice.d, v.id)).toEqual({ id: 'u9', name: 'Zed' })
    expect(getEntity(alice.d.db, 'collection_version', v.id)!.base_payload).not.toContain('created_by')
    expect(ctx.changed.get(`collection_version:${v.id}`)).toMatchObject({ change: 'upsert' })
    expect(pendingCount(alice.d, ws)).toBe(0)
  })

  it('a real content clash is still an immutable clash, its conflict copies carry no author and the local author is not overwritten', async () => {
    const { alice, v, ws, remoteId } = await aliceAndBob()
    const wire = cloud.wireOf(cloud.entity(v.id)!)
    const ctx = makeApplyCtx({ db: alice.d.db, secrets: alice.d.secrets, nowS: 1, effects: [] }, ws)
    applyTx(alice.d.db, () =>
      applyRemoteOp(ctx, { operation_id: 'o3', workspace_id: remoteId, resource_type: 'collection_version', resource_id: v.id, op: 'upsert', resulting_version: 2, payload: { ...wire, notes: 'different', created_by: { id: 'u9', display_name: 'Zed' } }, occurred_at: '', checkpoint: 101 }),
    )
    const c = alice.d.db.prepare("SELECT kind, local_json, remote_json FROM sync_conflicts WHERE status = 'open'").get() as { kind: string; local_json: string; remote_json: string }
    expect(c.kind).toBe('immutable_clash')
    expect(c.local_json).not.toContain('created_by')
    expect(c.remote_json).not.toContain('created_by')
    expect(JSON.parse(c.remote_json).notes).toBe('different')
    const row = alice.d.db.prepare('SELECT created_by_name FROM collection_versions WHERE id = ?').get(v.id) as { created_by_name: string }
    expect(row.created_by_name).toBe('Alice')
  })

  it('hideClashingVersion strips the author from a handed-in server copy (immutable rejection)', async () => {
    const { alice, v, ws } = await aliceAndBob()
    const wire = cloud.wireOf(cloud.entity(v.id)!)
    const ctx = makeApplyCtx({ db: alice.d.db, secrets: alice.d.secrets, nowS: 1, effects: [] }, ws)
    const row = alice.d.db.prepare('SELECT * FROM collection_versions WHERE id = ?').get(v.id) as Record<string, string | number | null>
    applyTx(alice.d.db, () => hideClashingVersion(ctx, row, { remote: { ...wire, created_by: { id: 'u', display_name: 'n' } }, remoteVersion: 1 }))
    const c = alice.d.db.prepare("SELECT remote_json FROM sync_conflicts WHERE status = 'open'").get() as { remote_json: string }
    expect(c.remote_json).not.toContain('created_by')
  })

  it('writing an author never marks the version dirty (triggers watch only `deleted`)', async () => {
    const { alice, v, ws } = await aliceAndBob()
    alice.d.db.prepare("UPDATE collection_versions SET created_by_id = NULL, created_by_name = 'X' WHERE id = ?").run(v.id)
    expect(pendingCount(alice.d, ws)).toBe(0)
  })
})
