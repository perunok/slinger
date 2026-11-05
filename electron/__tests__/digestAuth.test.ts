/**
 * Digest auth (0.30): the RFC examples for the computation, challenge parsing, and the executor against a real local
 * server that implements RFC 7616 itself (MD5 / SHA-256 / -sess, qop auth and auth-int, stale nonces, opaque, userhash),
 * through redirects, the cookie jar and cross-origin hops.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DigestAuthInput, HttpRequestInput } from '../../shared/types'
import type { CookieJarPort } from '../services/cookieJarPort'
import { DigestSession, digestAuthorization, parseAuthenticate, parseDigestChallenge } from '../services/digestAuth'
import { executeHttp, scrubRequestValues } from '../services/httpExecutor'
import { baseHttp } from './helpers'

describe('digestAuthorization (RFC examples)', () => {
  it('RFC 2617 section 3.5 (MD5, qop auth)', () => {
    const h = digestAuthorization({
      username: 'Mufasa',
      password: 'Circle Of Life',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      algorithm: 'MD5',
      qop: 'auth',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
      method: 'GET',
      uri: '/dir/index.html',
      nc: 1,
      cnonce: '0a4f113b',
    })
    expect(h).toBe(
      'Digest username="Mufasa", realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", uri="/dir/index.html", ' +
        'algorithm=MD5, qop=auth, nc=00000001, cnonce="0a4f113b", response="6629fae49393a05397450978507c4ef1", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
    )
  })

  it('RFC 7616 section 3.9.1 (MD5 and SHA-256)', () => {
    const base = {
      username: 'Mufasa',
      password: 'Circle of Life',
      realm: 'http-auth@example.org',
      nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      qop: 'auth' as const,
      opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
      method: 'GET',
      uri: '/dir/index.html',
      nc: 1,
      cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
    }
    expect(digestAuthorization({ ...base, algorithm: 'MD5' })).toContain('response="8ca523f5e9506fed4657c9700eebdbec"')
    const sha = digestAuthorization({ ...base, algorithm: 'SHA-256' })
    expect(sha).toContain('algorithm=SHA-256')
    expect(sha).toContain('response="753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1"')
  })

  it('RFC 2069 (no qop), -sess, userhash and a non-ASCII user name', () => {
    const base = { username: 'u', password: 'p', realm: 'r', nonce: 'n', method: 'GET', uri: '/', nc: 1, cnonce: 'c' }
    const md5 = (s: string) => createHash('md5').update(s).digest('hex')
    const plain = digestAuthorization({ ...base, algorithm: '', qop: '' })
    expect(plain).toContain(`response="${md5(`${md5('u:r:p')}:n:${md5('GET:/')}`)}"`)
    expect(plain).not.toContain('qop=')
    expect(plain).not.toContain('nc=')
    const sess = digestAuthorization({ ...base, algorithm: 'md5-sess', qop: 'auth' })
    const ha1 = md5(`${md5('u:r:p')}:n:c`)
    expect(sess).toContain('algorithm=MD5-sess')
    expect(sess).toContain(`response="${md5(`${ha1}:n:00000001:c:auth:${md5('GET:/')}`)}"`)
    const hashed = digestAuthorization({ ...base, algorithm: 'SHA-256', qop: 'auth', userhash: true })
    expect(hashed).toContain(`username="${createHash('sha256').update('u:r').digest('hex')}"`)
    expect(hashed).toContain('userhash=true')
    expect(digestAuthorization({ ...base, username: 'Jäsøn Doe', algorithm: 'MD5', qop: 'auth' })).toContain(
      "username*=UTF-8''J%C3%A4s%C3%B8n%20Doe",
    )
    expect(digestAuthorization({ ...base, username: 'a"b', algorithm: 'MD5', qop: 'auth' })).toContain('username="a\\"b"')
    expect(() => digestAuthorization({ ...base, algorithm: 'SHA-1', qop: '' })).toThrow(/Unsupported/)
  })
})

describe('challenge parsing', () => {
  it('finds the Digest challenge among others (token68 and quoted commas included)', () => {
    const list = parseAuthenticate(['Bearer abc==, Basic realm="x, y"', 'Digest realm="r", nonce="n,1", qop="auth,auth-int", algorithm=SHA-256, stale=TRUE'])
    expect(list.map((c) => c.scheme)).toEqual(['bearer', 'basic', 'digest'])
    expect(list[1]!.params.realm).toBe('x, y')
    expect(parseDigestChallenge(['Basic realm="x"', 'Digest realm="r", nonce="n,1", qop="auth,auth-int", algorithm=SHA-256, stale=TRUE'])).toEqual({
      realm: 'r',
      nonce: 'n,1',
      qop: ['auth', 'auth-int'],
      algorithm: 'SHA-256',
      stale: true,
      userhash: false,
    })
  })

  it('skips challenges with an unsupported algorithm and takes the next', () => {
    const c = parseDigestChallenge('Digest realm="r", nonce="a", algorithm=SHA-1, Digest realm="r", nonce="b", algorithm=MD5-sess, opaque="o"')
    expect(c).toMatchObject({ nonce: 'b', algorithm: 'MD5-SESS', opaque: 'o', qop: [] })
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull()
    expect(parseDigestChallenge([])).toBeNull()
  })

  it('a session answers once per hop, once more for a stale nonce, never with disableRetryRequest', () => {
    const s = new DigestSession({ username: 'u', password: 'p' })
    expect(s.header('GET', new URL('http://h/'), undefined)).toBeNull()
    expect(s.onUnauthorized(['Digest realm="r", nonce="1", qop="auth"'])).toBe(true)
    expect(s.header('GET', new URL('http://h/x?y=1'), undefined)).toMatch(/uri="\/x\?y=1".*nc=00000001/)
    expect(s.onUnauthorized(['Digest realm="r", nonce="2", qop="auth"'])).toBe(false)
    expect(s.onUnauthorized(['Digest realm="r", nonce="2", qop="auth", stale=true'])).toBe(true)
    expect(s.onUnauthorized(['Digest realm="r", nonce="3", qop="auth", stale=true'])).toBe(false)
    s.nextHop()
    // The stale answer switched to nonce 2 (count restarts); it was never sent, so this is its first use.
    expect(s.header('GET', new URL('http://h/z'), undefined)).toMatch(/nonce="2".*nc=00000001/)
    expect(s.header('GET', new URL('http://h/z'), undefined)).toMatch(/nonce="2".*nc=00000002/)
    const off = new DigestSession({ username: 'u', password: 'p', disableRetryRequest: true })
    expect(off.onUnauthorized(['Digest realm="r", nonce="1"'])).toBe(false)
  })

  it('realm and nonce given up front: the first request carries the header (Postman)', () => {
    const s = new DigestSession({ username: 'u', password: 'p', realm: 'r', nonce: 'n', qop: 'auth', nonceCount: '00000005', clientNonce: 'cn', opaque: 'op' })
    expect(s.header('GET', new URL('http://h/'), undefined)).toMatch(/nonce="n".*qop=auth, nc=00000005, cnonce="cn".*opaque="op"/)
    expect(s.note).toMatch(/realm and nonce from the Authorization tab/)
  })
})

// ---- a real RFC 7616 server -----------------------------------------------------------------------------------------

const HASH: Record<string, string> = { MD5: 'md5', 'MD5-SESS': 'md5', 'SHA-256': 'sha256', 'SHA-256-SESS': 'sha256', 'SHA-512-256': 'sha512-256' }

interface ServerOptions {
  algorithm: string
  qop: string
  /** The first nonce is answered with a stale challenge (as if it expired). */
  staleFirst?: boolean
  userhash?: boolean
}

interface Seen {
  url: string
  authorization?: string
  cookie?: string
}

async function startDigestServer() {
  const users = { alice: 'wonder land' }
  let options: ServerOptions = { algorithm: 'MD5', qop: 'auth' }
  const nonces = new Map<string, true>()
  const seen: Seen[] = []
  const realm = 'slinger@test'
  const opaque = randomBytes(8).toString('hex')

  const challenge = (stale = false) => {
    const nonce = randomBytes(12).toString('base64')
    nonces.set(nonce, true)
    const qop = options.qop ? `, qop="${options.qop}"` : ''
    return `Digest realm="${realm}", nonce="${nonce}"${qop}, algorithm=${options.algorithm}, opaque="${opaque}"${stale ? ', stale=true' : ''}${options.userhash ? ', userhash=true' : ''}`
  }

  const verify = (req: IncomingMessage, body: Buffer): 'ok' | 'stale' | 'bad' => {
    const header = req.headers.authorization
    if (!header?.startsWith('Digest ')) return 'bad'
    const p = parseAuthenticate(header)[0]?.params ?? {}
    if (!nonces.has(p.nonce ?? '') || p.uri !== req.url || p.opaque !== opaque || p.realm !== realm) return 'bad'
    const alg = (p.algorithm ?? 'MD5').toUpperCase()
    const h = (s: string | Buffer) => createHash(HASH[alg]!).update(s).digest('hex')
    let username: string | undefined = p.username
    if (options.userhash) username = Object.keys(users).find((u) => h(`${u}:${realm}`) === p.username)
    const password = users[username as keyof typeof users]
    if (password === undefined) return 'bad'
    let ha1 = h(`${username}:${realm}:${password}`)
    if (alg.endsWith('-SESS')) ha1 = h(`${ha1}:${p.nonce}:${p.cnonce}`)
    const ha2 = p.qop === 'auth-int' ? h(`${req.method}:${p.uri}:${h(body)}`) : h(`${req.method}:${p.uri}`)
    const expected = p.qop ? h(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : h(`${ha1}:${p.nonce}:${ha2}`)
    if (expected !== p.response) return 'bad'
    if (options.staleFirst) {
      options = { ...options, staleFirst: false }
      nonces.delete(p.nonce!)
      return 'stale'
    }
    return 'ok'
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({ url: req.url ?? '', authorization: req.headers.authorization, cookie: req.headers.cookie })
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/open-redirect') {
        res.writeHead(302, { Location: url.searchParams.get('to') ?? '/' })
        return void res.end()
      }
      const result = verify(req, body)
      if (result !== 'ok') {
        // The 401 sets a cookie: the answer must carry it (cookie jar on every attempt).
        res.writeHead(401, { 'WWW-Authenticate': ['Basic realm="other"', challenge(result === 'stale')], 'Set-Cookie': 'session=s1; Path=/' })
        return void res.end('unauthorized')
      }
      if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: url.searchParams.get('to') ?? '/final?x=1' })
        return void res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, method: req.method, body: body.toString('utf8'), contentType: req.headers['content-type'] ?? null }))
    })
  }
  const server: Server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    configure: (o: ServerOptions) => (options = o),
    close: () => new Promise((r) => server.close(r)),
  }
}

let srv: Awaited<ReturnType<typeof startDigestServer>>
let other: Awaited<ReturnType<typeof startDigestServer>>
beforeAll(async () => {
  srv = await startDigestServer()
  other = await startDigestServer()
})
afterAll(async () => {
  await srv.close()
  await other.close()
})
beforeEach(() => {
  srv.seen.length = 0
  other.seen.length = 0
})

const creds: DigestAuthInput = { username: 'alice', password: 'wonder land' }
const req = (over: Partial<HttpRequestInput> & { url: string }, digest: Partial<DigestAuthInput> = {}): HttpRequestInput =>
  baseHttp('', { auth: { kind: 'digest', digest: { ...creds, ...digest } }, ...over })
const json = (t: string | null) => JSON.parse(t ?? '{}') as { url: string; method: string; body: string; contentType: string | null }

describe('executor: Digest against a real server', () => {
  it('MD5, qop auth: answers the challenge once and notes it', async () => {
    srv.configure({ algorithm: 'MD5', qop: 'auth' })
    const res = await executeHttp(req({ url: `${srv.base}/data?q=1` }))
    expect(res.status).toBe(200)
    expect(json(res.bodyText).url).toBe('/data?q=1')
    expect(srv.seen).toHaveLength(2)
    expect(srv.seen[0]!.authorization).toBeUndefined()
    expect(srv.seen[1]!.authorization).toMatch(/^Digest username="alice", realm="slinger@test", .*uri="\/data\?q=1", algorithm=MD5, qop=auth, nc=00000001/)
    expect(res.authNote).toBe("Digest (MD5, qop=auth): answered the server's challenge")
  })

  it('SHA-256 with auth-int hashes the body actually sent (raw and multipart)', async () => {
    srv.configure({ algorithm: 'SHA-256', qop: 'auth-int' })
    let res = await executeHttp(req({ method: 'POST', url: `${srv.base}/post`, body: { mode: 'raw', raw: { content: '{"ä":1}', contentType: 'application/json' } } }))
    expect(res.status).toBe(200)
    expect(json(res.bodyText)).toMatchObject({ method: 'POST', body: '{"ä":1}', contentType: 'application/json' })
    expect(res.authNote).toBe("Digest (SHA-256, qop=auth-int): answered the server's challenge")
    res = await executeHttp(
      req({ method: 'PUT', url: `${srv.base}/form`, body: { mode: 'formData', formData: [{ key: 'f', value: 'v', type: 'text', enabled: true }] } }),
    )
    expect(res.status).toBe(200)
    expect(json(res.bodyText).contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(json(res.bodyText).body).toContain('name="f"')
  })

  it('MD5-sess and SHA-512-256 without qop', async () => {
    srv.configure({ algorithm: 'MD5-sess', qop: 'auth' })
    expect((await executeHttp(req({ url: `${srv.base}/s` }))).status).toBe(200)
    srv.configure({ algorithm: 'SHA-512-256', qop: '' })
    const res = await executeHttp(req({ url: `${srv.base}/s` }))
    expect(res.status).toBe(200)
    expect(srv.seen.at(-1)!.authorization).not.toContain('qop=')
  })

  it('userhash: the user name goes hashed', async () => {
    srv.configure({ algorithm: 'SHA-256', qop: 'auth', userhash: true })
    const res = await executeHttp(req({ url: `${srv.base}/u` }))
    expect(res.status).toBe(200)
    expect(srv.seen.at(-1)!.authorization).not.toContain('alice')
  })

  it('a stale nonce is answered once more with the new nonce', async () => {
    srv.configure({ algorithm: 'MD5', qop: 'auth', staleFirst: true })
    const res = await executeHttp(req({ url: `${srv.base}/stale` }))
    expect(res.status).toBe(200)
    expect(srv.seen).toHaveLength(3)
    expect(res.authNote).toMatch(/nonce had expired/)
  })

  it('a wrong password returns the 401 after one answer', async () => {
    srv.configure({ algorithm: 'MD5', qop: 'auth' })
    const res = await executeHttp(req({ url: `${srv.base}/x` }, { password: 'nope' }))
    expect(res.status).toBe(401)
    expect(srv.seen).toHaveLength(2)
  })

  it('through a redirect: each hop authenticates against its own URI; the jar cookie from the 401 is sent', async () => {
    srv.configure({ algorithm: 'SHA-256', qop: 'auth' })
    const store = new Map<string, string>()
    const jar: CookieJarPort = {
      cookieHeaderFor: async () => (store.size ? [...store].map(([k, v]) => `${k}=${v}`).join('; ') : null),
      storeFromResponse: async (_url, setCookie) => {
        for (const c of setCookie) {
          const [pair] = c.split(';')
          const [k, v] = pair!.split('=')
          store.set(k!, v!)
        }
      },
    }
    const res = await executeHttp(req({ url: `${srv.base}/redirect` }), { cookieJar: jar })
    expect(res.status).toBe(200)
    expect(json(res.bodyText).url).toBe('/final?x=1')
    expect(res.redirects).toEqual([{ status: 302, location: `${srv.base}/final?x=1` }])
    const authed = srv.seen.filter((s) => s.authorization)
    expect(authed.map((s) => /uri="([^"]*)"/.exec(s.authorization!)?.[1])).toEqual(['/redirect', '/final?x=1'])
    // The second hop reuses the nonce (nc 2); the cookie the 401 set goes with the answer.
    expect(authed[1]!.authorization).toContain('nc=00000002')
    expect(srv.seen[1]!.cookie).toBe('session=s1')
  })

  it('a redirect to another origin drops Digest (unless Follow Authorization header)', async () => {
    other.configure({ algorithm: 'MD5', qop: 'auth' })
    const target = `${other.base}/x`
    let res = await executeHttp(req({ url: `${srv.base}/open-redirect?to=${encodeURIComponent(target)}` }))
    expect(res.status).toBe(401)
    expect(other.seen).toHaveLength(1)
    expect(other.seen[0]!.authorization).toBeUndefined()
    other.seen.length = 0
    res = await executeHttp(req({ url: `${srv.base}/open-redirect?to=${encodeURIComponent(target)}`, followAuthorizationHeader: true }))
    expect(res.status).toBe(200)
    expect(other.seen).toHaveLength(2)
  })

  it('disableRetryRequest: one request, with the up-front header when realm and nonce are set', async () => {
    srv.configure({ algorithm: 'MD5', qop: 'auth' })
    let res = await executeHttp(req({ url: `${srv.base}/x` }, { disableRetryRequest: true }))
    expect(res.status).toBe(401)
    expect(srv.seen).toHaveLength(1)
    srv.seen.length = 0
    res = await executeHttp(req({ url: `${srv.base}/x` }, { disableRetryRequest: true, realm: 'slinger@test', nonce: 'made-up', qop: 'auth' }))
    expect(res.status).toBe(401) // the server does not know that nonce
    expect(srv.seen).toHaveLength(1)
    expect(srv.seen[0]!.authorization).toMatch(/nonce="made-up"/)
    expect(res.authNote).toMatch(/realm and nonce from the Authorization tab/)
  })

  it('rejects an unsupported algorithm and keeps the password out of error messages', async () => {
    await expect(executeHttp(req({ url: `${srv.base}/x` }, { algorithm: 'SHA-1' }))).rejects.toMatchObject({ code: 'invalid_input' })
    const input = req({ url: `${srv.base}/x` }, { password: 'super-secret-pw' })
    expect(scrubRequestValues('failed with super-secret-pw', input)).toBe('failed with •••')
  })
})
