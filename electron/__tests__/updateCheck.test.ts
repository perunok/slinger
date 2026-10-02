import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIpcApi } from '../ipc/api'
import { checkForUpdate, LATEST_RELEASE_API, parseRelease, releasePageUrl, updateFeedUrl } from '../services/updateCheck'
import { makeEnv, type TestEnv } from './helpers'

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0)

/** A fetch that answers every call with one canned response and records the requests. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  published_at: '2026-10-01T10:00:00Z',
  html_url: 'https://example.com/not-github',
  body: 'notes',
  draft: false,
  prerelease: false,
  ...extra,
})

describe('checkForUpdate', () => {
  it('reports a newer release with a link built from the version (never the answer’s own URL)', async () => {
    const { fetchImpl, calls } = fakeFetch(200, release('v0.10.0'))
    const result = await checkForUpdate({ currentVersion: '0.9.0', fetchImpl, now: () => NOW })
    expect(result).toEqual({
      currentVersion: '0.9.0',
      latest: { version: '0.10.0', url: 'https://github.com/perunok/slinger/releases/tag/v0.10.0', publishedAt: Date.UTC(2026, 9, 1, 10) / 1000 },
      updateAvailable: true,
      checkedAt: NOW / 1000,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(LATEST_RELEASE_API)
    expect(calls[0]!.headers['user-agent']).toBe('Slinger/0.9.0')
    expect(calls[0]!.headers.accept).toBe('application/vnd.github+json')
  })

  it('compares as semantic versions (0.10.0 > 0.9.0), same or older is not an update', async () => {
    for (const [tag, current, available] of [
      ['v0.9.0', '0.9.0', false],
      ['0.9.0', '0.10.0', false],
      ['v1.0.0', '0.99.0', true],
      ['v0.9.1', '0.9.0', true],
      // A pre-release build of the same version is older than the release.
      ['v0.9.0', '0.9.0-beta.1', true],
    ] as const) {
      const { fetchImpl } = fakeFetch(200, release(tag))
      const result = await checkForUpdate({ currentVersion: current, fetchImpl })
      expect(result.updateAvailable, `${tag} vs ${current}`).toBe(available)
    }
  })

  it('never offers anything when the running version is not a semantic version', async () => {
    const { fetchImpl } = fakeFetch(200, release('v9.9.9'))
    expect((await checkForUpdate({ currentVersion: 'dev', fetchImpl })).updateAvailable).toBe(false)
  })

  it('treats 404 as "no release published yet"', async () => {
    const { fetchImpl } = fakeFetch(404, { message: 'Not Found' })
    expect(await checkForUpdate({ currentVersion: '0.9.0', fetchImpl, now: () => NOW })).toEqual({
      currentVersion: '0.9.0',
      latest: null,
      updateAvailable: false,
      checkedAt: NOW / 1000,
    })
  })

  it('maps HTTP errors and unreachable hosts to network_error, odd answers to io_error', async () => {
    await expect(checkForUpdate({ currentVersion: '0.9.0', fetchImpl: fakeFetch(403, {}).fetchImpl })).rejects.toMatchObject({
      code: 'network_error',
      details: { status: 403 },
    })
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(checkForUpdate({ currentVersion: '0.9.0', fetchImpl: offline })).rejects.toMatchObject({ code: 'network_error' })
    await expect(checkForUpdate({ currentVersion: '0.9.0', fetchImpl: fakeFetch(200, '<html>').fetchImpl })).rejects.toMatchObject({ code: 'io_error' })
    await expect(checkForUpdate({ currentVersion: '0.9.0', fetchImpl: fakeFetch(200, release('latest')).fetchImpl })).rejects.toMatchObject({ code: 'io_error' })
    await expect(checkForUpdate({ currentVersion: '0.9.0', fetchImpl: fakeFetch(200, 'x'.repeat(1024 * 1024 + 1)).fetchImpl })).rejects.toMatchObject({ code: 'io_error' })
  })

  describe('against a real HTTP server', () => {
    let server: Server
    let url: string
    let delayMs = 0
    beforeEach(async () => {
      server = createServer((_req, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(release('v1.2.3')))
        }, delayMs)
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`
    })
    afterEach(async () => {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    })

    it('reads the feed', async () => {
      delayMs = 0
      const result = await checkForUpdate({ currentVersion: '1.0.0', fetchImpl: fetch, feedUrl: url })
      expect(result.latest?.version).toBe('1.2.3')
      expect(result.updateAvailable).toBe(true)
    })

    it('gives up after the timeout', async () => {
      delayMs = 1000
      await expect(checkForUpdate({ currentVersion: '1.0.0', fetchImpl: fetch, feedUrl: url, timeoutMs: 50 })).rejects.toMatchObject({
        code: 'network_error',
        details: { timedOut: true },
      })
    })
  })
})

describe('parseRelease', () => {
  it('accepts v-prefixed and bare stable versions', () => {
    expect(parseRelease(release('v1.2.3'))).toEqual({ version: '1.2.3', publishedAt: Date.UTC(2026, 9, 1, 10) / 1000 })
    expect(parseRelease(release('1.2.3', { published_at: null }))).toEqual({ version: '1.2.3', publishedAt: null })
  })

  it('refuses drafts, pre-releases and anything that is not a version', () => {
    for (const body of [
      release('v1.2.3', { draft: true }),
      release('v1.2.3', { prerelease: true }),
      release('v1.2.3-rc.1'),
      release('v01.2.3'),
      release('1.2'),
      release('../../evil'),
      { tag_name: 123 },
      null,
      [],
      'v1.2.3',
    ]) {
      expect(parseRelease(body), JSON.stringify(body)).toBeNull()
    }
  })

  it('links to the release page of that tag', () => {
    expect(releasePageUrl('1.2.3')).toBe('https://github.com/perunok/slinger/releases/tag/v1.2.3')
  })
})

describe('updateFeedUrl', () => {
  it('uses GitHub normally, an http(s) override when set, and nothing in automated runs', () => {
    expect(updateFeedUrl({})).toBe(LATEST_RELEASE_API)
    expect(updateFeedUrl({ SLINGER_UPDATE_FEED_URL: 'http://127.0.0.1:9/latest' })).toBe('http://127.0.0.1:9/latest')
    expect(updateFeedUrl({ SLINGER_HIDE_WINDOW: '1' })).toBeNull()
    expect(updateFeedUrl({ SLINGER_SMOKE_TEST: '1' })).toBeNull()
    // An explicit feed wins, so e2e can test the notice.
    expect(updateFeedUrl({ SLINGER_HIDE_WINDOW: '1', SLINGER_UPDATE_FEED_URL: 'https://feed.test/x' })).toBe('https://feed.test/x')
    expect(() => updateFeedUrl({ SLINGER_UPDATE_FEED_URL: 'file:///etc/passwd' })).toThrow(/http/)
  })
})

describe('checkForUpdates (IPC)', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.cleanup())

  it('takes no arguments and answers io_error when checks are off', async () => {
    await expect(env.api.checkForUpdates()).rejects.toMatchObject({ code: 'io_error' })
    const result = { currentVersion: '1.0.0', latest: null, updateAvailable: false, checkedAt: 1 }
    const api = createIpcApi(env.core, {
      appVersion: '1.0.0',
      openExternal: async () => {},
      chooseDirectory: async () => null,
      pickFile: async () => null,
      checkForUpdates: async () => result,
    })
    await expect(api.checkForUpdates()).resolves.toEqual(result)
    await expect((api.checkForUpdates as (...a: unknown[]) => Promise<unknown>)('https://evil')).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
