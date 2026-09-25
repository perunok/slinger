import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeEnv, NIL_UUID, type TestEnv } from './helpers'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

describe('browser auth callback', () => {
  it('binds loopback only and resolves wait() with the query parameters', async () => {
    const { callbackId, redirectUrl } = await env.api.prepareBrowserAuthCallback()
    expect(redirectUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+/auth/callback/${callbackId}$`))
    const waiting = env.api.waitForBrowserAuthCallback(callbackId, 5000)
    const res = await fetch(`${redirectUrl}?code=abc%20123&state=xyz`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Authorization received')
    expect(await waiting).toEqual({ code: 'abc 123', state: 'xyz' })
  })

  it('keeps the result if the redirect arrives before wait() is called', async () => {
    const { callbackId, redirectUrl } = await env.api.prepareBrowserAuthCallback()
    await fetch(`${redirectUrl}?token=t1`)
    await new Promise((r) => setTimeout(r, 400)) // listener has stopped by now
    expect(await env.api.waitForBrowserAuthCallback(callbackId, 1000)).toEqual({ token: 't1' })
  })

  it('answers wrong paths and methods with 404 without completing the flow', async () => {
    const { callbackId, redirectUrl } = await env.api.prepareBrowserAuthCallback()
    const origin = new URL(redirectUrl).origin
    expect((await fetch(`${origin}/auth/callback/other?code=evil`)).status).toBe(404)
    expect((await fetch(redirectUrl, { method: 'POST' })).status).toBe(404)
    const waiting = env.api.waitForBrowserAuthCallback(callbackId, 5000)
    await fetch(`${redirectUrl}?code=good`)
    expect(await waiting).toEqual({ code: 'good' })
  })

  it('times out, then forgets the callback', async () => {
    const { callbackId } = await env.api.prepareBrowserAuthCallback()
    await expect(env.api.waitForBrowserAuthCallback(callbackId, 50)).rejects.toMatchObject({ code: 'io_error' })
    await expect(env.api.waitForBrowserAuthCallback(callbackId, 50)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('validates the callback id and timeout', async () => {
    await expect(env.api.waitForBrowserAuthCallback('../x', 100)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.waitForBrowserAuthCallback(NIL_UUID.replace('0000', 'abcd'), 100)).rejects.toMatchObject({ code: 'not_found' })
    const { callbackId } = await env.api.prepareBrowserAuthCallback()
    await expect(env.api.waitForBrowserAuthCallback(callbackId, 0)).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
