import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OAuth2Config } from '../../shared/types'
import { createIpcApi } from '../ipc/api'
import { parseTokenResponse } from '../services/oauth2'
import { OAUTH2_TOKEN_PREFIX } from '../services/secrets'
import { baseHttp, closedPort, makeEnv, scaffold, startTestServer, type TestEnv } from './helpers'

// ---------------------------------------------------------------------------
// A tiny OAuth 2.0 authorization server (real sockets): /authorize redirects like a provider after "login",
// /token implements the grants Slinger uses.
// ---------------------------------------------------------------------------

interface TokenCall {
  headers: IncomingMessage['headers']
  form: Record<string, string>
}

async function startOAuthServer() {
  const tokenCalls: TokenCall[] = []
  const codes = new Map<string, { challenge: string | null; method: string | null; redirectUri: string; clientId: string }>()
  const refreshTokens = new Set<string>()
  let issued = 0
  const opts = {
    expiresIn: 3600 as number | null,
    formEncoded: false,
    issueRefresh: true,
    /** Refresh answers without a new refresh_token (servers may keep the old one valid). */
    omitRefreshOnRefresh: false,
  }
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const q = url.searchParams
      const redirect = new URL(q.get('redirect_uri')!)
      if (q.get('client_id') === 'deny') {
        redirect.searchParams.set('error', 'access_denied')
        redirect.searchParams.set('error_description', '<script>alert(1)</script> user said no')
      } else {
        const code = `code-${++issued}`
        codes.set(code, {
          challenge: q.get('code_challenge'),
          method: q.get('code_challenge_method'),
          redirectUri: q.get('redirect_uri')!,
          clientId: q.get('client_id')!,
        })
        redirect.searchParams.set('code', code)
      }
      redirect.searchParams.set('state', q.get('state') ?? '')
      res.writeHead(302, { Location: redirect.toString() })
      return void res.end()
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
      tokenCalls.push({ headers: req.headers, form })
      const fail = (status: number, error: string, description?: string) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error, ...(description ? { error_description: description } : {}) }))
      }
      // Client authentication: Basic header or body.
      let clientId = form.client_id
      let secret = form.client_secret
      const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')
      if (basic) {
        const [id, s] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':').map(decodeURIComponent)
        clientId = id
        secret = s
      }
      if (clientId !== 'public' && secret !== 's3cr3t/+&') return fail(401, 'invalid_client', 'bad client secret')
      const grant = form.grant_type
      if (grant === 'password' && (form.username !== 'alice' || form.password !== 'pw')) return fail(400, 'invalid_grant')
      if (grant === 'authorization_code') {
        const entry = codes.get(form.code ?? '')
        if (!entry || entry.redirectUri !== form.redirect_uri) return fail(400, 'invalid_grant', 'unknown code')
        codes.delete(form.code!)
        if (entry.challenge) {
          const v = form.code_verifier ?? ''
          const expected = entry.method === 'plain' ? v : createHash('sha256').update(v).digest('base64url')
          if (expected !== entry.challenge) return fail(400, 'invalid_grant', 'PKCE verification failed')
        }
      }
      if (grant === 'refresh_token' && !refreshTokens.has(form.refresh_token ?? '')) return fail(400, 'invalid_grant', 'refresh token revoked')
      if (!['client_credentials', 'password', 'authorization_code', 'refresh_token'].includes(grant ?? '')) return fail(400, 'unsupported_grant_type')
      const n = ++issued
      const body: Record<string, string | number> = { access_token: `access-${grant}-${n}-abcdefghijklmnop`, token_type: 'Bearer' }
      if (opts.expiresIn !== null) body.expires_in = opts.expiresIn
      if (form.scope) body.scope = form.scope
      if (opts.issueRefresh && !(grant === 'refresh_token' && opts.omitRefreshOnRefresh)) {
        body.refresh_token = `refresh-${n}`
        refreshTokens.add(`refresh-${n}`)
      }
      if (opts.formEncoded) {
        res.writeHead(200, { 'Content-Type': 'application/x-www-form-urlencoded' })
        return void res.end(new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)])).toString())
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base,
    tokenCalls,
    opts,
    refreshTokens,
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))),
  }
}

type Browser = (url: string) => Promise<void>

let env: TestEnv
let oauth: Awaited<ReturnType<typeof startOAuthServer>>
let workspaceId: string
/** What the fake system browser does with the opened URL; default: follow the redirects like a signed-in user. */
let browser: Browser
const opened: string[] = []
const pages: { status: number; body: string }[] = []
let api: ReturnType<typeof createIpcApi>
/** The fake browser's current navigation (await it before looking at `pages`). */
let browsing: Promise<void> = Promise.resolve()

const follow: Browser = async (url) => {
  const res = await fetch(url)
  pages.push({ status: res.status, body: await res.text() })
}

beforeEach(async () => {
  env = makeEnv()
  oauth = await startOAuthServer()
  opened.length = 0
  pages.length = 0
  browser = follow
  api = createIpcApi(env.core, {
    appVersion: 'test',
    openExternal: async (url) => {
      opened.push(url)
      // Like the OS browser: runs on its own, the IPC call does not wait for it.
      browsing = browser(url).catch(() => {})
    },
    chooseDirectory: async () => null,
    pickFile: async () => null,
  })
  workspaceId = (await scaffold(env)).workspace.id
})
afterEach(async () => {
  env.core.oauth2.cancelAll()
  await browsing
  env.cleanup()
  await oauth.close()
})

function config(over: Partial<OAuth2Config> = {}): OAuth2Config {
  return {
    workspaceId,
    grantType: 'client_credentials',
    authUrl: `${oauth.base}/authorize`,
    accessTokenUrl: `${oauth.base}/token`,
    clientId: 'app',
    clientSecret: 's3cr3t/+&',
    scope: 'read write',
    state: '',
    redirectUri: '',
    username: '',
    password: '',
    challengeAlgorithm: 'S256',
    codeVerifier: '',
    clientAuthentication: 'header',
    refreshTokenUrl: '',
    audience: '',
    resource: '',
    ...over,
  }
}

const stored = (key: string) => JSON.parse(env.secrets.get(OAUTH2_TOKEN_PREFIX + key)!) as Record<string, unknown>

describe('client credentials and password grants', () => {
  it('uses HTTP Basic client authentication (form-encoded) and stores the token only in the keychain', async () => {
    const status = await api.getOAuth2Token(config())
    const call = oauth.tokenCalls[0]!
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('app:s3cr3t%2F%2B%26').toString('base64')}`)
    expect(call.headers.accept).toBe('application/json')
    expect(call.form).toEqual({ grant_type: 'client_credentials', scope: 'read write' })
    expect(status).toMatchObject({ hasToken: true, tokenType: 'Bearer', scope: 'read write', expired: false, hasRefreshToken: true })
    expect(status.tokenKey).toMatch(/^[0-9a-f]{64}$/)
    expect(status.maskedToken).toBe('acce…mnop')
    expect(JSON.stringify(status)).not.toContain('access-client_credentials')
    expect(stored(status.tokenKey)).toMatchObject({ access_token: expect.stringMatching(/^access-client_credentials-/), refresh_token: expect.any(String) })
    // The token entry plus the workspace's index of token keys (so deleting the workspace deletes its tokens).
    expect([...env.secrets.entries.keys()].filter((k) => k.startsWith(OAUTH2_TOKEN_PREFIX))).toEqual([
      OAUTH2_TOKEN_PREFIX + status.tokenKey,
      `${OAUTH2_TOKEN_PREFIX}index:${workspaceId}`,
    ])
    // Not written anywhere else: no history, no document.
    expect(await api.listHistory(workspaceId)).toEqual([])
  })

  it('sends client credentials in the body when configured, and client_id alone for public clients', async () => {
    await api.getOAuth2Token(config({ clientAuthentication: 'body', audience: 'https://api', resource: 'urn:r' }))
    expect(oauth.tokenCalls[0]!.headers.authorization).toBeUndefined()
    expect(oauth.tokenCalls[0]!.form).toEqual({
      grant_type: 'client_credentials',
      scope: 'read write',
      audience: 'https://api',
      resource: 'urn:r',
      client_id: 'app',
      client_secret: 's3cr3t/+&',
    })
    await api.getOAuth2Token(config({ clientId: 'public', clientSecret: '' }))
    expect(oauth.tokenCalls[1]!.headers.authorization).toBeUndefined()
    expect(oauth.tokenCalls[1]!.form.client_id).toBe('public')
  })

  it('runs the password grant', async () => {
    const status = await api.getOAuth2Token(config({ grantType: 'password_credentials', username: 'alice', password: 'pw', scope: '' }))
    expect(oauth.tokenCalls[0]!.form).toEqual({ grant_type: 'password', username: 'alice', password: 'pw' })
    expect(status.hasToken).toBe(true)
    await expect(api.getOAuth2Token(config({ grantType: 'password_credentials', username: 'alice', password: 'nope' }))).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'The token endpoint answered HTTP 400: invalid_grant',
    })
  })

  it('reports token endpoint errors with the OAuth error code and never stores anything', async () => {
    const err = await api.getOAuth2Token(config({ clientSecret: 'wrong' })).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'invalid_input', details: { status: 401, oauthError: 'invalid_client' } })
    expect((err as Error).message).toContain('invalid_client (bad client secret)')
    expect(env.secrets.entries.size).toBe(0)
  })

  it('parses form-encoded token responses and tokens without expiry', async () => {
    oauth.opts.formEncoded = true
    oauth.opts.expiresIn = null
    const status = await api.getOAuth2Token(config())
    expect(status).toMatchObject({ hasToken: true, expiresAt: null, expired: false })
    expect(parseTokenResponse({ status: 200, statusText: '', durationMs: 0, headers: [], bodyText: '<html>login</html>', bodyBase64: null, bodyByteLength: 0 })).toEqual({})
  })

  it('refuses a token URL that is not http(s), and implicit is not an accepted grant', async () => {
    await expect(api.getOAuth2Token(config({ accessTokenUrl: 'file:///etc/passwd' }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.getOAuth2Token({ ...config(), grantType: 'implicit' as never })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.getOAuth2Token({ ...config(), extra: 1 } as never)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('shares one token between configurations that differ only in secrets, and separates workspaces', async () => {
    const a = await api.getOAuth2Token(config())
    expect((await api.getOAuth2TokenStatus(config({ clientSecret: 'other', clientAuthentication: 'body' }))).tokenKey).toBe(a.tokenKey)
    expect((await api.getOAuth2TokenStatus(config({ scope: 'read' }))).hasToken).toBe(false)
    const other = await api.createWorkspace('Other')
    expect((await api.getOAuth2TokenStatus(config({ workspaceId: other.id }))).hasToken).toBe(false)
  })
})

describe('authorization code grant', () => {
  it('runs PKCE end to end through the system browser and a loopback redirect listener', async () => {
    const port = await closedPort()
    const redirectUri = `http://127.0.0.1:${port}/oauth2/cb`
    const status = await api.getOAuth2Token(config({ grantType: 'authorization_code_with_pkce', redirectUri, clientAuthentication: 'body' }))
    expect(status.hasToken).toBe(true)
    const authorize = new URL(opened[0]!)
    expect(authorize.origin + authorize.pathname).toBe(`${oauth.base}/authorize`)
    const q = authorize.searchParams
    expect(q.get('response_type')).toBe('code')
    expect(q.get('client_id')).toBe('app')
    expect(q.get('redirect_uri')).toBe(redirectUri)
    expect(q.get('scope')).toBe('read write')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    const call = oauth.tokenCalls[0]!.form
    expect(call).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: redirectUri, client_id: 'app' })
    expect(call.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createHash('sha256').update(call.code_verifier!).digest('base64url')).toBe(q.get('code_challenge'))
    await browsing
    expect(pages[0]).toMatchObject({ status: 200 })
    expect(pages[0]!.body).toContain('Authorization received')
    // The listener is gone afterwards.
    await new Promise((r) => setTimeout(r, 300))
    await expect(fetch(redirectUri)).rejects.toThrow()
  })

  it('supports the plain challenge, a fixed verifier and state, and the non-PKCE grant', async () => {
    const verifier = 'v'.repeat(50)
    const port = await closedPort()
    await api.getOAuth2Token(
      config({ grantType: 'authorization_code_with_pkce', redirectUri: `http://localhost:${port}/cb`, challengeAlgorithm: 'plain', codeVerifier: verifier, state: 'fixed-state' }),
    )
    const q = new URL(opened[0]!).searchParams
    expect(q.get('code_challenge')).toBe(verifier)
    expect(q.get('state')).toBe('fixed-state')
    expect(oauth.tokenCalls[0]!.form.code_verifier).toBe(verifier)

    await api.getOAuth2Token(config({ grantType: 'authorization_code', redirectUri: `http://127.0.0.1:${port}/cb` }))
    expect(new URL(opened[1]!).searchParams.has('code_challenge')).toBe(false)
    expect(oauth.tokenCalls[1]!.form.code_verifier).toBeUndefined()
    await expect(api.getOAuth2Token(config({ grantType: 'authorization_code_with_pkce', codeVerifier: 'short', redirectUri: `http://127.0.0.1:${port}/cb` }))).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })

  it('rejects a redirect whose state does not match', async () => {
    const port = await closedPort()
    browser = async (url) => {
      const res = await fetch(url, { redirect: 'manual' })
      const location = new URL(res.headers.get('location')!)
      location.searchParams.set('state', 'forged')
      const page = await fetch(location)
      pages.push({ status: page.status, body: await page.text() })
    }
    await expect(api.getOAuth2Token(config({ grantType: 'authorization_code_with_pkce', redirectUri: `http://127.0.0.1:${port}/cb` }))).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'state_mismatch' },
    })
    await browsing
    expect(pages[0]!.status).toBe(400)
    expect(oauth.tokenCalls).toHaveLength(0)
    expect(env.secrets.entries.size).toBe(0)
  })

  it('surfaces an error redirect and escapes provider text on the callback page', async () => {
    const port = await closedPort()
    const err = await api
      .getOAuth2Token(config({ grantType: 'authorization_code', clientId: 'deny', redirectUri: `http://127.0.0.1:${port}/cb` }))
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'invalid_input', details: { oauthError: 'access_denied' } })
    expect((err as Error).message).toContain('access_denied')
    await browsing
    expect(pages[0]!.body).not.toContain('<script>')
    expect(pages[0]!.body).toContain('&lt;script&gt;')
  })

  it('ignores other paths until the real redirect arrives', async () => {
    const port = await closedPort()
    browser = async (url) => {
      expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404)
      await follow(url)
    }
    expect((await api.getOAuth2Token(config({ grantType: 'authorization_code', redirectUri: `http://127.0.0.1:${port}/cb` }))).hasToken).toBe(true)
  })

  it('explains that non-loopback redirect URIs cannot be received', async () => {
    await expect(
      api.getOAuth2Token(config({ grantType: 'authorization_code', redirectUri: 'https://oauth.pstmn.io/v1/callback' })),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'redirect_not_loopback' } })
    expect(opened).toEqual([])
  })

  it('reports a redirect port that is already in use', async () => {
    const blocker = createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as AddressInfo).port
    try {
      await expect(api.getOAuth2Token(config({ grantType: 'authorization_code', redirectUri: `http://127.0.0.1:${port}/cb` }))).rejects.toMatchObject({
        code: 'io_error',
        details: { reason: 'port_in_use' },
      })
    } finally {
      blocker.close()
    }
  })

  it('can be cancelled while waiting for the browser, and times out', async () => {
    const port = await closedPort()
    browser = async () => {}
    const cfg = config({ grantType: 'authorization_code_with_pkce', redirectUri: `http://127.0.0.1:${port}/cb` })
    const waiting = api.getOAuth2Token(cfg, { flowId: 'flow-1' })
    await new Promise((r) => setTimeout(r, 50))
    await expect(api.getOAuth2Token(cfg, { flowId: 'flow-1' })).rejects.toMatchObject({ code: 'invalid_input' })
    await api.cancelOAuth2Flow('flow-1')
    await expect(waiting).rejects.toMatchObject({ code: 'network_error', details: { cancelled: true } })
    // The port is free again right away.
    await expect(api.getOAuth2Token(cfg, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'network_error', details: { timedOut: true } })
    await api.cancelOAuth2Flow('unknown') // no-op
  })
})

describe('refresh', () => {
  it('refreshes on request and keeps the old refresh token when the server omits it', async () => {
    const cfg = config({ refreshTokenUrl: `${oauth.base}/token?refresh=1` })
    const first = await api.getOAuth2Token(cfg)
    const before = stored(first.tokenKey)
    oauth.opts.omitRefreshOnRefresh = true
    const refreshed = await api.refreshOAuth2Token(cfg)
    expect(oauth.tokenCalls[1]!.form).toEqual({ grant_type: 'refresh_token', refresh_token: before.refresh_token })
    expect(oauth.tokenCalls[1]!.headers.authorization).toMatch(/^Basic /)
    const after = stored(refreshed.tokenKey)
    expect(after.access_token).not.toBe(before.access_token)
    expect(after.refresh_token).toBe(before.refresh_token)
    expect(after.scope).toBe('read write')
  })

  it('refreshes before a send only when the token is about to expire', async () => {
    oauth.opts.expiresIn = 3600
    const fresh = await api.getOAuth2Token(config())
    expect(await api.refreshOAuth2Token(config(), { ifExpiring: true })).toEqual(fresh)
    expect(oauth.tokenCalls).toHaveLength(1)

    oauth.opts.expiresIn = 10 // inside the 30 s window
    await api.getOAuth2Token(config())
    oauth.opts.expiresIn = 3600
    const renewed = await api.refreshOAuth2Token(config(), { ifExpiring: true })
    expect(oauth.tokenCalls.at(-1)!.form.grant_type).toBe('refresh_token')
    expect(renewed.expired).toBe(false)
    expect(renewed.expiresAt! - Math.floor(Date.now() / 1000)).toBeGreaterThan(3000)
  })

  it('fails with "get a new token" when the refresh is refused, and needs a token and a refresh token', async () => {
    await expect(api.refreshOAuth2Token(config())).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('No access token yet') })
    expect((await api.refreshOAuth2Token(config(), { ifExpiring: true })).hasToken).toBe(false)

    oauth.opts.expiresIn = 0
    await api.getOAuth2Token(config())
    oauth.refreshTokens.clear()
    await expect(api.refreshOAuth2Token(config(), { ifExpiring: true })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { reason: 'refresh_failed' },
      message: expect.stringContaining('Get a new access token'),
    })

    oauth.opts.issueRefresh = false
    const noRefresh = await api.getOAuth2Token(config())
    expect(noRefresh).toMatchObject({ expired: true, hasRefreshToken: false })
    expect((await api.refreshOAuth2Token(config(), { ifExpiring: true })).expired).toBe(true)
    await expect(api.refreshOAuth2Token(config())).rejects.toMatchObject({ details: { reason: 'no_refresh_token' } })
  })
})

describe('sending with a stored token', () => {
  let target: Awaited<ReturnType<typeof startTestServer>>
  beforeEach(async () => {
    target = await startTestServer()
  })
  afterEach(() => target.close())

  const send = (tokenKey: string, addTo: 'header' | 'query', headerPrefix = 'Bearer') =>
    api.executeHttpRequest(
      baseHttp(workspaceId, {
        url: `${target.baseUrl}/data?x=1`,
        historyUrl: `${target.baseUrl}/data?x=1`,
        auth: { kind: 'oauth2', oauth2: { tokenKey, addTo, headerPrefix } },
      }),
    )

  it('applies the token as a header or query parameter and never records it', async () => {
    const { tokenKey } = await api.getOAuth2Token(config())
    const token = stored(tokenKey).access_token as string
    await send(tokenKey, 'header')
    expect(target.last().headers.authorization).toBe(`Bearer ${token}`)
    await send(tokenKey, 'header', ' ')
    expect(target.last().headers.authorization).toBe(token)
    await send(tokenKey, 'query')
    expect(target.last().url).toBe(`/data?x=1&access_token=${token}`)
    expect(target.last().headers.authorization).toBeUndefined()

    const history = await api.listHistory(workspaceId)
    expect(history).toHaveLength(3)
    expect(JSON.stringify(history)).not.toContain(token)
    // Nothing in the database holds it (history, documents, anything).
    const tables = env.core.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    for (const { name } of tables) expect(JSON.stringify(env.core.db.prepare(`SELECT * FROM "${name}"`).all())).not.toContain(token)
  })

  it('refuses to send without a token or with an expired one, and records the attempt without a token', async () => {
    const key = (await api.getOAuth2TokenStatus(config())).tokenKey
    await expect(send(key, 'header')).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'oauth2_no_token' } })
    oauth.opts.expiresIn = 0
    await api.getOAuth2Token(config())
    await expect(send(key, 'header')).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'oauth2_expired' } })
    expect(target.requests).toHaveLength(0)
    expect((await api.listHistory(workspaceId)).map((h) => h.ok)).toEqual([false, false])
  })

  it('validates the token key and the header prefix', async () => {
    await expect(send('../x', 'header')).rejects.toMatchObject({ code: 'invalid_input' })
    const { tokenKey } = await api.getOAuth2Token(config())
    await expect(send(tokenKey, 'header', '{{prefix}}')).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('reveal, delete and the reserved keychain namespace', () => {
  it('reveals only on request and deletes', async () => {
    const { tokenKey } = await api.getOAuth2Token(config())
    expect(await api.revealOAuth2Token(tokenKey)).toBe(stored(tokenKey).access_token)
    await api.deleteOAuth2Token(tokenKey)
    expect((await api.getOAuth2TokenStatus(config())).hasToken).toBe(false)
    await expect(api.revealOAuth2Token(tokenKey)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(api.revealOAuth2Token('not-a-key')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('refuses the slinger:oauth2: prefix in the generic secure store', async () => {
    const { tokenKey } = await api.getOAuth2Token(config())
    for (const key of [OAUTH2_TOKEN_PREFIX + tokenKey, 'SLINGER:OAUTH2:x']) {
      await expect(api.secureStoreGet(key)).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(api.secureStoreSet(key, 'x')).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(api.secureStoreDelete(key)).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('reports an unusable keychain as io_error', async () => {
    env.secrets.set = () => {
      throw new Error('keyring locked')
    }
    await expect(api.getOAuth2Token(config())).rejects.toMatchObject({ code: 'io_error', message: expect.stringContaining('keyring locked') })
  })
})

describe('workspace deletion', () => {
  it('deletes the workspace’s tokens (and only those) from the keychain', async () => {
    const other = await api.createWorkspace('Other')
    const mine = await api.getOAuth2Token(config())
    const second = await api.getOAuth2Token(config({ scope: 'read' }))
    const theirs = await api.getOAuth2Token(config({ workspaceId: other.id }))
    await api.deleteOAuth2Token(second.tokenKey)
    await api.deleteWorkspace(workspaceId)
    expect(env.secrets.get(OAUTH2_TOKEN_PREFIX + mine.tokenKey)).toBeNull()
    expect(env.secrets.get(OAUTH2_TOKEN_PREFIX + theirs.tokenKey)).not.toBeNull()
    expect([...env.secrets.entries.keys()].filter((k) => k.startsWith(OAUTH2_TOKEN_PREFIX)).sort()).toEqual(
      [OAUTH2_TOKEN_PREFIX + theirs.tokenKey, `${OAUTH2_TOKEN_PREFIX}index:${other.id}`].sort(),
    )
  })
})

describe('token key binding', () => {
  it('a configuration with a different refresh URL never uses (or refreshes) another configuration’s token', async () => {
    oauth.opts.expiresIn = 0
    await api.getOAuth2Token(config())
    const evil = await api.refreshOAuth2Token(config({ refreshTokenUrl: 'https://attacker.example/steal' }), { ifExpiring: true })
    expect(evil.hasToken).toBe(false)
    expect(oauth.tokenCalls).toHaveLength(1)
  })
})
