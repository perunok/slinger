/**
 * pm.sendRequest end to end: scripts run through the IPC API (ScriptService + InlineExecutor + the real sandbox),
 * requests go through the app's HTTP engine to a local HTTP server (real sockets, no mocks).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunScriptsInput, ScriptSource } from '../../../shared/types'
import { baseHttp, closedPort, makeEnv, pickAndGrant, scaffold, type TestEnv } from '../helpers'
import { run } from './harness'

interface Seen {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: string
}

async function startServer() {
  const seen: Seen[] = []
  const sockets = new Set<import('node:net').Socket>()
  const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(value))
  }
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
      seen.push(s)
      const url = new URL(req.url ?? '/', 'http://x')
      switch (url.pathname) {
        case '/oauth/token': {
          let body: { client_id?: string; client_secret?: string } = {}
          try {
            body = JSON.parse(s.body)
          } catch {
            /* not JSON */
          }
          if (body.client_secret !== 'shh') return json(res, 401, { error: 'invalid_client' })
          return json(res, 200, { access_token: `tok-${body.client_id}`, token_type: 'Bearer', expires_in: 3600 })
        }
        case '/api/me':
          if (req.headers.authorization !== 'Bearer tok-slinger') return json(res, 401, { error: 'unauthorized' })
          return json(res, 200, { me: 'slinger' })
        case '/status/404':
          return json(res, 404, { error: 'nope' })
        case '/slow':
          return // never answers
        case '/delay':
          return void setTimeout(() => json(res, 200, { delayed: Number(url.searchParams.get('ms')) }), Number(url.searchParams.get('ms') ?? 100))
        default:
          return json(res, 200, { method: s.method, url: s.url, headers: s.headers, body: s.body }, { 'X-Custom': 'yes', 'Set-Cookie': 'sid=abc; Path=/' })
      }
    })
  })
  server.on('connection', (sock) => {
    sockets.add(sock)
    sock.on('close', () => sockets.delete(sock))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    async close() {
      for (const sock of sockets) sock.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

let env: TestEnv
let server: Awaited<ReturnType<typeof startServer>>
let wsId: string
let envId: string
const SECRET = 'client-secret-shh'

beforeEach(async () => {
  env = makeEnv()
  server = await startServer()
  wsId = (await scaffold(env)).workspace.id
  envId = (await env.api.createEnvironment(wsId, 'UAT')).id
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'baseUrl', value: server.base, isSecret: false })
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'authUrl', value: `${server.base}/oauth/token`, isSecret: false })
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'clientSecret', value: 'shh', isSecret: true })
  await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'apiKey', value: SECRET, isSecret: true })
})
afterEach(async () => {
  await server.close()
  env.cleanup()
})

let seq = 0
function input(code: string | ScriptSource[], over: Partial<RunScriptsInput> = {}): RunScriptsInput {
  seq++
  return {
    runId: `sr-${seq}`,
    sessionId: 'session-sr',
    workspaceId: wsId,
    environmentId: envId,
    event: 'prerequest',
    scripts: typeof code === 'string' ? [{ origin: 'request', name: 'R', code }] : code,
    request: { method: 'GET', url: '{{baseUrl}}/api/me', headers: [], body: { mode: 'none' } },
    response: null,
    variables: {},
    collectionVariables: {},
    globals: {},
    info: { requestName: 'R', requestId: null, iteration: 0, iterationCount: 1 },
    ...over,
  }
}
const runIt = (code: string | ScriptSource[], over: Partial<RunScriptsInput> = {}) => env.api.runScripts(input(code, over))

describe('pm.sendRequest: forms and the response API', () => {
  it('URL string + callback: the Postman response API', async () => {
    const r = await runIt(`
      pm.sendRequest(pm.environment.get('baseUrl') + '/echo?x=1', function (err, res) {
        pm.variables.set('err', err)
        pm.variables.set('code', res.code)
        pm.variables.set('status', res.status)
        pm.variables.set('custom', res.headers.get('x-custom'))
        pm.variables.set('hasCustom', res.headers.has('X-Custom'))
        pm.variables.set('ctype', res.headers.toObject()['content-type'])
        pm.variables.set('method', res.json().method)
        pm.variables.set('textHasUrl', res.text().includes('/echo?x=1'))
        pm.variables.set('timeOk', typeof res.responseTime === 'number' && res.responseTime >= 0)
        pm.variables.set('size', res.responseSize > 0)
        pm.variables.set('cookie', res.cookies.get('sid'))
        pm.expect(res).to.have.status(200)
        pm.expect(res.code).to.equal(200)
      })
    `)
    expect(r.errors).toEqual([])
    expect(r.variables).toEqual({
      err: null, code: 200, status: 'OK', custom: 'yes', hasCustom: true, ctype: 'application/json', method: 'GET',
      textHasUrl: true, timeOk: true, size: true, cookie: 'abc',
    })
  })

  it('promise form: top-level await, .then, and an async IIFE', async () => {
    const r = await runIt(`
      const res = await pm.sendRequest({ url: pm.environment.get('baseUrl') + '/echo', method: 'GET' })
      pm.variables.set('a', res.code)
      pm.sendRequest(pm.environment.get('baseUrl') + '/echo').then((res2) => pm.variables.set('b', res2.json().method))
      ;(async () => { const r3 = await pm.sendRequest(pm.environment.get('baseUrl') + '/status/404'); pm.variables.set('c', r3.code) })()
    `)
    expect(r.errors).toEqual([])
    expect(r.variables).toEqual({ a: 200, b: 'GET', c: 404 })
  })

  it('an error thrown after a top-level await fails the script with its line', async () => {
    const r = await runIt(`const res = await pm.sendRequest(pm.environment.get('baseUrl') + '/echo')\n\nthrow new Error('after ' + res.code)`)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toMatch(/Error: after 200 \(line 3\)/)
  })

  it('POST raw JSON (language sets Content-Type), urlencoded and formdata; headers as a list or an object', async () => {
    const r = await runIt(`
      const base = pm.environment.get('baseUrl')
      pm.sendRequest({ url: base + '/raw', method: 'POST', header: [{ key: 'X-A', value: '1' }, { key: 'X-Off', value: 'no', disabled: true }],
        body: { mode: 'raw', raw: JSON.stringify({ a: 1 }), options: { raw: { language: 'json' } } } }, () => {})
      pm.sendRequest({ url: base + '/form', method: 'POST', header: { 'X-B': '2' },
        body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'scope', value: 'a b' }] } }, () => {})
      pm.sendRequest({ url: base + '/multi', method: 'POST', header: 'X-C: 3',
        body: { mode: 'formdata', formdata: [{ key: 'name', value: 'slinger', type: 'text' }] } }, () => {})
    `)
    expect(r.errors).toEqual([])
    const byPath = (p: string) => server.seen.find((s) => s.url === p)!
    expect(byPath('/raw')).toMatchObject({ method: 'POST', body: '{"a":1}' })
    expect(byPath('/raw').headers['content-type']).toBe('application/json')
    expect(byPath('/raw').headers['x-a']).toBe('1')
    expect(byPath('/raw').headers['x-off']).toBeUndefined()
    expect(byPath('/form').body).toBe('grant_type=client_credentials&scope=a+b')
    expect(byPath('/form').headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(byPath('/form').headers['x-b']).toBe('2')
    expect(byPath('/multi').headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(byPath('/multi').body).toContain('slinger')
    expect(byPath('/multi').headers['x-c']).toBe('3')
  })

  it('bearer auth and graphql bodies; {{variables}} are resolved like Postman', async () => {
    await env.api.upsertEnvironmentVariable({ environmentId: envId, key: 'token', value: 'tok-slinger', isSecret: false })
    const r = await runIt(`
      pm.sendRequest({ url: '{{baseUrl}}/api/me', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] } }, (err, res) => pm.variables.set('me', res.json().me))
      pm.sendRequest({ url: '{{baseUrl}}/gql', method: 'POST', body: { mode: 'graphql', graphql: { query: '{ me }', variables: '{"id": 1}' } } }, () => {})
    `)
    expect(r.errors).toEqual([])
    expect(r.variables.me).toBe('slinger')
    const gql = server.seen.find((s) => s.url === '/gql')!
    expect(JSON.parse(gql.body)).toEqual({ query: '{ me }', variables: { id: 1 } })
    expect(gql.headers['content-type']).toBe('application/json')
  })

  it('4xx/5xx are responses, not errors; a network failure calls back with an Error and rejects the promise', async () => {
    const port = await closedPort()
    const r = await runIt(`
      pm.sendRequest(pm.environment.get('baseUrl') + '/status/404', (err, res) => { pm.variables.set('e404', err); pm.variables.set('c404', res.code) })
      pm.sendRequest('http://127.0.0.1:${port}/x', (err, res) => {
        pm.variables.set('isError', err instanceof Error)
        pm.variables.set('msg', err && err.message.length > 0)
        pm.variables.set('res', res)
      })
      pm.sendRequest('http://127.0.0.1:${port}/y').catch((e) => pm.variables.set('rejected', e instanceof Error))
    `)
    expect(r.errors).toEqual([])
    expect(r.variables).toEqual({ e404: null, c404: 404, isError: true, msg: true, res: null, rejected: true })
  })

  it('nested (a callback sends again) and concurrent sends (Promise.all) all complete before the script ends', async () => {
    const r = await runIt(`
      const base = pm.environment.get('baseUrl')
      pm.sendRequest(base + '/echo?n=1', () => {
        pm.sendRequest(base + '/echo?n=2', () => {
          pm.sendRequest(base + '/echo?n=3', (e, res) => pm.variables.set('nested', res.json().url))
        })
      })
      Promise.all([150, 100, 50].map((ms) => pm.sendRequest(base + '/delay?ms=' + ms))).then((all) =>
        pm.variables.set('all', all.map((x) => x.json().delayed)))
    `)
    expect(r.errors).toEqual([])
    expect(r.variables).toEqual({ nested: '/echo?n=3', all: [150, 100, 50] })
  })

  it('a callback that throws fails the script', async () => {
    const r = await runIt(`pm.sendRequest(pm.environment.get('baseUrl') + '/echo', () => { throw new Error('boom') })`)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].message).toMatch(/Error: boom/)
  })
})

describe('pm.sendRequest: the collection-level token flow', () => {
  const TOKEN_SCRIPT = `
    pm.sendRequest({
      url: pm.environment.get('authUrl'),
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      body: { mode: 'raw', raw: JSON.stringify({ client_id: 'slinger', client_secret: pm.environment.get('clientSecret') }) },
    }, (err, res) => {
      if (err) throw err
      pm.environment.set('token', res.json().access_token)
    })
  `

  it('the collection pre-request script stores the token; the main request uses {{token}} (through runScripts + executeHttpRequest)', async () => {
    const pre = await runIt([{ origin: 'collection', name: 'enat uat', code: TOKEN_SCRIPT }])
    expect(pre.errors).toEqual([])
    expect(pre.environmentChanged).toBe(true)
    const token = (await env.api.listEnvironmentVariables(envId)).find((v) => v.key === 'token')!.value
    expect(token).toBe('tok-slinger')
    const auth = server.seen.find((s) => s.url === '/oauth/token')!
    expect(auth.headers['content-type']).toBe('application/json')
    expect(JSON.parse(auth.body)).toEqual({ client_id: 'slinger', client_secret: 'shh' })

    // The renderer resolves {{token}} from the refreshed environment and sends the main request.
    const res = await env.api.executeHttpRequest(
      baseHttp(wsId, { url: `${server.base}/api/me`, headers: [{ key: 'Authorization', value: `Bearer ${token}` }], scriptSessionId: 'session-sr' }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.bodyText!)).toEqual({ me: 'slinger' })
  })

  it('sendRequest calls are not written to history; each one is one redacted console line', async () => {
    const r = await runIt(`
      const key = pm.environment.get('apiKey')
      pm.sendRequest({ url: pm.environment.get('baseUrl') + '/echo?key=' + key, header: { 'X-Api-Key': key } }, () => {})
      pm.sendRequest('http://user:pw@127.0.0.1:1/unreachable', () => {})
    `)
    expect(r.errors).toEqual([])
    expect(await env.api.listHistory(wsId)).toEqual([])
    const lines = r.console.filter((c) => c.message.startsWith('→')).sort((a, b) => (a.message.includes('unreachable') ? 1 : 0) - (b.message.includes('unreachable') ? 1 : 0))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ level: 'info', message: expect.stringMatching(new RegExp(`^→ GET ${server.base}/echo\\?key=\\{\\{apiKey\\}\\} 200 \\(\\d+ ms\\)$`)) })
    expect(lines[1].message).toMatch(/^→ GET http:\/\/\*\*\*@127\.0\.0\.1:1\/unreachable failed: .+ \(\d+ ms\)$/)
    expect(JSON.stringify(r.console)).not.toContain(SECRET)
    expect(JSON.stringify(r.console)).not.toContain('user:pw')
  })

  it('works in read-only (viewer) sync workspaces too (it changes nothing locally)', async () => {
    const { insertLink } = await import('../../sync/linking')
    insertLink(env.core.db, {
      workspaceId: wsId, apiBaseUrl: 'http://x', remoteWorkspaceId: 'r', remoteName: 'R', role: 'viewer',
      clientId: null, checkpoint: 0, snapshotCursor: null, userId: null, nowS: 1,
    })
    const r = await runIt(`pm.sendRequest(pm.environment.get('baseUrl') + '/echo', (e, res) => pm.variables.set('c', res.code))`)
    expect(r.errors).toEqual([])
    expect(r.variables.c).toBe(200)
  })
})

describe('pm.sendRequest: limits and safety', () => {
  it('at most 20 per script run', async () => {
    const r = await runIt(`
      const base = pm.environment.get('baseUrl')
      let n = 0
      try { for (let i = 0; i < 25; i++) { pm.sendRequest(base + '/echo', () => {}); n++ } } catch (e) { pm.variables.set('msg', e.message) }
      pm.variables.set('n', n)
    `)
    expect(r.errors).toEqual([])
    expect(r.variables.n).toBe(20)
    expect(r.variables.msg).toMatch(/at most 20 requests per script run/)
    expect(server.seen).toHaveLength(20)
  })

  it('only http and https URLs', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'data://text/plain,hi']) {
      const r = await runIt(`pm.sendRequest(${JSON.stringify(url)}, () => {})`)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0].message).toMatch(/only http and https URLs/)
    }
    // A missing scheme gets http:// like the main request.
    const ok = await runIt(`pm.sendRequest(${JSON.stringify(server.base.replace('http://', '') + '/echo')}, (e, res) => pm.variables.set('c', res.code))`)
    expect(ok.variables.c).toBe(200)
  })

  it('form-data / file bodies may only use files granted with pickFile in this session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slinger-sr-'))
    try {
      const secret = join(dir, 'secret.txt')
      const allowed = join(dir, 'allowed.txt')
      writeFileSync(secret, 'TOP SECRET')
      writeFileSync(allowed, 'ALLOWED')
      const send = (path: string) =>
        runIt(`
          pm.sendRequest({ url: pm.environment.get('baseUrl') + '/upload', method: 'POST', body: { mode: 'formdata', formdata: [{ key: 'f', type: 'file', src: ${JSON.stringify(path)} }] } },
            (err, res) => pm.variables.set('out', err ? 'error: ' + err.message : res.code))
          pm.sendRequest({ url: pm.environment.get('baseUrl') + '/put', method: 'PUT', body: { mode: 'file', file: { src: ${JSON.stringify(path)} } } },
            (err, res) => pm.variables.set('bin', err ? 'error: ' + err.message : res.code))
        `)
      const denied = await send(secret)
      expect(denied.variables.out).toMatch(/error: .*not granted/)
      expect(denied.variables.bin).toMatch(/error: .*not granted/)
      expect(server.seen).toHaveLength(0)
      await pickAndGrant(env, allowed)
      const ok = await send(allowed)
      expect(ok.variables).toEqual({ out: 200, bin: 200 })
      expect(server.seen.find((s) => s.url === '/put')!.body).toBe('ALLOWED')
      expect(server.seen.find((s) => s.url === '/upload')!.body).toContain('ALLOWED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cancelHttpRequest aborts an in-flight send and stops the script', async () => {
    const started = Date.now()
    const pending = runIt(`pm.sendRequest(pm.environment.get('baseUrl') + '/slow', (err) => pm.variables.set('called', true))`, { runId: 'cancel-send' })
    while (!server.seen.some((s) => s.url === '/slow')) await new Promise((r) => setTimeout(r, 10))
    await env.api.cancelHttpRequest('cancel-send')
    const r = await pending
    expect(r.errors[0]).toMatchObject({ kind: 'cancelled' })
    expect(r.variables.called).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('waiting for a response does not use the script CPU budget', async () => {
    // A 300 ms script limit and a 700 ms response: the script still finishes.
    const r = await runIt(`pm.sendRequest(pm.environment.get('baseUrl') + '/delay?ms=700', (e, res) => pm.variables.set('d', res.json().delayed))`, { timeoutMs: 300 })
    expect(r.errors).toEqual([])
    expect(r.variables.d).toBe(700)
  })

  it('a per-call timeout is honoured, capped by the request timeout', async () => {
    const r = await runIt(`pm.sendRequest({ url: pm.environment.get('baseUrl') + '/slow', timeout: 200 }, (err) => pm.variables.set('msg', err.message))`, {
      sendRequestTimeoutMs: 5000,
    })
    expect(r.errors).toEqual([])
    expect(r.variables.msg).toMatch(/timed out after 200 ms/)
  })
})

describe('pm.sendRequest in the bare sandbox (limits)', () => {
  it('the wall-clock cap stops a script that waits too long, and in-flight sends are aborted', async () => {
    let aborted = false
    const started = Date.now()
    const r = await run(
      { code: `pm.sendRequest('http://example.test/x', () => pm.variables.set('called', true))`, limits: { ...(await import('../../scripts/job')).DEFAULT_LIMITS, timeoutMs: 100, wallClockMs: 400 } },
      {
        sendHttp: (_call, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true
              resolve({ ok: false, error: 'Request cancelled', logLine: 'x' })
            })
          }),
      },
    )
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ kind: 'timeout', message: expect.stringMatching(/did not finish within .* pm\.sendRequest/) })
    expect(r.variables.called).toBeUndefined()
    expect(aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('without a host transport, pm.sendRequest says it is unavailable', async () => {
    const r = await run({ code: `pm.sendRequest('https://example.com', () => {})` })
    expect(r.errors[0].message).toMatch(/pm\.sendRequest is not available here/)
  })
})
