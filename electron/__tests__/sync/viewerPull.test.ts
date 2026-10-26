import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCloud } from './fakeCloud'
import { mulberry32, randomOp } from './fuzzKit'
import { DOC, makeDevice, makePair, settle, type Device, type Pair } from './harness'

let cloud: FakeCloud
let pair: Pair | null = null
let viewer: Device | null = null
beforeEach(async () => {
  cloud = await new FakeCloud().start()
})
afterEach(async () => {
  pair?.a.cleanup()
  pair?.b.cleanup()
  viewer?.cleanup()
  pair = null
  viewer = null
  await cloud.stop()
})

describe('a viewer pulls every kind of change without a sync error', () => {
  it.each(Array.from({ length: 12 }, (_, i) => i + 1))('random owner edits, seed %i', async (seed) => {
    pair = await makePair(cloud, async (a, ws) => {
      const c = await a.api.createCollection(ws, 'Shop')
      await a.api.createRequest({ workspaceId: ws, collectionId: c.id, name: 'R', method: 'GET', url: 'https://x', documentJson: DOC })
      await a.api.createEnvironment(ws, 'Prod')
    })
    const v = cloud.createUser(`viewer${seed}@x.com`)
    cloud.setRole(pair.remoteId, v.id, 'viewer')
    viewer = makeDevice(cloud, { userId: v.id, deviceName: 'V' })
    const link = await viewer.api.linkRemoteWorkspace({ remoteWorkspaceId: pair.remoteId, localWorkspaceId: null })
    const wsV = link.workspace.id
    let st = await settle(viewer, wsV)
    expect(st).toMatchObject({ readOnly: true, lastError: null })
    const rnd = mulberry32(seed * 7907)
    for (let round = 0; round < 8; round++) {
      for (let i = 0; i < 6; i++) await randomOp(pair.a, pair.wsA, rnd, round * 10 + i)
      await settle(pair.a, pair.wsA)
      st = await viewer.core.sync.syncNow(wsV)
      expect(st.lastError, `seed ${seed} round ${round}: ${JSON.stringify(st.lastError)}`).toBeNull()
      expect(st.state).not.toBe('error')
    }
  })
})

describe('a failure on the server is explained, not shown as a bare "internal server error"', () => {
  it('HTTP 500 on pull: the message says what it means; the next sync recovers', async () => {
    pair = await makePair(cloud, async (a, ws) => void (await a.api.createCollection(ws, 'Shop')))
    const { b, wsB } = pair
    cloud.faults.push({ match: /GET .*sync\/pull/, action: 'status', status: 500, body: { error: { code: 'internal_error', message: 'internal server error' } } })
    const st = await b.core.sync.syncNow(wsB)
    expect(st.state).toBe('error')
    expect(st.lastError?.message).toBe(
      "The Slinger Cloud server ran into an error (HTTP 500) (internal server error). Your changes are kept on this device; sync retries automatically. If it keeps happening, ask its administrator to check the server's logs and free disk space.",
    )
    const again = await b.core.sync.syncNow(wsB)
    expect(again.lastError).toBeNull()
  })

  it('502/503 say the server is not answering', async () => {
    pair = await makePair(cloud, async (a, ws) => void (await a.api.createCollection(ws, 'Shop')))
    cloud.faults.push({ match: /GET .*sync\/pull/, action: 'status', status: 503, body: 'Service Unavailable' })
    const st = await pair.b.core.sync.syncNow(pair.wsB)
    expect(st.lastError?.message).toMatch(/^The Slinger Cloud server is not answering \(HTTP 503\)\. Your changes are kept/)
  })
})
