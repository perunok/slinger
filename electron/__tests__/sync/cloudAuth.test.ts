import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tokenKey } from '../../cloud/auth'
import { assertGenericSecureKey } from '../../services/secrets'
import { FakeCloud } from './fakeCloud'
import { makeDevice, type Device } from './harness'

let cloud: FakeCloud
let d: Device
beforeEach(async () => {
  cloud = await new FakeCloud().start()
})
afterEach(async () => {
  d?.cleanup()
  await cloud.stop()
})

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('cloud config', () => {
  it('has defaults, persists, normalises the URL and only accepts http(s)', async () => {
    d = makeDevice(cloud, {})
    const fresh = makeDevice(cloud, { deviceName: 'Laptop' })
    fresh.cleanup()
    expect((await d.api.getCloudConfig()).apiBaseUrl).toBe(cloud.baseUrl)
    const saved = await d.core.sync.setCloudConfig({ apiBaseUrl: ' http://localhost:9999/// ', deviceName: ' My Mac ' })
    expect(saved).toEqual({ apiBaseUrl: 'http://localhost:9999', deviceName: 'My Mac' })
    expect(await d.core.sync.getCloudConfig()).toEqual(saved)
    await expect(d.core.sync.setCloudConfig({ apiBaseUrl: 'ftp://x', deviceName: 'n' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(d.core.sync.setCloudConfig({ apiBaseUrl: 'not a url', deviceName: 'n' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('the default points at the production API', () => {
    const db = makeDevice(cloud, {})
    db.db.prepare("DELETE FROM app_settings WHERE key = 'cloud.config'").run()
    d = db
    return expect(db.core.sync.getCloudConfig()).resolves.toMatchObject({ apiBaseUrl: 'https://api.slinger.app' })
  })
})

describe('device sign-in', () => {
  it('walks the device flow in main: tokens go to the keychain only, the renderer never sees them', async () => {
    const user = cloud.createUser('ana@example.com', 'Ana')
    d = makeDevice(cloud, {})
    const start = await d.api.startCloudSignIn()
    expect(start).toMatchObject({ verificationUri: expect.stringContaining('/device'), intervalSec: 1 })
    expect(start.userCode).toMatch(/^SL-/)
    expect(JSON.stringify(start)).not.toMatch(/device_code|dc_/)
    expect((await d.api.getCloudSession()).status).toBe('signingIn')

    d.timers.advance(1000) // first poll: still pending, no approval yet
    await until(() => cloud.requestsTo(/device\/poll$/).length === 1)
    // The next poll is armed only once the previous one has been answered and handled: wait for that, do not race it.
    await until(() => d.timers.count === 1)
    expect((await d.api.getCloudSession()).status).toBe('signingIn')

    cloud.approveDevice(start.userCode, user.id)
    d.timers.advance(1000)
    await until(() => d.events.some((e) => e.type === 'signInResult'))
    expect(d.events.find((e) => e.type === 'signInResult')).toMatchObject({ result: 'approved' })
    const session = await d.api.getCloudSession()
    expect(session).toMatchObject({ status: 'signedIn', user: { email: 'ana@example.com', displayName: 'Ana' } })
    expect(JSON.stringify(session)).not.toMatch(/access|refresh|token/i)
    const stored = JSON.parse(d.secrets.get(tokenKey(cloud.baseUrl))!) as Record<string, string>
    expect(Object.keys(stored).sort()).toEqual(['accessToken', 'refreshToken'])
    // tokens are not readable through the generic renderer keychain passthrough
    await expect(d.api.secureStoreGet(tokenKey(cloud.baseUrl))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(d.api.secureStoreSet('slinger.cloud.tokens:evil', 'x')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(() => assertGenericSecureKey('SLINGER.CLOUD.TOKENS:x')).toThrow()
    // and the session works with the stored tokens
    expect(await d.api.listRemoteWorkspaces()).toEqual([])
  })

  it('reports expiry when nobody approves in time', async () => {
    d = makeDevice(cloud, {})
    await d.api.startCloudSignIn()
    d.clock.advance(601_000)
    d.timers.advance(1000)
    await until(() => d.events.some((e) => e.type === 'signInResult'))
    expect(d.events.find((e) => e.type === 'signInResult')).toMatchObject({ result: 'expired' })
    expect((await d.api.getCloudSession()).status).toBe('signedOut')
  })

  it('cancel stops polling and announces it', async () => {
    d = makeDevice(cloud, {})
    await d.api.startCloudSignIn()
    await d.api.cancelCloudSignIn()
    expect(d.events.find((e) => e.type === 'signInResult')).toMatchObject({ result: 'cancelled' })
    d.timers.advance(10_000)
    expect(cloud.requestsTo(/device\/poll$/)).toHaveLength(0)
    expect(d.timers.count).toBe(0)
  })

  it('sign-out revokes the refresh token, deletes the tokens and keeps links', async () => {
    const user = cloud.createUser('ana@example.com')
    d = makeDevice(cloud, { userId: user.id })
    await d.api.publishWorkspace(d.workspace.id)
    await d.core.sync.syncNow(d.workspace.id)
    await d.api.signOutCloud()
    expect(cloud.requestsTo(/auth\/logout$/)).toHaveLength(1)
    expect(d.secrets.get(tokenKey(cloud.baseUrl))).toBeNull()
    expect((await d.api.getCloudSession()).status).toBe('signedOut')
    expect((await d.api.getSyncStatus(d.workspace.id))).toMatchObject({ linked: true, state: 'signedOut' })
  })

  it('changing the API base URL drops the in-memory session of the old server', async () => {
    const user = cloud.createUser('ana@example.com')
    d = makeDevice(cloud, { userId: user.id })
    expect((await d.api.getCloudSession()).status).toBe('signedIn')
    await d.core.sync.setCloudConfig({ apiBaseUrl: 'http://127.0.0.1:1', deviceName: 'x' })
    expect((await d.api.getCloudSession()).status).toBe('signedOut')
    await d.core.sync.setCloudConfig({ apiBaseUrl: cloud.baseUrl, deviceName: 'x' })
    expect((await d.api.getCloudSession()).status).toBe('signedIn')
  })
})
