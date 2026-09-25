/**
 * Two-device convergence against the REAL server: the same seeded fuzzer as the fake-server suite
 * (electron/__tests__/sync/convergence.test.ts) with the invariants checked against the server's own snapshot.
 * SYNC_IT_SEEDS=<n> (default 6, starting at SYNC_IT_SEED_FROM, default 1) or SEED=<n> to reproduce one seed. The server
 * allows 30 device sign-ins per 5 minutes per IP (2 per seed), so explore in batches of at most 12 seeds per run.
 * A third writer (REST) races some pushes, so the v2 rejection paths run against the real server too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { canonicalJson } from '../../sync/mapping'
import { DOC, liveState, makeDevice, pendingCount, type Device } from '../sync/harness'
import { mulberry32, randomOp, resolveAll } from '../sync/fuzzKit'
import { RealCloud, signInDevice } from './realCloud'

const enabled = !!process.env.SLINGER_SYNC_IT_SERVER_DIR
const PASSWORD = 'sync-it-user-passphrase-1'
const seedCount = Number(process.env.SYNC_IT_SEEDS ?? 6)
const seedFrom = Number(process.env.SYNC_IT_SEED_FROM ?? 1)
const seeds = process.env.SEED ? [Number(process.env.SEED)] : Array.from({ length: seedCount }, (_, i) => seedFrom + i)

describe.skipIf(!enabled)('two-device convergence against the real server', () => {
  let cloud: RealCloud
  let ownerToken: string
  const devices: Device[] = []

  beforeAll(async () => {
    cloud = await RealCloud.start()
    const admin = await cloud.adminToken()
    await cloud.createUser(admin, 'fuzz@it.test', PASSWORD)
    ownerToken = await cloud.login('fuzz@it.test', PASSWORD)
  })
  afterAll(async () => {
    devices.forEach((d) => d.cleanup())
    await cloud?.stop()
  })

  /**
   * A third writer (dashboard REST, same account) that changes the server right before a device's next push, so
   * pushes meet the v2 rejections (version_mismatch + current_payload, not_found, "folder does not exist").
   */
  let race: (() => Promise<void>) | null = null
  const racing: typeof fetch = async (input, init) => {
    if (race && String(input).includes('/sync/push')) {
      const r = race
      race = null
      await r()
    }
    return fetch(input, init)
  }
  function armThirdWriter(remoteId: string, rnd: () => number, n: number): void {
    race = async () => {
      const pool = (await cloud.snapshotAll(remoteId, ownerToken)).filter((e) => ['collection', 'folder', 'request'].includes(e.resource_type))
      if (!pool.length) return
      const e = pool[Math.floor(rnd() * pool.length)]!
      const path = `/v1/workspaces/${remoteId}/${e.resource_type === 'collection' ? 'collections' : e.resource_type === 'folder' ? 'folders' : 'requests'}/${e.resource_id}`
      const x = rnd()
      let res
      if (x < 0.5) res = await cloud.call('PATCH', path, { token: ownerToken, body: { name: `W${n}`, version: e.version } })
      else if (x < 0.75 && e.resource_type !== 'collection') res = await cloud.call('PATCH', path, { token: ownerToken, body: { sort_order: Math.floor(rnd() * 6), version: e.version } })
      else if (e.resource_type !== 'collection') res = await cloud.call('DELETE', path, { token: ownerToken })
      if (res && res.status >= 300) throw new Error(`third writer ${path}: ${res.text}`)
    }
  }

  async function pair() {
    const a = makeDevice(cloud, { signedIn: false, deviceName: 'A', fetchImpl: racing })
    const b = makeDevice(cloud, { signedIn: false, deviceName: 'B', fetchImpl: racing })
    devices.push(a, b)
    await signInDevice(a, cloud, 'fuzz@it.test', PASSWORD)
    await signInDevice(b, cloud, 'fuzz@it.test', PASSWORD)
    const ws = a.workspace.id
    for (let i = 0; i < 2; i++) {
      const c = await a.api.createCollection(ws, `Seed ${i}`)
      const f = await a.api.createFolder({ workspaceId: ws, collectionId: c.id, name: `SF ${i}` })
      await a.api.createFolder({ workspaceId: ws, collectionId: c.id, parentFolderId: f.id, name: `SFS ${i}` })
      for (let j = 0; j < 3; j++) await a.api.createRequest({ workspaceId: ws, collectionId: c.id, folderId: j === 0 ? null : f.id, name: `SR ${i}.${j}`, method: 'GET', url: `https://s/${i}/${j}`, documentJson: DOC })
    }
    const e = await a.api.createEnvironment(ws, 'Seed env')
    await a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'k0', value: 'v', isSecret: false })
    await a.api.upsertEnvironmentVariable({ environmentId: e.id, key: 'k1', value: 'SECRET-seed', isSecret: true })
    await a.api.publishWorkspace(ws)
    const st = await a.core.sync.syncNow(ws)
    const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: st.remoteWorkspaceId!, localWorkspaceId: null })
    await b.core.sync.syncNow(link.workspace.id)
    return { a, b, wsA: ws, wsB: link.workspace.id, remoteId: st.remoteWorkspaceId! }
  }

  for (const seed of seeds) {
    it(`seed ${seed} converges to identical content that equals the server`, async () => {
      const rnd = mulberry32(seed)
      const p = await pair()
      let n = 0
      for (let round = 0; round < 5; round++) {
        for (const [d, ws] of [[p.a, p.wsA], [p.b, p.wsB]] as const) {
          const k = 2 + Math.floor(rnd() * 5)
          for (let i = 0; i < k; i++) await randomOp(d, ws, rnd, ++n)
        }
        if (rnd() < 0.4) armThirdWriter(p.remoteId, rnd, ++n)
        const mode = rnd()
        if (mode < 0.35) { await p.a.core.sync.syncNow(p.wsA); await p.b.core.sync.syncNow(p.wsB) }
        else if (mode < 0.7) { await p.b.core.sync.syncNow(p.wsB); await p.a.core.sync.syncNow(p.wsA) }
        else if (mode < 0.85) await p.a.core.sync.syncNow(p.wsA)
      }
      race = null
      for (let i = 0; i < 12; i++) {
        for (let r = 0; r < 2; r++) {
          await p.a.core.sync.syncNow(p.wsA)
          await p.b.core.sync.syncNow(p.wsB)
        }
        const resolved = (await resolveAll(p.a, p.wsA, rnd)) + (await resolveAll(p.b, p.wsB, rnd))
        const sa = await p.a.api.getSyncStatus(p.wsA)
        const sb = await p.b.api.getSyncStatus(p.wsB)
        if (resolved === 0 && sa.pendingChanges + sb.pendingChanges + sa.openConflicts + sb.openConflicts === 0) break
      }
      const norm = (xs: Array<{ type: string; id: string; wire: unknown }>) => xs.map((x) => `${x.type}:${x.id}:${canonicalJson(x.wire)}`).sort()
      const a = norm(liveState(p.a, p.wsA))
      const b = norm(liveState(p.b, p.wsB))
      const server = (await cloud.snapshotAll(p.remoteId, ownerToken)).map((e) => `${e.resource_type}:${e.resource_id}:${canonicalJson(e.payload)}`).sort()
      const diff = (x: string[], y: string[]) => x.filter((v) => !new Set(y).has(v))
      expect(diff(a, b), 'only on A').toEqual([])
      expect(diff(b, a), 'only on B').toEqual([])
      expect(diff(a, server), 'devices vs server').toEqual([])
      expect(diff(server, a), 'server vs devices').toEqual([])
      expect(pendingCount(p.a, p.wsA) + pendingCount(p.b, p.wsB)).toBe(0)
      expect(cloud.server.dump()).not.toContain('SECRET-')
    })
  }
})
