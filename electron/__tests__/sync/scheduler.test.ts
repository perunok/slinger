import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCloud } from './fakeCloud'
import { makeDevice, settle, type Device } from './harness'

let cloud: FakeCloud
let d: Device
let ws: string
beforeEach(async () => {
  cloud = await new FakeCloud().start()
  const user = cloud.createUser('a@x.com')
  d = makeDevice(cloud, { userId: user.id })
  ws = d.workspace.id
  await d.api.publishWorkspace(ws)
  await settle(d, ws)
  cloud.clearRecorded()
})
afterEach(async () => {
  d.core.sync.stop()
  await idle()
  d.cleanup()
  await cloud.stop()
})

const running = () => d.core.sync.engine.rt(ws).running
const cycles = () => cloud.requestsTo(/sync\/pull$/).length
async function idle() {
  while (running()) await running()
}

describe('auto sync scheduling', () => {
  it('a local edit is picked up by the 5 s poll and pushed after the 1.5 s debounce', async () => {
    d.core.sync.start()
    d.timers.advance(2_000) // start-up cycle
    await idle()
    cloud.clearRecorded()
    await d.api.createCollection(ws, 'Auto')
    d.timers.advance(2_999)
    expect(cycles()).toBe(0)
    d.timers.advance(1) // the 5 s poll sees the dirty row and arms the debounce
    expect(cycles()).toBe(0)
    d.timers.advance(1_499)
    expect(running()).toBeNull()
    d.timers.advance(1)
    await idle()
    expect(cloud.live(d.core.sync.engine.status(ws).remoteWorkspaceId!, 'collection')).toHaveLength(1)
    expect(d.core.sync.engine.status(ws).pendingChanges).toBe(0)
  })

  it('runs a full pull cycle every 60 s while focused and every 5 min while blurred', async () => {
    d.core.sync.start()
    d.timers.advance(2_000) // the start-up cycle
    await idle()
    const afterStart = cycles()
    expect(afterStart).toBe(1)
    d.timers.advance(59_000)
    await idle()
    expect(cycles()).toBe(afterStart)
    d.timers.advance(6_000)
    await idle()
    expect(cycles()).toBe(afterStart + 1)
    d.core.sync.notifyFocus(false) // blur
    const base = cycles()
    for (let i = 0; i < 25; i++) {
      d.timers.advance(10_000) // 250 s
      await idle()
    }
    expect(cycles()).toBe(base)
    for (let i = 0; i < 6; i++) {
      d.timers.advance(10_000)
      await idle()
    }
    expect(cycles()).toBe(base + 1)
  })

  it('focus, resume and online events sync immediately, ignoring backoff', async () => {
    cloud.faults.push({ match: /./, action: 'status', status: 503, times: 1 })
    await d.core.sync.syncNow(ws)
    expect(d.core.sync.engine.status(ws).nextRetryAt).not.toBeNull()
    d.core.sync.notifyResume()
    await idle()
    expect(d.core.sync.engine.status(ws)).toMatchObject({ state: 'idle', nextRetryAt: null })
    d.core.sync.notifyFocus(false)
    const n = cycles()
    d.core.sync.notifyFocus(true)
    await idle()
    expect(cycles()).toBeGreaterThan(n)
    const m = cycles()
    d.core.sync.notifyOnline()
    await idle()
    expect(cycles()).toBeGreaterThan(m)
  })

  it('does not retry while backing off; retries once the delay has passed', async () => {
    d.core.sync.start()
    await d.api.createCollection(ws, 'Retry me')
    cloud.faults.push({ match: /./, action: 'status', status: 503, times: 1 })
    d.timers.advance(6_500)
    await idle()
    const failed = d.core.sync.engine.status(ws)
    expect(failed.state).toBe('error')
    const n = cycles()
    d.timers.advance(3_000) // inside the 5 s backoff
    await idle()
    expect(cycles()).toBe(n)
    d.timers.advance(6_000)
    await idle()
    d.timers.advance(2_000)
    await idle()
    expect(d.core.sync.engine.status(ws)).toMatchObject({ state: 'idle', pendingChanges: 0 })
  })

  it('auto sync off: nothing runs by itself, pending changes still count, syncNow still works', async () => {
    await d.api.setAutoSync(ws, false)
    d.core.sync.start()
    await d.api.createCollection(ws, 'Manual')
    d.timers.advance(400_000)
    await idle()
    expect(cycles()).toBe(0)
    expect(d.core.sync.engine.status(ws)).toMatchObject({ autoSync: false, pendingChanges: 1 })
    const s = await d.api.syncNow(ws)
    expect(s.pendingChanges).toBe(0)
    await d.api.setAutoSync(ws, true)
    expect((await d.api.getSyncStatus(ws)).autoSync).toBe(true)
  })

  it('announces local edits with a status event (pending count) even when auto sync is off', async () => {
    await d.api.setAutoSync(ws, false)
    d.core.sync.start()
    d.timers.advance(1_000) // first sight: nothing to announce yet
    d.events.length = 0
    await d.api.createCollection(ws, 'Edit 1')
    await d.api.createCollection(ws, 'Edit 2')
    d.timers.advance(1_000)
    const statuses = d.statusEvents()
    expect(statuses).toHaveLength(1) // debounced: two edits, one event
    expect(statuses[0]).toMatchObject({ pendingChanges: 2, autoSync: false, state: 'idle' })
    d.timers.advance(1_000)
    expect(d.statusEvents()).toHaveLength(1) // unchanged counts are not re-announced
    await d.api.syncNow(ws)
    expect(d.statusEvents().at(-1)).toMatchObject({ pendingChanges: 0 })
  })

  it('stop() cancels every timer', () => {
    d.core.sync.start()
    d.core.sync.stop()
    expect(d.timers.count).toBe(0)
  })
})
