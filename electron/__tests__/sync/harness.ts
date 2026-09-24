import type { SyncEvent, SyncStatus, Workspace } from '../../../shared/types'
import { openDatabase, type Db } from '../../db/database'
import { createIpcApi } from '../../ipc/api'
import type { Clock, Timers } from '../../lib/clock'
import { createCore, type Core } from '../../services/core'
import { ExportFiles } from '../../services/exportFiles'
import { MemorySecretStore } from '../../services/secrets'
import { tokenKey } from '../../cloud/auth'
import { SYNC_ENTITY_TYPES } from '../../sync/types'
import type { Payload, SyncEntityType } from '../../sync/types'
import { TABLE, toWire, type AnyRow } from '../../sync/mapping'
import { MIGRATIONS_DIR } from '../helpers'
import { FakeCloud } from './fakeCloud'

export class FakeClock implements Clock {
  constructor(public t = 1_800_000_000_000) {}
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

/** Manual timers: `advance(ms)` moves the clock and fires everything that became due, in order. */
export class FakeTimers implements Timers {
  private next = 1
  private pending = new Map<number, { at: number; fn: () => void }>()
  constructor(private readonly clock: FakeClock) {}
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++
    this.pending.set(id, { at: this.clock.t + ms, fn })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number)
  }
  get count(): number {
    return this.pending.size
  }
  advance(ms: number): void {
    const target = this.clock.t + ms
    for (;;) {
      const due = [...this.pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.pending.delete(due[0])
      this.clock.t = Math.max(this.clock.t, due[1].at)
      due[1].fn()
    }
    this.clock.t = target
  }
}

export interface Device {
  db: Db
  core: Core
  secrets: MemorySecretStore
  api: ReturnType<typeof createIpcApi>
  events: SyncEvent[]
  clock: FakeClock
  timers: FakeTimers
  workspace: Workspace
  cleanup(): void
  statusEvents(): SyncStatus[]
}

export interface DeviceOptions {
  userId?: string
  signedIn?: boolean
  clock?: FakeClock
  fetchImpl?: typeof fetch
  httpTimeoutMs?: number
  deviceName?: string
}

/** One desktop "install": own SQLite, own keychain, own sync client, talking to `cloud` over real HTTP. */
export function makeDevice(cloud: FakeCloud, opts: DeviceOptions = {}): Device {
  const db = openDatabase(':memory:')
  const secrets = new MemorySecretStore()
  const events: SyncEvent[] = []
  const clock = opts.clock ?? new FakeClock(Date.now())
  const timers = new FakeTimers(clock)
  const core = createCore({
    db,
    secrets,
    migrationsDir: MIGRATIONS_DIR,
    exportFiles: new ExportFiles(),
    sync: {
      emit: (e) => events.push(e),
      appVersion: '0.0.0-test',
      clock,
      timers,
      fetchImpl: opts.fetchImpl,
      httpTimeoutMs: opts.httpTimeoutMs ?? 5_000,
      defaultDeviceName: opts.deviceName ?? 'Test device',
      random: () => 0.5,
    },
  })
  const api = createIpcApi(core, { appVersion: '0', openExternal: async () => {}, chooseDirectory: async () => null, pickFile: async () => null })
  if (opts.userId && opts.signedIn !== false) {
    const t = cloud.issueTokens(opts.userId)
    secrets.set(tokenKey(cloud.baseUrl), JSON.stringify({ accessToken: t.accessToken, refreshToken: t.refreshToken }))
  }
  core.sync.auth.setConfig({ apiBaseUrl: cloud.baseUrl, deviceName: opts.deviceName ?? 'Test device' })
  const workspace = core.workspaces.list()[0]!
  return {
    db, core, secrets, api, events, clock, timers, workspace,
    cleanup() {
      core.sync.stop()
      db.close()
    },
    statusEvents: () => events.filter((e): e is Extract<SyncEvent, { type: 'status' }> => e.type === 'status').map((e) => e.status),
  }
}

export interface EntitySnapshot {
  type: SyncEntityType
  id: string
  wire: Payload
}

/** Live content of a workspace as wire payloads (no secret values), sorted by (type, id). */
export function liveState(dev: Device, workspaceId: string): EntitySnapshot[] {
  const out: EntitySnapshot[] = []
  for (const type of SYNC_ENTITY_TYPES) {
    const rows = dev.db.prepare(`SELECT * FROM ${TABLE[type]} WHERE deleted = 0 ORDER BY id`).all() as AnyRow[]
    for (const r of rows) {
      const ws =
        type === 'environment_variable'
          ? (dev.db.prepare('SELECT workspace_id FROM environments WHERE id = ?').get(r.environment_id) as { workspace_id: string }).workspace_id
          : (r.workspace_id as string)
      if (ws === workspaceId) out.push({ type, id: r.id as string, wire: toWire(type, r) })
    }
  }
  return out
}

export const DOC = JSON.stringify({ headers: [], body: null })

/** Sync one device to quiescence (a few cycles, as in the app). */
export async function settle(dev: Device, workspaceId: string, rounds = 3): Promise<SyncStatus> {
  let status = await dev.core.sync.syncNow(workspaceId)
  for (let i = 1; i < rounds; i++) status = await dev.core.sync.syncNow(workspaceId)
  return status
}

export function pendingCount(dev: Device, workspaceId: string): number {
  return (dev.db.prepare('SELECT COUNT(*) AS n FROM sync_dirty WHERE workspace_id = ?').get(workspaceId) as { n: number }).n
}

export interface Pair {
  cloud: FakeCloud
  a: Device
  b: Device
  wsA: string
  wsB: string
  remoteId: string
  userId: string
}

/** Two devices of one user on one cloud workspace: A published (after `seed`), B downloaded it. */
export async function makePair(cloud: FakeCloud, seed: (a: Device, ws: string) => Promise<void>, opts: { second?: { userId?: string } } = {}): Promise<Pair> {
  const user = cloud.createUser(`u${cloud.users.size}@example.com`)
  const a = makeDevice(cloud, { userId: user.id, deviceName: 'A' })
  await seed(a, a.workspace.id)
  await a.api.publishWorkspace(a.workspace.id)
  const st = await settle(a, a.workspace.id)
  const b = makeDevice(cloud, { userId: opts.second?.userId ?? user.id, deviceName: 'B' })
  const link = await b.api.linkRemoteWorkspace({ remoteWorkspaceId: st.remoteWorkspaceId!, localWorkspaceId: null })
  await settle(b, link.workspace.id)
  return { cloud, a, b, wsA: a.workspace.id, wsB: link.workspace.id, remoteId: st.remoteWorkspaceId!, userId: user.id }
}

/** Sync both devices until neither has anything left to say. */
export async function converge(p: Pair, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await p.a.core.sync.syncNow(p.wsA)
    await p.b.core.sync.syncNow(p.wsB)
  }
}
