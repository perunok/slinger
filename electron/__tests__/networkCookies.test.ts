/**
 * Network settings + cookie jar together (0.29 integration): Set-Cookie of a redirect hop lands in the real workspace jar
 * and goes with the next hop and the next request; pm.sendRequest uses both the proxy settings and the jar; sends with
 * `cookies: 'off'` (the request's Disable cookie jar, or a send an AI assistant controls) neither send nor store cookies.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunScriptsInput } from '../../shared/types'
import { baseHttp, makeEnv, scaffold, type TestEnv } from './helpers'

interface Seen {
  host: string | undefined
  url: string
  cookie: string | undefined
  viaProxy: boolean
}

async function listen(server: Server): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>()
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

/** /login redirects to /me and sets a cookie on the redirect itself; /me echoes the Cookie header. */
async function startTarget() {
  const seen: Seen[] = []
  const server = createServer((req: IncomingMessage, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ host: req.headers.host, url: req.url ?? '', cookie: req.headers.cookie, viaProxy: req.headers['x-via-proxy'] === '1' })
      const path = (req.url ?? '').split('?')[0]
      if (path === '/login') {
        res.writeHead(302, { Location: '/me', 'Set-Cookie': 'session=hop-1; Path=/; HttpOnly' })
        return void res.end()
      }
      if (path === '/me') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'seen=yes; Path=/' })
        return void res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }))
    })
  })
  const l = await listen(server)
  return { ...l, base: `http://127.0.0.1:${l.port}`, seen }
}

/** Forward proxy for absolute-URI http requests, all sent to the target whatever host was asked for. */
async function startProxy(targetPort: () => number) {
  const urls: string[] = []
  const server = createServer((req, res) => {
    urls.push(req.url ?? '')
    const u = new URL(req.url ?? '/')
    const up = httpRequest(
      { host: '127.0.0.1', port: targetPort(), path: u.pathname + u.search, method: req.method, headers: { ...req.headers, 'x-via-proxy': '1' } },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      },
    )
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  const l = await listen(server)
  return { ...l, url: `http://127.0.0.1:${l.port}`, urls }
}

let env: TestEnv
let ws: string
let target: Awaited<ReturnType<typeof startTarget>>
beforeEach(async () => {
  env = makeEnv()
  ws = (await scaffold(env)).workspace.id
  target = await startTarget()
})
afterEach(async () => {
  await target.close()
  env.cleanup()
})

const send = (url: string, over: Partial<Parameters<typeof baseHttp>[1]> = {}) => env.api.executeHttpRequest(baseHttp(ws, { url, ...over }))
const names = async () => (await env.api.listCookies(ws)).map((c) => c.name).sort()

describe('redirects with the real cookie jar', () => {
  it("a redirect hop's Set-Cookie is stored, sent on the next hop and on the next request", async () => {
    const res = await send(`${target.base}/login`, { historyUrl: `${target.base}/login` })
    expect(res.redirects).toEqual([{ status: 302, location: `${target.base}/me` }])
    expect(JSON.parse(res.bodyText!)).toEqual({ cookie: 'session=hop-1' })
    expect(await names()).toEqual(['seen', 'session'])
    await send(`${target.base}/other`)
    expect(target.seen[target.seen.length - 1]!.cookie).toBe('session=hop-1; seen=yes')
    // A user-set Cookie header wins per name, on every hop.
    await send(`${target.base}/login`, { headers: [{ key: 'Cookie', value: 'session=mine' }] })
    expect(target.seen.slice(-2).map((s) => s.cookie)).toEqual(['session=mine; seen=yes', 'session=mine; seen=yes'])
  })

  it("cookies: 'off' (Disable cookie jar, assistant-controlled sends) neither sends nor stores, also across redirects", async () => {
    await send(`${target.base}/login`)
    const before = await names()
    target.seen.length = 0
    const res = await send(`${target.base}/login`, { cookies: 'off' })
    expect(JSON.parse(res.bodyText!)).toEqual({ cookie: null })
    expect(target.seen.map((s) => s.cookie)).toEqual([undefined, undefined])
    expect(await names()).toEqual(before)
    const fresh = makeEnv()
    try {
      const w = (await scaffold(fresh)).workspace.id
      await fresh.api.executeHttpRequest(baseHttp(w, { url: `${target.base}/login`, cookies: 'off' }))
      expect(await fresh.api.listCookies(w)).toEqual([])
    } finally {
      fresh.cleanup()
    }
  })

  it('followRedirects off still stores the 3xx response cookies', async () => {
    const res = await send(`${target.base}/login`, { followRedirects: false })
    expect(res.status).toBe(302)
    expect(await names()).toEqual(['session'])
  })
})

describe('pm.sendRequest with network settings and the jar', () => {
  let seq = 0
  const input = (code: string, over: Partial<RunScriptsInput> = {}): RunScriptsInput => ({
    runId: `nc-${++seq}`,
    sessionId: 'nc-session',
    workspaceId: ws,
    environmentId: null,
    event: 'prerequest',
    scripts: [{ origin: 'request', name: 'R', code }],
    request: { method: 'GET', url: 'http://x/', headers: [], body: { mode: 'none' } },
    response: null,
    variables: {},
    collectionVariables: {},
    globals: {},
    info: { requestName: 'R', requestId: null, iteration: 0, iterationCount: 1 },
    ...over,
  })

  it('goes through the custom proxy, follows the redirect with its cookie and stores both in the jar', async () => {
    const proxy = await startProxy(() => target.port)
    try {
      await env.api.setNetworkSettings({ proxy: { mode: 'custom', url: proxy.url } })
      const r = await env.api.runScripts(
        input(`
          const res = await pm.sendRequest('http://api.slinger-nc.invalid/login')
          pm.variables.set('seen', res.json().cookie)
        `),
      )
      expect(r.errors).toEqual([])
      expect(r.variables.seen).toBe('session=hop-1')
      expect(proxy.urls).toEqual(['http://api.slinger-nc.invalid/login', 'http://api.slinger-nc.invalid/me'])
      expect(target.seen.every((s) => s.viaProxy)).toBe(true)
      const jar = await env.api.listCookies(ws)
      expect(jar.map((c) => [c.name, c.domain]).sort()).toEqual([
        ['seen', 'api.slinger-nc.invalid'],
        ['session', 'api.slinger-nc.invalid'],
      ])
      // A normal send to that host then carries them (through the proxy as well).
      await send('http://api.slinger-nc.invalid/next')
      expect(target.seen[target.seen.length - 1]).toMatchObject({ cookie: 'session=hop-1; seen=yes', viaProxy: true })
    } finally {
      await proxy.close()
    }
  })

  it('an assistant-controlled run (denySecrets) gets no jar, but still the network settings', async () => {
    await send(`${target.base}/login`)
    const proxy = await startProxy(() => target.port)
    try {
      await env.api.setNetworkSettings({ proxy: { mode: 'custom', url: proxy.url } })
      const r = await env.api.runScripts(
        input(`const res = await pm.sendRequest('http://api.slinger-nc.invalid/login'); pm.variables.set('seen', String(res.json().cookie))`, {
          denySecrets: 'not available to scripts of a request an AI assistant wrote or changed.',
        }),
      )
      expect(r.errors).toEqual([])
      expect(r.variables.seen).toBe('null')
      expect(proxy.urls).toHaveLength(2)
      expect((await env.api.listCookies(ws)).some((c) => c.domain === 'api.slinger-nc.invalid')).toBe(false)
    } finally {
      await proxy.close()
    }
  })
})
