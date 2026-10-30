import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '../../shared/types'
import type { CookieJarPort } from '../services/cookieJarPort'
import { executeHttp } from '../services/httpExecutor'
import { mergeCookieHeader, planRedirect, redirectHeaders, redirectPolicy, type RedirectPolicy } from '../services/redirects'
import { baseHttp, makeEnv, scaffold, type TestEnv } from './helpers'

const policy = (over: Partial<RedirectPolicy> = {}): RedirectPolicy => ({ ...redirectPolicy({}), ...over })
const at = (url: string, method = 'GET') => ({ url: new URL(url), method })

describe('redirect state machine', () => {
  it('has Postman defaults', () => {
    expect(redirectPolicy({})).toEqual({
      followRedirects: true,
      maxRedirects: 10,
      followOriginalHttpMethod: false,
      followAuthorizationHeader: false,
      removeRefererHeaderOnRedirect: false,
    })
    expect(redirectPolicy({ maxRedirects: -3 }).maxRedirects).toBe(0)
    expect(redirectPolicy({ maxRedirects: 5000 }).maxRedirects).toBe(1000)
  })

  it('follows only redirect statuses with a usable http(s) Location', () => {
    const p = policy()
    expect(planRedirect(at('http://a/x'), 200, '/y', p, 0)).toEqual({ kind: 'final' })
    expect(planRedirect(at('http://a/x'), 304, '/y', p, 0)).toEqual({ kind: 'final' })
    expect(planRedirect(at('http://a/x'), 302, null, p, 0)).toEqual({ kind: 'final' })
    expect(planRedirect(at('http://a/x'), 302, 'ftp://a/y', p, 0)).toEqual({ kind: 'final' })
    expect(planRedirect(at('http://a/x'), 302, 'http://[bad', p, 0)).toEqual({ kind: 'final' })
    expect(planRedirect(at('http://a/x'), 302, '/y', policy({ followRedirects: false }), 0)).toEqual({ kind: 'final' })
    const f = planRedirect(at('http://a/dir/x?q=1'), 302, 'z', p, 0)
    expect(f).toMatchObject({ kind: 'follow', method: 'GET', crossOrigin: false })
    expect(f.kind === 'follow' && f.url.toString()).toBe('http://a/dir/z')
  })

  it('switches methods like browsers and Postman', () => {
    const p = policy()
    expect(planRedirect(at('http://a/', 'POST'), 301, '/b', p, 0)).toMatchObject({ method: 'GET', keepBody: false })
    expect(planRedirect(at('http://a/', 'PUT'), 302, '/b', p, 0)).toMatchObject({ method: 'GET', keepBody: false })
    expect(planRedirect(at('http://a/', 'POST'), 303, '/b', p, 0)).toMatchObject({ method: 'GET', keepBody: false })
    expect(planRedirect(at('http://a/', 'HEAD'), 303, '/b', p, 0)).toMatchObject({ method: 'HEAD', keepBody: false })
    expect(planRedirect(at('http://a/', 'POST'), 307, '/b', p, 0)).toMatchObject({ method: 'POST', keepBody: true })
    expect(planRedirect(at('http://a/', 'PATCH'), 308, '/b', p, 0)).toMatchObject({ method: 'PATCH', keepBody: true })
    const keep = policy({ followOriginalHttpMethod: true })
    expect(planRedirect(at('http://a/', 'POST'), 302, '/b', keep, 0)).toMatchObject({ method: 'POST', keepBody: true })
    expect(planRedirect(at('http://a/', 'POST'), 303, '/b', keep, 0)).toMatchObject({ method: 'GET', keepBody: false })
  })

  it('stops at maxRedirects', () => {
    expect(planRedirect(at('http://a/'), 302, '/b', policy({ maxRedirects: 2 }), 1)).toMatchObject({ kind: 'follow' })
    expect(planRedirect(at('http://a/'), 302, '/b', policy({ maxRedirects: 2 }), 2)).toEqual({ kind: 'tooMany', max: 2 })
    expect(planRedirect(at('http://a/'), 302, '/b', policy({ maxRedirects: 0 }), 0)).toEqual({ kind: 'tooMany', max: 0 })
  })

  it('drops auth, cookies and body headers as the hop requires', () => {
    const h = new Headers({ Authorization: 'Bearer t', 'X-Api-Key': 'k', Cookie: 'a=1', Referer: 'http://r/', 'Content-Type': 'text/plain', 'X-Other': 'o' })
    const cross = planRedirect(at('http://a/', 'POST'), 302, 'http://b/', policy(), 0)
    if (cross.kind !== 'follow') throw new Error('expected follow')
    const out = redirectHeaders(h, cross, policy(), ['authorization', 'x-api-key'])
    expect([...out.keys()].sort()).toEqual(['referer', 'x-other'])
    const kept = redirectHeaders(h, cross, policy({ followAuthorizationHeader: true, removeRefererHeaderOnRedirect: true }), ['authorization', 'x-api-key'])
    expect([...kept.keys()].sort()).toEqual(['authorization', 'x-api-key', 'x-other'])
    const same = planRedirect(at('http://a/', 'PUT'), 307, '/c', policy(), 0)
    if (same.kind !== 'follow') throw new Error('expected follow')
    expect([...redirectHeaders(h, same, policy(), ['authorization']).keys()].sort()).toEqual([
      'authorization',
      'content-type',
      'cookie',
      'referer',
      'x-api-key',
      'x-other',
    ])
    // Another port or scheme is another origin.
    expect(planRedirect(at('http://a/'), 302, 'http://a:81/', policy(), 0)).toMatchObject({ crossOrigin: true })
    expect(planRedirect(at('http://a/'), 302, 'https://a/', policy(), 0)).toMatchObject({ crossOrigin: true })
  })

  it('merges cookies with the request winning per name', () => {
    expect(mergeCookieHeader(null, null)).toBeNull()
    expect(mergeCookieHeader('a=1', null)).toBe('a=1')
    expect(mergeCookieHeader(null, 'b=2')).toBe('b=2')
    expect(mergeCookieHeader('a=1; b=own', 'b=jar; c=3')).toBe('a=1; b=own; c=3')
  })
})

// ---- against real servers ----------------------------------------------------------------------------------------------

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

async function startRedirectServer() {
  const seen: Seen[] = []
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      const status = /^\/r\/(\d{3})$/.exec(url.pathname)?.[1]
      if (status) {
        const headers: Record<string, string | string[]> = { Location: url.searchParams.get('to') ?? '/echo' }
        if (url.searchParams.get('cookie')) headers['Set-Cookie'] = [`${url.searchParams.get('cookie')}; Path=/`]
        res.writeHead(Number(status), headers)
        return void res.end('redirect body')
      }
      if (url.pathname === '/loop') {
        res.writeHead(302, { Location: '/loop' })
        return void res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'final=1' })
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
  }
  const server: Server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  }
}

let a: Awaited<ReturnType<typeof startRedirectServer>>
let b: Awaited<ReturnType<typeof startRedirectServer>>
beforeAll(async () => {
  a = await startRedirectServer()
  b = await startRedirectServer()
})
afterAll(async () => {
  await a.close()
  await b.close()
})
beforeEach(() => {
  a.seen.length = 0
  b.seen.length = 0
})

const req = (over: Partial<HttpRequestInput> & { url: string }): HttpRequestInput => baseHttp('', over)
const json = (bodyText: string | null) => JSON.parse(bodyText ?? '{}') as { method: string; url: string; headers: Record<string, string>; body: string }
const to = (target: string) => encodeURIComponent(target)

describe('executor redirects (real servers)', () => {
  it('follows a chain and records each hop', async () => {
    const res = await executeHttp(req({ url: `${a.base}/r/301?to=${to(`/r/302?to=${to(`${b.base}/echo`)}`)}` }))
    expect(res.status).toBe(200)
    expect(res.redirects).toEqual([
      { status: 301, location: `${a.base}/r/302?to=${to(`${b.base}/echo`)}` },
      { status: 302, location: `${b.base}/echo` },
    ])
    expect(b.seen).toHaveLength(1)
  })

  it('a response without redirects has no chain', async () => {
    const res = await executeHttp(req({ url: `${a.base}/echo` }))
    expect(res.redirects).toBeUndefined()
  })

  it('POST + 302 becomes GET without body unless followOriginalHttpMethod; 303 always does', async () => {
    const post = { method: 'POST', body: { mode: 'raw' as const, raw: { content: 'payload', contentType: 'text/plain' } } }
    let res = await executeHttp(req({ ...post, url: `${a.base}/r/302` }))
    expect(json(res.bodyText)).toMatchObject({ method: 'GET', body: '' })
    expect(json(res.bodyText).headers['content-type']).toBeUndefined()
    res = await executeHttp(req({ ...post, url: `${a.base}/r/302`, followOriginalHttpMethod: true }))
    expect(json(res.bodyText)).toMatchObject({ method: 'POST', body: 'payload' })
    expect(json(res.bodyText).headers['content-type']).toBe('text/plain')
    res = await executeHttp(req({ ...post, url: `${a.base}/r/303`, followOriginalHttpMethod: true }))
    expect(json(res.bodyText)).toMatchObject({ method: 'GET', body: '' })
  })

  it('307 and 308 keep method and body (also form data)', async () => {
    let res = await executeHttp(req({ method: 'PUT', url: `${a.base}/r/307`, body: { mode: 'raw', raw: { content: '{"a":1}', contentType: 'application/json' } } }))
    expect(json(res.bodyText)).toMatchObject({ method: 'PUT', body: '{"a":1}' })
    res = await executeHttp(
      req({ method: 'POST', url: `${a.base}/r/308`, body: { mode: 'formData', formData: [{ key: 'f', value: 'v', type: 'text', enabled: true }] } }),
    )
    const echoed = json(res.bodyText)
    expect(echoed.method).toBe('POST')
    expect(echoed.body).toContain('name="f"')
    expect(echoed.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
  })

  it('followRedirects off returns the 3xx itself', async () => {
    const res = await executeHttp(req({ url: `${a.base}/r/302?to=/elsewhere`, followRedirects: false }))
    expect(res.status).toBe(302)
    expect(res.headers.find((h) => h.key === 'location')?.value).toBe('/elsewhere')
    expect(res.bodyText).toBe('redirect body')
    expect(res.redirects).toBeUndefined()
  })

  it('fails after maxRedirects (loops end)', async () => {
    await expect(executeHttp(req({ url: `${a.base}/loop` }))).rejects.toMatchObject({
      code: 'network_error',
      details: { tooManyRedirects: true },
      message: expect.stringContaining('stopped after 10'),
    })
    expect(a.seen).toHaveLength(11)
    await expect(executeHttp(req({ url: `${a.base}/r/302?to=${to('/r/302')}`, maxRedirects: 1 }))).rejects.toMatchObject({ details: { tooManyRedirects: true } })
    const ok = await executeHttp(req({ url: `${a.base}/r/302?to=${to('/r/302')}`, maxRedirects: 2 }))
    expect(ok.redirects).toHaveLength(2)
  })

  it('drops Authorization and the API key header on a cross-origin hop unless followAuthorizationHeader', async () => {
    const cross = `${a.base}/r/302?to=${to(`${b.base}/echo`)}`
    let res = await executeHttp(req({ url: cross, auth: { kind: 'bearer', bearer: { token: 'tok-123' } }, headers: [{ key: 'X-Keep', value: 'yes' }] }))
    expect(a.seen[0]!.headers.authorization).toBe('Bearer tok-123')
    expect(json(res.bodyText).headers.authorization).toBeUndefined()
    expect(json(res.bodyText).headers['x-keep']).toBe('yes')

    res = await executeHttp(req({ url: cross, auth: { kind: 'apiKey', apiKey: { key: 'X-Api-Key', value: 'k-1', addTo: 'header' } } }))
    expect(json(res.bodyText).headers['x-api-key']).toBeUndefined()

    res = await executeHttp(req({ url: cross, auth: { kind: 'basic', basic: { username: 'u', password: 'p' } }, followAuthorizationHeader: true }))
    expect(json(res.bodyText).headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)

    // Same origin: kept.
    res = await executeHttp(req({ url: `${a.base}/r/302`, auth: { kind: 'bearer', bearer: { token: 'tok-123' } } }))
    expect(json(res.bodyText).headers.authorization).toBe('Bearer tok-123')
  })

  it('re-checks an OAuth 2.0 token kept on another origin', async () => {
    const tokenKey = 'a'.repeat(64)
    const asked: string[] = []
    const oauth2Token = (_key: string, origin: string) => {
      asked.push(origin)
      if (origin === b.base) throw Object.assign(new Error('not allowed'), { name: 'IpcError' })
      return 'tok'
    }
    const auth = { kind: 'oauth2' as const, oauth2: { tokenKey, addTo: 'header' as const, headerPrefix: 'Bearer' } }
    const cross = `${a.base}/r/302?to=${to(`${b.base}/echo`)}`
    const res = await executeHttp(req({ url: cross, auth }), { oauth2Token })
    expect(asked).toEqual([a.base])
    expect(json(res.bodyText).headers.authorization).toBeUndefined()
    await expect(executeHttp(req({ url: cross, auth, followAuthorizationHeader: true }), { oauth2Token })).rejects.toBeTruthy()
    expect(asked).toEqual([a.base, a.base, b.base])
  })

  it('keeps a user Referer unless removeRefererHeaderOnRedirect', async () => {
    const headers = [{ key: 'Referer', value: 'http://from.example/' }]
    let res = await executeHttp(req({ url: `${a.base}/r/302`, headers }))
    expect(json(res.bodyText).headers.referer).toBe('http://from.example/')
    res = await executeHttp(req({ url: `${a.base}/r/302`, headers, removeRefererHeaderOnRedirect: true }))
    expect(json(res.bodyText).headers.referer).toBeUndefined()
    expect(a.seen[a.seen.length - 2]!.headers.referer).toBe('http://from.example/')
  })

  it('asks the cookie jar before and tells it after every hop', async () => {
    const calls: string[] = []
    const jar: CookieJarPort = {
      async cookieHeaderFor(url) {
        calls.push(`get ${url.toString()}`)
        return 'jar=1; own=jar'
      },
      async storeFromResponse(url, setCookie) {
        calls.push(`store ${url.toString()} ${setCookie.join('|')}`)
      },
    }
    const first = `${a.base}/r/302?cookie=hop%3D1&to=${to(`${b.base}/echo`)}`
    const res = await executeHttp(req({ url: first, headers: [{ key: 'Cookie', value: 'own=user' }] }), { cookieJar: jar })
    expect(calls).toEqual([`get ${first}`, `store ${first} hop=1; Path=/`, `get ${b.base}/echo`, `store ${b.base}/echo final=1`])
    expect(a.seen[0]!.headers.cookie).toBe('own=user; jar=1')
    // The request's own Cookie header does not follow it to another origin; the jar's cookies do.
    expect(json(res.bodyText).headers.cookie).toBe('jar=1; own=jar')
  })

  it('a failing jar never fails the send; without a jar nothing changes', async () => {
    const jar: CookieJarPort = {
      cookieHeaderFor: async () => {
        throw new Error('jar broke')
      },
      storeFromResponse: async () => {
        throw new Error('jar broke')
      },
    }
    const res = await executeHttp(req({ url: `${a.base}/echo`, headers: [{ key: 'Cookie', value: 'x=1' }] }), { cookieJar: jar })
    expect(json(res.bodyText).headers.cookie).toBe('x=1')
  })
})

describe('redirects through IPC', () => {
  let env: TestEnv
  let wsId: string
  beforeEach(async () => {
    env = makeEnv()
    wsId = (await scaffold(env)).workspace.id
  })
  afterEach(() => env.cleanup())

  it('validates the settings fields', async () => {
    const bad = [{ maxRedirects: -1 }, { maxRedirects: 1.5 }, { maxRedirects: 1001 }, { strictSSL: 'yes' }, { followRedirects: 1 }]
    for (const over of bad) {
      await expect(env.api.executeHttpRequest({ ...baseHttp(wsId, { url: `${a.base}/echo` }), ...(over as object) })).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    const res = await env.api.executeHttpRequest(baseHttp(wsId, { url: `${a.base}/r/302`, maxRedirects: 0, followRedirects: false }))
    expect(res.status).toBe(302)
  })

  it("imports Postman's protocolProfileBehavior into the request document", async () => {
    const ppb = { strictSSL: false, followRedirects: false, disableBodyPruning: true }
    const file = JSON.stringify({
      info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{ name: 'R', request: { method: 'GET', url: 'https://api.test/x' }, protocolProfileBehavior: ppb }],
    })
    const { collection } = await env.api.importPostmanCollection(wsId, file)
    const [r] = await env.api.listRequests(collection.id)
    expect(JSON.parse(r!.documentJson).protocolProfileBehavior).toEqual(ppb)
  })

  it('redirect locations never show values of the request', async () => {
    const secret = 'sekrit-token-value-42'
    const res = await env.api.executeHttpRequest(
      baseHttp(wsId, {
        url: `${a.base}/r/302?to=${to(`/echo?t=${secret}`)}`,
        historyUrl: `${a.base}/r/302?to={{target}}`,
        headers: [{ key: 'X-Token', value: secret }],
      }),
    )
    expect(res.redirects).toHaveLength(1)
    expect(res.redirects![0]!.location).not.toContain(secret)
    expect(res.redirects![0]!.location).toContain('•••')
  })
})
