import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { createServer as createHttpsServer, type ServerOptions } from 'node:https'
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '../../shared/types'
import { executeHttp } from '../services/httpExecutor'
import {
  bypassMatches,
  describeSendError,
  DIRECT_CONFIG,
  envProxyFor,
  isLoopbackHost,
  matchClientCert,
  NetworkDispatchers,
  networkFetch,
  parsePacResult,
  type NetworkConfig,
} from '../services/network'
import { clientCertPassphraseKey, normalizeProxyUrl, NetworkSettingsService, PROXY_PASSWORD_KEY } from '../services/networkSettings'
import { MemorySecretStore } from '../services/secrets'
import { FileGrants } from '../services/fileGrants'
import { openDatabase } from '../db/database'
import { runMigrations } from '../db/migrate'
import { baseHttp, closedPort, makeEnv, MIGRATIONS_DIR, pickAndGrant, scaffold, type TestEnv } from './helpers'

const FIX = fileURLToPath(new URL('./fixtures/tls/', import.meta.url))
const fixture = (name: string) => readFileSync(join(FIX, name))
const fixturePath = (name: string) => join(FIX, name)

const req = (over: Partial<HttpRequestInput> & { url: string }): HttpRequestInput => baseHttp('', over)

// ---- pure helpers --------------------------------------------------------------------------------------------------------

describe('proxy choice', () => {
  it('knows loopback hosts', () => {
    for (const h of ['localhost', 'LOCALHOST', 'api.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1']) expect(isLoopbackHost(h)).toBe(true)
    for (const h of ['example.com', '10.0.0.1', 'localhost.example.com', '128.0.0.1']) expect(isLoopbackHost(h)).toBe(false)
  })

  it('matches bypass entries', () => {
    const u = (s: string) => new URL(s)
    expect(bypassMatches(u('http://example.com/'), ['example.com'])).toBe(true)
    expect(bypassMatches(u('http://api.example.com/'), ['example.com'])).toBe(false)
    expect(bypassMatches(u('http://api.example.com/'), ['.example.com'])).toBe(true)
    expect(bypassMatches(u('http://example.com/'), ['*.example.com'])).toBe(true)
    expect(bypassMatches(u('http://a.b.example.com/'), ['*.example.com'])).toBe(true)
    expect(bypassMatches(u('http://notexample.com/'), ['.example.com'])).toBe(false)
    expect(bypassMatches(u('http://example.com:8080/'), ['example.com:8080'])).toBe(true)
    expect(bypassMatches(u('http://example.com/'), ['example.com:8080'])).toBe(false)
    expect(bypassMatches(u('https://example.com/'), ['example.com:443'])).toBe(true)
    expect(bypassMatches(u('http://anything/'), ['*'])).toBe(true)
    expect(bypassMatches(u('http://b.org/'), ['a.org, b.org'])).toBe(true)
    expect(bypassMatches(u('http://[fe80::1]:81/'), ['[fe80::1]:81'])).toBe(true)
  })

  it('reads PAC answers', () => {
    expect(parsePacResult('DIRECT')).toBeNull()
    expect(parsePacResult('PROXY proxy.corp:3128; DIRECT')).toBe('http://proxy.corp:3128')
    expect(parsePacResult('HTTPS secure.corp:443')).toBe('https://secure.corp:443')
    expect(parsePacResult('SOCKS5 s:1080; PROXY p:8080')).toBe('http://p:8080')
    expect(parsePacResult('SOCKS5 s:1080')).toBeNull()
    expect(parsePacResult('')).toBeNull()
  })

  it('reads the proxy environment variables', () => {
    const env = { HTTP_PROXY: 'http://p:1', https_proxy: 'p2:2', NO_PROXY: '.internal,example.org' }
    expect(envProxyFor(new URL('http://a.com/'), env)).toBe('http://p:1')
    expect(envProxyFor(new URL('https://a.com/'), env)).toBe('http://p2:2')
    expect(envProxyFor(new URL('https://x.internal/'), env)).toBeNull()
    expect(envProxyFor(new URL('http://example.org/'), env)).toBeNull()
    expect(envProxyFor(new URL('https://a.com/'), { HTTP_PROXY: 'http://p:1' })).toBe('http://p:1')
    expect(envProxyFor(new URL('https://a.com/'), {})).toBeNull()
  })

  it('picks the client certificate for a host and port', () => {
    const certs = [
      { id: 'wild', host: '*.example.com', port: null },
      { id: 'exact', host: 'api.example.com', port: null },
      { id: 'port', host: 'api.example.com', port: 8443 },
    ]
    expect(matchClientCert(certs, new URL('https://api.example.com/'))?.id).toBe('exact')
    expect(matchClientCert(certs, new URL('https://api.example.com:8443/'))?.id).toBe('port')
    expect(matchClientCert(certs, new URL('https://www.example.com/'))?.id).toBe('wild')
    expect(matchClientCert(certs, new URL('https://example.org/'))).toBeNull()
    expect(matchClientCert(certs, new URL('http://api.example.com/'))).toBeNull()
  })

  it('normalizes proxy URLs', () => {
    expect(normalizeProxyUrl(' proxy.corp:3128 ')).toBe('http://proxy.corp:3128')
    expect(normalizeProxyUrl('https://p:8443/')).toBe('https://p:8443')
    expect(normalizeProxyUrl('')).toBe('')
    expect(() => normalizeProxyUrl('socks5://p:1080')).toThrow(/SOCKS/)
    expect(() => normalizeProxyUrl('http://u:pw@p:1')).toThrow(/own fields/)
    expect(() => normalizeProxyUrl('http://p:1/path')).toThrow(/host:port/)
  })
})

describe('dispatchers', () => {
  const config = (over: Partial<NetworkConfig> = {}): NetworkConfig => ({ ...DIRECT_CONFIG, ...over })

  it('reuses one dispatcher per proxy / verification / client certificate and rebuilds after invalidate', async () => {
    let loads = 0
    const d = new NetworkDispatchers({
      load: () => {
        loads++
        return config()
      },
    })
    const x = await d.route(new URL('https://a.example/'))
    const y = await d.route(new URL('https://b.example/'))
    const z = await d.route(new URL('https://a.example/'), { strictSSL: false })
    expect(y.dispatcher).toBe(x.dispatcher)
    expect(z.dispatcher).not.toBe(x.dispatcher)
    expect(x.proxy).toBeNull()
    expect(loads).toBe(1)
    d.invalidate()
    const w = await d.route(new URL('https://a.example/'))
    expect(w.dispatcher).not.toBe(x.dispatcher)
    expect(loads).toBe(2)
    await d.close()
  })

  it('routes through the custom proxy except loopback and bypassed hosts', async () => {
    const d = new NetworkDispatchers({
      load: () => config({ proxy: { mode: 'custom', url: 'http://proxy.corp:3128', username: 'me', password: () => 'pw', bypass: ['*.internal'] } }),
    })
    expect((await d.route(new URL('http://example.com/'))).proxy).toBe('proxy.corp:3128')
    expect(await d.proxyFor(new URL('http://example.com/'))).toBe('http://me:pw@proxy.corp:3128/')
    expect((await d.route(new URL('http://api.internal/'))).proxy).toBeNull()
    expect((await d.route(new URL('http://localhost:3000/'))).proxy).toBeNull()
    expect((await d.route(new URL('http://127.0.0.1:47125/oauth2/callback'))).proxy).toBeNull()
    await d.close()
  })

  it('system mode asks the resolver (Electron) or reads the environment', async () => {
    const asked: string[] = []
    const viaResolver = new NetworkDispatchers({
      load: () => config({ proxy: { ...DIRECT_CONFIG.proxy, mode: 'system' } }),
      resolveSystemProxy: async (url) => (asked.push(url), 'PROXY sys:8080; DIRECT'),
    })
    expect((await viaResolver.route(new URL('https://example.com/x'))).proxy).toBe('sys:8080')
    expect((await viaResolver.route(new URL('https://localhost/x'))).proxy).toBeNull()
    expect(asked).toEqual(['https://example.com/x'])
    const viaEnv = new NetworkDispatchers({ load: () => config({ proxy: { ...DIRECT_CONFIG.proxy, mode: 'system' } }), env: { HTTPS_PROXY: 'http://envp:1' } })
    expect((await viaEnv.route(new URL('https://example.com/'))).proxy).toBe('envp:1')
    const none = new NetworkDispatchers({ load: () => config({ proxy: { ...DIRECT_CONFIG.proxy, mode: 'none' } }), env: { HTTPS_PROXY: 'http://envp:1' } })
    expect((await none.route(new URL('https://example.com/'))).proxy).toBeNull()
    await Promise.all([viaResolver.close(), viaEnv.close(), none.close()])
  })

  it('an unreadable client certificate file fails the send with a pointer to the settings', async () => {
    const d = new NetworkDispatchers({
      load: () =>
        config({ clientCerts: [{ id: 'c', host: 'secure.example', port: null, crtPath: '/nope/c.crt', keyPath: '/nope/c.key', pfxPath: null, passphrase: () => null }] }),
    })
    await expect(d.route(new URL('https://secure.example/'))).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('Settings > Network') })
    await d.close()
  })
})

describe('send errors', () => {
  const failed = (code: string, message = 'boom') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) })

  it('names TLS problems and the settings that fix them', () => {
    const self = describeSendError(failed('DEPTH_ZERO_SELF_SIGNED_CERT'), null)
    expect(self.message).toMatch(/self-signed/)
    expect(self.message).toMatch(/Turn off SSL certificate verification for this request .* Settings > Network/)
    expect(self.details).toEqual({ tls: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    expect(describeSendError(failed('CERT_HAS_EXPIRED'), null).message).toMatch(/expired/)
    expect(describeSendError(failed('ERR_TLS_CERT_ALTNAME_INVALID'), null).message).toMatch(/not valid for this host name/)
    expect(describeSendError(failed('ERR_SSL_WHATEVER', 'odd'), null).message).toMatch(/^SSL error: odd/)
  })

  it('says when the proxy is the problem', () => {
    const route = { dispatcher: null as never, proxy: 'proxy.corp:3128' }
    expect(describeSendError(failed('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:3128'), route).message).toMatch(/^Could not connect to the proxy proxy.corp:3128/)
    const tunnel = Object.assign(new TypeError('fetch failed'), { cause: new Error('Proxy response (407) !== 200 when HTTP Tunneling') })
    const e = describeSendError(tunnel, route)
    expect(e.message).toMatch(/proxy proxy.corp:3128 refused the connection \(HTTP 407\): check the proxy username and password/)
    expect(e.details).toMatchObject({ proxyStatus: 407 })
    // Without a proxy the platform message stays.
    expect(describeSendError(failed('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:80'), null).message).toBe('connect ECONNREFUSED 1.2.3.4:80')
  })
})

// ---- real servers -----------------------------------------------------------------------------------------------------

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

async function startHttps(options: ServerOptions) {
  const sockets = new Set<Socket>()
  const server = createHttpsServer(options, (req, res) => {
    const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate?.()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, client: peer && peer.subject ? peer.subject.CN : null }))
  })
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  server.on('tlsClientError', () => {})
  const port = await listen(server as unknown as Server)
  return {
    port,
    url: `https://127.0.0.1:${port}/`,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

/** A tiny forward proxy: absolute-URI http requests and CONNECT tunnels, all sent to `target` whatever host was asked for. */
async function startProxy(target: () => { http: number; https: number }, opts: { requireAuth?: string; connectStatus?: number } = {}) {
  const seen: Array<{ kind: 'http' | 'connect'; url: string; auth: string | undefined }> = []
  const sockets = new Set<Socket>()
  const denied = (req: IncomingMessage) => opts.requireAuth !== undefined && req.headers['proxy-authorization'] !== opts.requireAuth
  const server = createHttpServer((req, res) => {
    seen.push({ kind: 'http', url: req.url ?? '', auth: req.headers['proxy-authorization'] })
    if (denied(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic' })
      return void res.end()
    }
    const u = new URL(req.url ?? '/')
    const up = httpRequest({ host: '127.0.0.1', port: target().http, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, 'x-via-proxy': '1' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    seen.push({ kind: 'connect', url: req.url ?? '', auth: req.headers['proxy-authorization'] })
    if (opts.connectStatus || denied(req)) {
      client.end(`HTTP/1.1 ${opts.connectStatus ?? 407} Nope\r\n\r\n`)
      return
    }
    const up = netConnect(target().https, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.write(head)
      up.pipe(client)
      client.pipe(up)
    })
    up.on('error', () => client.destroy())
    client.on('error', () => up.destroy())
  })
  server.on('connection', (s: Socket) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  const port = await listen(server)
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    seen,
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

let env: TestEnv
let wsId: string
let tmp: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await scaffold(env)).workspace.id
  tmp = mkdtempSync(join(tmpdir(), 'slinger-net-'))
})
afterEach(() => {
  env.cleanup()
  rmSync(tmp, { recursive: true, force: true })
})

const send = (over: Partial<HttpRequestInput> & { url: string }) => env.api.executeHttpRequest(baseHttp(wsId, over))
const grant = async (name: string) => (await pickAndGrant(env, fixturePath(name)))!

describe('SSL certificate verification (real HTTPS servers)', () => {
  const servers: Array<Awaited<ReturnType<typeof startHttps>>> = []
  let signed: Awaited<ReturnType<typeof startHttps>>
  let selfSigned: Awaited<ReturnType<typeof startHttps>>
  let expired: Awaited<ReturnType<typeof startHttps>>
  let wrongHost: Awaited<ReturnType<typeof startHttps>>
  beforeAll(async () => {
    const key = fixture('server.key')
    signed = await startHttps({ key, cert: fixture('server.crt') })
    selfSigned = await startHttps({ key, cert: fixture('self-signed.crt') })
    expired = await startHttps({ key, cert: fixture('expired.crt') })
    wrongHost = await startHttps({ key, cert: fixture('wronghost.crt') })
    servers.push(signed, selfSigned, expired, wrongHost)
  })
  afterAll(async () => {
    for (const s of servers) await s.close()
  })

  it('refuses an untrusted CA by default and explains how to fix it', async () => {
    await expect(send({ url: signed.url })).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringMatching(/^SSL error: .*not trusted.*Settings > Network/),
    })
  })

  it("the request's SSL setting turns verification off, and on again over the app setting", async () => {
    expect((await send({ url: signed.url, strictSSL: false })).status).toBe(200)
    await env.api.setNetworkSettings({ verifySsl: false })
    expect((await send({ url: signed.url })).status).toBe(200)
    await expect(send({ url: signed.url, strictSSL: true })).rejects.toMatchObject({ code: 'network_error' })
  })

  it('trusts an added CA certificate (and only after it was added)', async () => {
    const path = await grant('ca.crt')
    const settings = await env.api.addNetworkCaCertificates([path])
    expect(settings.caCertificates).toMatchObject([{ name: 'ca.crt', subject: 'Slinger Test CA' }])
    expect((await send({ url: signed.url })).status).toBe(200)
    await env.api.removeNetworkCaCertificate(settings.caCertificates[0]!.id)
    await expect(send({ url: signed.url })).rejects.toMatchObject({ code: 'network_error' })
  })

  it('names self-signed, expired and wrong-host certificates', async () => {
    await env.api.addNetworkCaCertificates([await grant('ca.crt')])
    await expect(send({ url: selfSigned.url })).rejects.toMatchObject({ message: expect.stringContaining('self-signed'), details: { tls: 'DEPTH_ZERO_SELF_SIGNED_CERT' } })
    await expect(send({ url: expired.url })).rejects.toMatchObject({ message: expect.stringContaining('has expired'), details: { tls: 'CERT_HAS_EXPIRED' } })
    await expect(send({ url: wrongHost.url })).rejects.toMatchObject({
      message: expect.stringContaining('not valid for this host name'),
      details: { tls: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    })
    expect((await send({ url: expired.url, strictSSL: false })).status).toBe(200)
  })

  it('applies to pm.sendRequest-style sends, OAuth 2.0 token requests and OpenAPI downloads through the router', async () => {
    // The router is what those callers get from core (scriptHttp, OAuth2Service, OpenApiService).
    await env.api.addNetworkCaCertificates([await grant('ca.crt')])
    expect((await executeHttp(req({ url: signed.url }), { network: env.core.network })).status).toBe(200)
    await expect(executeHttp(req({ url: signed.url }))).rejects.toMatchObject({ code: 'network_error' })
    const res = await networkFetch(env.core.network)(signed.url)
    expect(res.status).toBe(200)
    await expect(networkFetch(env.core.network)(selfSigned.url)).rejects.toThrow(/self-signed/)
  })
})

describe('client certificates (real HTTPS server)', () => {
  let server: Awaited<ReturnType<typeof startHttps>>
  beforeAll(async () => {
    server = await startHttps({ key: fixture('server.key'), cert: fixture('server.crt'), ca: fixture('client-ca.crt'), requestCert: true, rejectUnauthorized: true })
  })
  afterAll(() => server.close())

  it('is refused without a certificate, accepted with PEM files or a PFX', async () => {
    await env.api.addNetworkCaCertificates([await grant('ca.crt')])
    await expect(send({ url: server.url })).rejects.toMatchObject({ code: 'network_error', message: expect.stringContaining('client certificate') })

    let settings = await env.api.saveNetworkClientCertificate({ host: '127.0.0.1', crtPath: await grant('client.crt'), keyPath: await grant('client.key') })
    expect(settings.clientCertificates).toMatchObject([{ host: '127.0.0.1', port: null, hasPassphrase: false }])
    const res = await send({ url: server.url })
    expect(JSON.parse(res.bodyText!)).toEqual({ ok: true, client: 'slinger-test-client' })

    // Another port: not sent.
    const id = settings.clientCertificates[0]!.id
    await env.api.saveNetworkClientCertificate({ id, host: '127.0.0.1', port: server.port + 1 > 65535 ? 1 : server.port + 1, crtPath: settings.clientCertificates[0]!.crtPath, keyPath: settings.clientCertificates[0]!.keyPath })
    await expect(send({ url: server.url })).rejects.toMatchObject({ code: 'network_error' })

    settings = await env.api.saveNetworkClientCertificate({ id, host: '127.0.0.1', port: server.port, pfxPath: await grant('client.pfx'), passphrase: 'test-pass' })
    expect(settings.clientCertificates).toMatchObject([{ pfxPath: fixturePath('client.pfx'), crtPath: null, hasPassphrase: true }])
    expect(env.secrets.get(clientCertPassphraseKey(id))).toBe('test-pass')
    expect(JSON.parse((await send({ url: server.url })).bodyText!).client).toBe('slinger-test-client')

    await env.api.saveNetworkClientCertificate({ id, host: '127.0.0.1', pfxPath: fixturePath('client.pfx'), passphrase: 'wrong' })
    await expect(send({ url: server.url })).rejects.toMatchObject({ message: expect.stringContaining('client certificate for this host could not be used') })
  })
})

describe('proxy (real local proxy)', () => {
  let target: Server
  let targetPort: number
  let tls: Awaited<ReturnType<typeof startHttps>>
  let proxy: Awaited<ReturnType<typeof startProxy>>
  beforeAll(async () => {
    target = createHttpServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: req.url, viaProxy: req.headers['x-via-proxy'] === '1' }))
    })
    targetPort = await listen(target)
    tls = await startHttps({ key: fixture('server.key'), cert: fixture('server.crt') })
    proxy = await startProxy(() => ({ http: targetPort, https: tls.port }))
  })
  afterAll(async () => {
    await proxy.close()
    await tls.close()
    await new Promise((r) => target.close(r))
  })
  beforeEach(() => {
    proxy.seen.length = 0
  })

  it('sends http through a custom proxy (absolute URI) and https through a CONNECT tunnel', async () => {
    await env.api.setNetworkSettings({ proxy: { mode: 'custom', url: proxy.url } })
    const res = await send({ url: 'http://api.slinger-proxy-test.invalid/hello?x=1' })
    expect(JSON.parse(res.bodyText!)).toEqual({ path: '/hello?x=1', viaProxy: true })
    expect(proxy.seen).toEqual([{ kind: 'http', url: 'http://api.slinger-proxy-test.invalid/hello?x=1', auth: undefined }])
    const secure = await send({ url: 'https://api.slinger-proxy-test.invalid/', strictSSL: false })
    expect(JSON.parse(secure.bodyText!).ok).toBe(true)
    expect(proxy.seen[1]).toEqual({ kind: 'connect', url: 'api.slinger-proxy-test.invalid:443', auth: undefined })
  })

  it('never proxies loopback hosts, and skips bypassed hosts', async () => {
    await env.api.setNetworkSettings({ proxy: { mode: 'custom', url: proxy.url, bypass: ['*.slinger-proxy-test.invalid'] } })
    expect(JSON.parse((await send({ url: `http://127.0.0.1:${targetPort}/direct` })).bodyText!).viaProxy).toBe(false)
    expect(JSON.parse((await send({ url: `http://localhost:${targetPort}/direct` })).bodyText!).viaProxy).toBe(false)
    await expect(send({ url: 'http://api.slinger-proxy-test.invalid/' })).rejects.toMatchObject({ code: 'network_error' })
    expect(proxy.seen).toEqual([])
  })

  it('authenticates with the username and the keychain password', async () => {
    const authProxy = await startProxy(() => ({ http: targetPort, https: tls.port }), { requireAuth: `Basic ${Buffer.from('me:pa:ss').toString('base64')}` })
    try {
      let s = await env.api.setNetworkSettings({ proxy: { mode: 'custom', url: authProxy.url, username: 'me', password: 'pa:ss' } })
      expect(s.proxy).toEqual({ mode: 'custom', url: authProxy.url, username: 'me', hasPassword: true, bypass: [] })
      expect(JSON.stringify(s)).not.toContain('pa:ss')
      expect(env.secrets.get(PROXY_PASSWORD_KEY)).toBe('pa:ss')
      expect(JSON.stringify(env.core.db.prepare('SELECT * FROM app_settings').all())).not.toContain('pa:ss')
      expect(JSON.parse((await send({ url: 'http://x.slinger-proxy-test.invalid/' })).bodyText!).viaProxy).toBe(true)
      expect((await send({ url: 'https://x.slinger-proxy-test.invalid/', strictSSL: false })).status).toBe(200)

      s = await env.api.setNetworkSettings({ proxy: { password: '' } })
      expect(s.proxy.hasPassword).toBe(false)
      expect(env.secrets.get(PROXY_PASSWORD_KEY)).toBeNull()
      await expect(send({ url: 'http://x.slinger-proxy-test.invalid/' })).rejects.toMatchObject({
        message: expect.stringContaining(`The proxy 127.0.0.1:${authProxy.port} refused the connection (HTTP 407): check the proxy username and password`),
      })
      await expect(send({ url: 'https://x.slinger-proxy-test.invalid/', strictSSL: false })).rejects.toMatchObject({
        message: expect.stringContaining(`The proxy 127.0.0.1:${authProxy.port} refused the connection (HTTP 407)`),
      })
    } finally {
      await authProxy.close()
    }
  })

  it('a proxy that is down is named in the error', async () => {
    const port = await closedPort()
    await env.api.setNetworkSettings({ proxy: { mode: 'custom', url: `http://127.0.0.1:${port}` } })
    await expect(send({ url: 'http://x.slinger-proxy-test.invalid/' })).rejects.toMatchObject({
      message: expect.stringContaining(`Could not connect to the proxy 127.0.0.1:${port}`),
      details: { proxy: `127.0.0.1:${port}` },
    })
  })

  it('system mode uses HTTP(S)_PROXY / NO_PROXY without Electron', async () => {
    const db = openDatabase(':memory:')
    runMigrations(db, MIGRATIONS_DIR)
    const service = new NetworkSettingsService({
      db,
      secrets: new MemorySecretStore(),
      files: new FileGrants(),
      env: { HTTP_PROXY: proxy.url, NO_PROXY: 'skip.slinger-proxy-test.invalid' },
    })
    const res = await executeHttp(req({ url: 'http://env.slinger-proxy-test.invalid/e' }), { network: service })
    expect(JSON.parse(res.bodyText!).viaProxy).toBe(true)
    await expect(executeHttp(req({ url: 'http://skip.slinger-proxy-test.invalid/' }), { network: service })).rejects.toBeTruthy()
    expect(proxy.seen.map((x) => x.url)).toEqual(['http://env.slinger-proxy-test.invalid/e'])
    service.update({ proxy: { mode: 'none' } })
    await expect(executeHttp(req({ url: 'http://env.slinger-proxy-test.invalid/e' }), { network: service })).rejects.toBeTruthy()
    expect(proxy.seen).toHaveLength(1)
    await service.dispatchers.close()
    db.close()
  })
})

describe('network settings service and IPC', () => {
  it('has defaults', async () => {
    expect(await env.api.getNetworkSettings()).toEqual({
      verifySsl: true,
      caCertificates: [],
      clientCertificates: [],
      proxy: { mode: 'system', url: '', username: '', hasPassword: false, bypass: [] },
    })
  })

  it('updates only what is given and validates the proxy', async () => {
    let s = await env.api.setNetworkSettings({ verifySsl: false })
    expect(s.verifySsl).toBe(false)
    s = await env.api.setNetworkSettings({ proxy: { mode: 'custom', url: 'proxy.corp:3128', bypass: [' a.com ', '', '*.b.com'] } })
    expect(s.proxy).toMatchObject({ mode: 'custom', url: 'http://proxy.corp:3128', bypass: ['a.com', '*.b.com'] })
    expect(s.verifySsl).toBe(false)
    s = await env.api.setNetworkSettings({ proxy: { mode: 'none' } })
    expect(s.proxy).toMatchObject({ mode: 'none', url: 'http://proxy.corp:3128' })
    await expect(env.api.setNetworkSettings({ proxy: { mode: 'custom', url: '' } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.setNetworkSettings({ proxy: { url: 'socks5://p:1' } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.setNetworkSettings({ proxy: { username: 'a:b' } })).rejects.toMatchObject({ code: 'invalid_input' })
    // zod: unknown keys, wrong types
    for (const bad of [{ verifySsl: 'no' }, { proxy: { mode: 'pac' } }, { proxy: { hasPassword: true } }, { other: 1 }]) {
      await expect(env.api.setNetworkSettings(bad as never)).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('adds CA certificates only from files chosen in the dialog, one row per certificate, without duplicates', async () => {
    await expect(env.api.addNetworkCaCertificates([fixturePath('ca.crt')])).rejects.toMatchObject({ details: { reason: 'file_not_granted' } })
    const bundle = join(tmp, 'bundle.pem')
    writeFileSync(bundle, `${fixture('ca.crt')}\n${fixture('client-ca.crt')}`)
    let s = await env.api.addNetworkCaCertificates([(await pickAndGrant(env, bundle))!])
    expect(s.caCertificates.map((c) => [c.name, c.subject])).toEqual([
      ['bundle.pem #1', 'Slinger Test CA'],
      ['bundle.pem #2', 'Slinger Test Client CA'],
    ])
    expect(s.caCertificates[0]!.expiresAt).toBeGreaterThan(Date.now() / 1000)
    s = await env.api.addNetworkCaCertificates([await grant('ca.crt')])
    expect(s.caCertificates).toHaveLength(2)
    const der = join(tmp, 'ca.der')
    writeFileSync(der, Buffer.from(fixture('ca.crt').toString().replace(/-----[^-]+-----|\s/g, ''), 'base64'))
    await env.api.removeNetworkCaCertificate(s.caCertificates[0]!.id)
    s = await env.api.addNetworkCaCertificates([(await pickAndGrant(env, der))!])
    expect(s.caCertificates.map((c) => c.subject)).toEqual(['Slinger Test Client CA', 'Slinger Test CA'])
    const junk = join(tmp, 'junk.txt')
    writeFileSync(junk, 'hello')
    await expect(env.api.addNetworkCaCertificates([(await pickAndGrant(env, junk))!])).rejects.toMatchObject({
      message: expect.stringContaining('not a certificate file'),
    })
    await expect(env.api.removeNetworkCaCertificate('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('client certificates: granted files, host validation, passphrase in the keychain only', async () => {
    const crt = await grant('client.crt')
    const key = await grant('client.key')
    await expect(env.api.saveNetworkClientCertificate({ host: 'https://api.example.com/', crtPath: crt, keyPath: key })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.saveNetworkClientCertificate({ host: 'api.example.com', crtPath: crt })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.saveNetworkClientCertificate({ host: 'api.example.com', pfxPath: fixturePath('client.pfx') })).rejects.toMatchObject({
      details: { reason: 'file_not_granted' },
    })
    await expect(env.api.saveNetworkClientCertificate({ host: 'a.com', crtPath: crt, keyPath: key, port: 0 })).rejects.toMatchObject({ code: 'invalid_input' })
    let s = await env.api.saveNetworkClientCertificate({ host: '*.Example.com', port: 8443, crtPath: crt, keyPath: key, passphrase: 'pp' })
    const c = s.clientCertificates[0]!
    expect(c).toMatchObject({ host: '*.example.com', port: 8443, crtPath: crt, keyPath: key, pfxPath: null, hasPassphrase: true })
    expect(JSON.stringify(s)).not.toContain('"pp"')
    expect(JSON.stringify(env.core.db.prepare('SELECT * FROM network_client_certs').all())).not.toContain('"pp"')
    // Saved paths may come back unchanged in a later session (no new grant needed); new ones must be granted.
    const fresh = makeEnv()
    try {
      fresh.core.db.prepare(
        "INSERT INTO network_client_certs (id, host, port, crt_path, key_path, pfx_path, has_passphrase, created_at) VALUES (?, 'a.com', NULL, ?, ?, NULL, 0, 0)",
      ).run(c.id, crt, key)
      await expect(fresh.api.saveNetworkClientCertificate({ id: c.id, host: 'b.com', crtPath: crt, keyPath: key })).resolves.toMatchObject({
        clientCertificates: [{ host: 'b.com' }],
      })
      await expect(fresh.api.saveNetworkClientCertificate({ id: c.id, host: 'b.com', crtPath: crt, keyPath: fixturePath('server.key') })).rejects.toMatchObject({
        details: { reason: 'file_not_granted' },
      })
    } finally {
      fresh.cleanup()
    }
    s = await env.api.saveNetworkClientCertificate({ id: c.id, host: '*.example.com', crtPath: crt, keyPath: key })
    expect(s.clientCertificates[0]!.hasPassphrase).toBe(true) // absent = keep
    s = await env.api.saveNetworkClientCertificate({ id: c.id, host: '*.example.com', crtPath: crt, keyPath: key, passphrase: null })
    expect(s.clientCertificates[0]!.hasPassphrase).toBe(false)
    await env.api.saveNetworkClientCertificate({ id: c.id, host: '*.example.com', crtPath: crt, keyPath: key, passphrase: 'again' })
    s = await env.api.removeNetworkClientCertificate(c.id)
    expect(s.clientCertificates).toEqual([])
    expect(env.secrets.get(clientCertPassphraseKey(c.id))).toBeNull()
    await expect(env.api.removeNetworkClientCertificate(c.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(env.api.saveNetworkClientCertificate({ id: c.id, host: 'a.com', crtPath: crt, keyPath: key })).rejects.toMatchObject({ code: 'not_found' })
  })
})
