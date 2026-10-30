/**
 * The cookie jar end to end: storage (values encrypted at rest), the IPC methods, sends through the HTTP pipeline to a
 * real local server (a login's cookie goes with the next request), pm.sendRequest and pm.cookies.jar() in scripts, and
 * the MCP output redaction.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunScriptsInput } from '../../shared/types'
import { CookieService, COOKIE_KEY_REF } from '../services/cookieJar'
import { MemorySecretStore } from '../services/secrets'
import { baseHttp, makeEnv, scaffold, type TestEnv } from './helpers'

interface Seen {
  url: string
  cookie: string | undefined
}

/** /login sets cookies; every other path echoes the Cookie header it got. */
async function startServer() {
  const seen: Seen[] = []
  const sockets = new Set<import('node:net').Socket>()
  const server: Server = createServer((req: IncomingMessage, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ url: req.url ?? '', cookie: req.headers.cookie })
      const path = (req.url ?? '').split('?')[0]
      if (path === '/login') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': ['session=s3cr3t-session-id; Path=/; HttpOnly; SameSite=Lax', 'theme=dark; Path=/ui; Max-Age=3600', 'bad=1; Domain=evil.com'],
        })
        return void res.end('{"ok":true}')
      }
      if (path === '/logout') {
        res.writeHead(200, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' })
        return void res.end('bye')
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }))
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    last: () => seen[seen.length - 1]!,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}

let env: TestEnv
let server: Awaited<ReturnType<typeof startServer>>
let ws: string

beforeEach(async () => {
  env = makeEnv()
  server = await startServer()
  ws = (await scaffold(env)).workspace.id
})
afterEach(async () => {
  await server.close()
  env.cleanup()
})

const send = (path: string, over: Parameters<typeof baseHttp>[1] extends infer T ? Partial<T> : never = {}) =>
  env.api.executeHttpRequest(baseHttp(ws, { url: `${server.base}${path}`, ...over }))

describe('sends share the workspace jar', () => {
  it('a login cookie goes with the next request; path and domain rules apply; Max-Age=0 deletes', async () => {
    await send('/login')
    const res = await send('/api/me')
    expect(JSON.parse(res.bodyText!)).toEqual({ cookie: 'session=s3cr3t-session-id' })
    // theme has Path=/ui: only below /ui, and before session (longer path first).
    await send('/ui/page')
    expect(server.last().cookie).toBe('theme=dark; session=s3cr3t-session-id')
    // The cookie for another domain was refused.
    const list = await env.api.listCookies(ws)
    expect(list.map((c) => c.name).sort()).toEqual(['session', 'theme'])
    expect(list.find((c) => c.name === 'session')).toMatchObject({ domain: '127.0.0.1', hostOnly: true, path: '/', httpOnly: true, sameSite: 'Lax', expiresAt: null })
    await send('/logout')
    await send('/api/me')
    expect(server.last().cookie).toBeUndefined()
  })

  it("cookies: 'off' neither sends nor stores", async () => {
    await send('/login', { cookies: 'off' })
    expect(await env.api.listCookies(ws)).toEqual([])
    await send('/login')
    await send('/api/me', { cookies: 'off' })
    expect(server.last().cookie).toBeUndefined()
  })

  it('a Cookie header the user set wins per name, the jar adds the rest', async () => {
    await send('/login')
    await send('/ui/x', { headers: [{ key: 'Cookie', value: 'session=mine; extra=1' }] })
    expect(server.last().cookie).toBe('session=mine; extra=1; theme=dark')
  })

  it('jars are per workspace, and deleting a workspace deletes its jar', async () => {
    await send('/login')
    const other = await env.api.createWorkspace('Other')
    await env.api.executeHttpRequest(baseHttp(other.id, { url: `${server.base}/api/me` }))
    expect(server.last().cookie).toBeUndefined()
    await env.api.deleteWorkspace(ws)
    expect((env.core.db.prepare('SELECT COUNT(*) AS n FROM cookies').get() as { n: number }).n).toBe(0)
  })
})

describe('storage', () => {
  it('values are encrypted at rest: the database never contains a cookie value', async () => {
    await send('/login')
    await env.api.upsertCookie({ workspaceId: ws, name: 'manual', value: 'hand-typed-value', domain: 'example.com', hostOnly: false, path: '/', expiresAt: null, secure: false, httpOnly: false, sameSite: null })
    const rows = env.core.db.prepare('SELECT * FROM cookies').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(3)
    const dump = JSON.stringify(rows)
    for (const v of ['s3cr3t-session-id', 'dark', 'hand-typed-value']) expect(dump).not.toContain(v)
    for (const r of rows) expect(r.value_enc).toMatch(/^v1:/)
    // The key lives in the keychain, not in the database.
    expect(env.secrets.get(COOKIE_KEY_REF)).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    const session = (await env.api.listCookies(ws)).find((c) => c.name === 'session')!
    expect(await env.api.revealCookie(session.id)).toBe('s3cr3t-session-id')
  })

  it('a value cannot be moved to another row (the cookie id is bound into the encryption)', async () => {
    await send('/login')
    const [a, b] = env.core.db.prepare('SELECT id, value_enc FROM cookies ORDER BY name').all() as Array<{ id: string; value_enc: string }>
    env.core.db.prepare('UPDATE cookies SET value_enc = ? WHERE id = ?').run(a!.value_enc, b!.id)
    await expect(env.api.revealCookie(b!.id)).rejects.toMatchObject({ code: 'io_error' })
    // The unreadable cookie is skipped on sends; the others still go.
    await send('/ui/x')
    expect(server.last().cookie).toBe('session=s3cr3t-session-id')
  })

  it('a lost key: cookies stay listed, their values cannot be read', async () => {
    await send('/login')
    const fresh = new CookieService(env.core.db, new MemorySecretStore())
    expect(fresh.list(ws)).toHaveLength(2)
    expect(() => fresh.reveal(fresh.list(ws)[0]!.id)).toThrow(/cannot be read/)
  })

  it('limits: 180 per domain (the oldest go), expired ones are purged', async () => {
    let t = 1_000
    const svc = new CookieService(env.core.db, env.secrets, () => t)
    const url = new URL('http://example.com/')
    for (let i = 0; i < 185; i++) {
      t++
      svc.storeFromResponse(ws, url, [`c${i}=v; Path=/`])
    }
    const names = svc.list(ws).map((c) => c.name)
    expect(names).toHaveLength(180)
    expect(names).not.toContain('c0')
    expect(names).toContain('c184')
    svc.storeFromResponse(ws, url, ['short=1; Max-Age=5'])
    expect(svc.list(ws)).toHaveLength(180)
    t += 10
    expect(svc.list(ws).some((c) => c.name === 'short')).toBe(false)
  })
})

describe('IPC (Cookies dialog)', () => {
  const base = { name: 'a', value: 'value-1', domain: 'Example.com', hostOnly: true, path: '/', expiresAt: null, secure: false, httpOnly: false, sameSite: null } as const

  it('add, edit (keeping the value), rename onto another cookie, delete, clear a domain and all', async () => {
    const c = await env.api.upsertCookie({ workspaceId: ws, ...base })
    expect(c).toMatchObject({ name: 'a', domain: 'example.com', hostOnly: true })
    const edited = await env.api.upsertCookie({ workspaceId: ws, ...base, id: c.id, value: undefined, path: '/x', secure: true, sameSite: 'Strict' })
    expect(edited).toMatchObject({ id: c.id, path: '/x', secure: true, sameSite: 'Strict' })
    expect(await env.api.revealCookie(c.id)).toBe('value-1')
    const other = await env.api.upsertCookie({ workspaceId: ws, ...base, name: 'b', value: 'value-2' })
    // Renaming b to a/path /x replaces the existing a.
    const merged = await env.api.upsertCookie({ workspaceId: ws, ...base, id: other.id, name: 'a', path: '/x', value: undefined })
    expect(merged.id).toBe(c.id)
    expect(await env.api.revealCookie(c.id)).toBe('value-2')
    expect(await env.api.listCookies(ws)).toHaveLength(1)
    await env.api.upsertCookie({ workspaceId: ws, ...base, name: 'z', domain: 'other.org' })
    expect(await env.api.clearCookies(ws, 'example.com')).toBe(1)
    expect((await env.api.listCookies(ws)).map((x) => x.domain)).toEqual(['other.org'])
    const [z] = await env.api.listCookies(ws)
    await env.api.deleteCookie(z!.id)
    await env.api.upsertCookie({ workspaceId: ws, ...base })
    expect(await env.api.clearCookies(ws, null)).toBe(1)
    expect(await env.api.listCookies(ws)).toEqual([])
  })

  it('refuses public suffixes, bad names and values', async () => {
    await expect(env.api.upsertCookie({ workspaceId: ws, ...base, domain: 'co.uk', hostOnly: false })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.upsertCookie({ workspaceId: ws, ...base, name: 'a;b' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.upsertCookie({ workspaceId: ws, ...base, value: 'x;y' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.upsertCookie({ workspaceId: ws, ...base, path: 'x' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.upsertCookie({ workspaceId: ws, ...base, domain: 'not a host' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('the scripts allow-list is normalized and refuses public suffixes', async () => {
    expect(await env.api.getCookieScriptDomains(ws)).toEqual([])
    expect(await env.api.setCookieScriptDomains(ws, [' .Example.com', '', 'example.com', '127.0.0.1'])).toEqual(['example.com', '127.0.0.1'])
    expect(await env.api.getCookieScriptDomains(ws)).toEqual(['example.com', '127.0.0.1'])
    await expect(env.api.setCookieScriptDomains(ws, ['com'])).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('redactSecrets hides jar values but not what the response set itself', async () => {
    await send('/login')
    const out = await env.api.redactSecrets({
      scriptSessionId: null,
      oauth2TokenKey: null,
      texts: ['body has s3cr3t-session-id and dark', 'session=s3cr3t-session-id%3B'],
      cookies: { workspaceId: ws, responseSetCookies: ['theme=dark; Path=/ui'] },
    })
    expect(out).toEqual(['body has [hidden] and dark', 'session=[hidden]%3B'])
  })
})

describe('scripts', () => {
  let seq = 0
  const input = (code: string, over: Partial<RunScriptsInput> = {}): RunScriptsInput => ({
    runId: `cj-${++seq}`,
    sessionId: 'cj-session',
    workspaceId: ws,
    environmentId: null,
    event: 'prerequest',
    scripts: [{ origin: 'request', name: 'R', code }],
    request: { method: 'GET', url: 'http://x/', headers: [], body: { mode: 'none' } },
    response: null,
    variables: { base: server.base },
    collectionVariables: {},
    globals: {},
    info: { requestName: 'R', requestId: null, iteration: 0, iterationCount: 1 },
    ...over,
  })

  it('pm.sendRequest stores and sends the jar cookies like a normal send', async () => {
    const r = await env.api.runScripts(
      input(`
        const base = pm.variables.get('base')
        await pm.sendRequest(base + '/login')
        const res = await pm.sendRequest(base + '/api/me')
        pm.variables.set('seen', res.json().cookie)
      `),
    )
    expect(r.errors).toEqual([])
    expect(r.variables.seen).toBe('session=s3cr3t-session-id')
    await send('/api/me')
    expect(server.last().cookie).toBe('session=s3cr3t-session-id')
  })

  it('pm.cookies.jar(): get, getAll, set, unset, clear for allowed domains (callbacks and promises)', async () => {
    await send('/login')
    await env.api.setCookieScriptDomains(ws, ['127.0.0.1'])
    const r = await env.api.runScripts(
      input(`
        const base = pm.variables.get('base')
        const jar = pm.cookies.jar()
        jar.get(base + '/api', 'session', (err, value) => pm.variables.set('cb', value))
        pm.variables.set('missing', String(await jar.get(base + '/api', 'nope')))
        const all = await jar.getAll(base + '/ui/x')
        pm.variables.set('all', all.map(c => c.name + ':' + c.path + ':' + c.httpOnly).join(','))
        await jar.set(base, 'added', 'v1')
        await jar.set(base, { name: 'obj', value: 'v2', path: '/', httpOnly: true }, (err, cookie) => pm.variables.set('setcb', cookie.name))
        await jar.unset(base + '/ui/x', 'theme')
        pm.variables.set('after', (await jar.getAll(base + '/ui/x')).map(c => c.name).sort().join(','))
      `),
    )
    expect(r.errors).toEqual([])
    expect(r.variables).toMatchObject({ cb: 's3cr3t-session-id', missing: 'undefined', all: 'theme:/ui:false,session:/:true', setcb: 'obj', after: 'added,obj,session' })
    await send('/api/me')
    expect(server.last().cookie).toBe('session=s3cr3t-session-id; added=v1; obj=v2')
    const cleared = await env.api.runScripts(input(`await pm.cookies.jar().clear(pm.variables.get('base'))`))
    expect(cleared.errors).toEqual([])
    expect(await env.api.listCookies(ws)).toEqual([])
  })

  it('pm.cookies.jar() refuses domains that are not allowed (empty list = none)', async () => {
    await send('/login')
    const r = await env.api.runScripts(
      input(`
        pm.cookies.jar().get(pm.variables.get('base'), 'session', (err, v) => { pm.variables.set('err', err && err.message); pm.variables.set('v', String(v)) })
      `),
    )
    expect(r.errors).toEqual([])
    expect(r.variables.err).toMatch(/may not access the cookies of 127\.0\.0\.1/)
    expect(r.variables.v).toBe('undefined')
    await env.api.setCookieScriptDomains(ws, ['example.com'])
    const r2 = await env.api.runScripts(input(`await pm.cookies.jar().set('https://evil.com/', 'x', '1')`))
    expect(r2.errors[0]?.message).toMatch(/may not access the cookies of evil\.com/)
  })

  it('scripts of a send an AI assistant controls (denySecrets) get no jar: no cookies sent or stored, jar() refused', async () => {
    await send('/login')
    await env.api.setCookieScriptDomains(ws, ['127.0.0.1'])
    const r = await env.api.runScripts(
      input(
        `
        const base = pm.variables.get('base')
        const res = await pm.sendRequest(base + '/api/me')
        pm.variables.set('seen', String(res.json().cookie))
        await pm.sendRequest(base + '/logout')
        try { pm.cookies.jar().get(base, 'session') } catch (e) { pm.variables.set('jarErr', e.message) }
      `,
        { denySecrets: 'not available to scripts of a request an AI assistant wrote or changed.' },
      ),
    )
    expect(r.errors).toEqual([])
    expect(r.variables.seen).toBe('null')
    expect(r.variables.jarErr).toMatch(/pm\.cookies\.jar\(\): not available to scripts/)
    // /logout's Max-Age=0 was not applied either.
    expect((await env.api.listCookies(ws)).some((c) => c.name === 'session')).toBe(true)
  })
})
