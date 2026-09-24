import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '../../shared/types'
import { hasUnresolvedPlaceholder, normalizeUrl } from '../services/httpExecutor'
import { baseHttp, closedPort, makeEnv, scaffold, startTestServer, type TestEnv } from './helpers'

let env: TestEnv
let server: Awaited<ReturnType<typeof startTestServer>>
let wsId: string
let fileDir: string

beforeAll(async () => {
  server = await startTestServer()
  fileDir = mkdtempSync(join(tmpdir(), 'slinger-files-'))
})
afterAll(async () => {
  await server.close()
  rmSync(fileDir, { recursive: true, force: true })
})
beforeEach(async () => {
  env = makeEnv()
  wsId = (await scaffold(env)).workspace.id
  server.requests.length = 0
})
afterEach(() => env.cleanup())

const run = (over: Partial<HttpRequestInput> & { url?: string }) =>
  env.api.executeHttpRequest(baseHttp(wsId, { ...over, url: over.url ?? `${server.baseUrl}/echo` }))

describe('helpers', () => {
  it('normalizes URLs', () => {
    expect(normalizeUrl('localhost:3000/x')).toBe('http://localhost:3000/x')
    expect(normalizeUrl('example.com')).toBe('http://example.com')
    expect(normalizeUrl('//example.com/a')).toBe('http://example.com/a')
    expect(normalizeUrl('  https://a.b/c ')).toBe('https://a.b/c')
    expect(normalizeUrl('HTTP://a.b')).toBe('HTTP://a.b')
  })
  it('detects placeholders but not ordinary braces', () => {
    expect(hasUnresolvedPlaceholder('{{host}}/x')).toBe(true)
    expect(hasUnresolvedPlaceholder('a {{ b }} c')).toBe(true)
    expect(hasUnresolvedPlaceholder('{"a":{"b":{}}}')).toBe(false)
    expect(hasUnresolvedPlaceholder('{ x }')).toBe(false)
    expect(hasUnresolvedPlaceholder('')).toBe(false)
  })
})

describe('basic execution', () => {
  it('returns status, headers, text body, byte length and a sane duration', async () => {
    const res = await run({ method: 'GET' })
    expect(res.status).toBe(200)
    expect(res.statusText).toBe('OK')
    expect(res.headers.find((h) => h.key === 'content-type')?.value).toBe('application/json')
    expect(JSON.parse(res.bodyText!)).toMatchObject({ method: 'GET', ok: true })
    expect(res.bodyBase64).toBeNull()
    expect(res.bodyByteLength).toBe(Buffer.byteLength(res.bodyText!))
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('durationMs includes the full server latency', async () => {
    const res = await run({ url: `${server.baseUrl}/delay` })
    expect(res.bodyText).toBe('late')
    expect(res.durationMs).toBeGreaterThanOrEqual(140)
    expect(res.durationMs).toBeLessThan(3000)
  })

  it('adds http:// when the scheme is missing', async () => {
    const res = await run({ url: `${server.hostPort}/no-scheme` })
    expect(res.status).toBe(200)
    expect(server.last().url).toBe('/no-scheme')
  })

  it('returns non-2xx responses as data, not errors', async () => {
    const res = await run({ url: `${server.baseUrl}/status/500` })
    expect(res.status).toBe(500)
    expect(res.bodyText).toBe('boom')
  })

  it('sends custom headers, trims them and skips empty names', async () => {
    await run({ headers: [{ key: ' X-One ', value: ' 1 ' }, { key: '', value: 'ignored' }, { key: 'X-Two', value: '2' }] })
    expect(server.last().headers['x-one']).toBe('1')
    expect(server.last().headers['x-two']).toBe('2')
    expect(Object.keys(server.last().headers)).not.toContain('')
  })

  it('rejects non-http schemes, bad URLs, bad methods and bodies on GET', async () => {
    await expect(run({ url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(run({ url: 'http://' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(run({ url: '   ' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(run({ method: 'GE T' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(run({ method: 'GET', body: { mode: 'raw', raw: { content: 'x', contentType: 'text/plain' } } })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(run({ headers: [{ key: 'Bad Header', value: 'x' }] })).rejects.toMatchObject({ code: 'invalid_input' })
    expect(server.requests.length).toBe(0)
  })

  it('reports connection failures as network_error with a useful message', async () => {
    const err = await run({ url: `http://127.0.0.1:${await closedPort()}/x` }).catch((e) => e)
    expect(err.code).toBe('network_error')
    expect(err.message).toMatch(/ECONNREFUSED|refused/i)
  })
})

describe('auth kinds (applied server-side)', () => {
  it('basic: base64(user:pass), UTF-8 safe', async () => {
    await run({ auth: { kind: 'basic', basic: { username: 'alice', password: 'pässword:with:colons' } } })
    const expected = 'Basic ' + Buffer.from('alice:pässword:with:colons', 'utf8').toString('base64')
    expect(server.last().headers.authorization).toBe(expected)
  })
  it('bearer', async () => {
    await run({ auth: { kind: 'bearer', bearer: { token: 'tok123' } } })
    expect(server.last().headers.authorization).toBe('Bearer tok123')
  })
  it('apiKey in header', async () => {
    await run({ auth: { kind: 'apiKey', apiKey: { key: 'X-API-Key', value: 'k1', addTo: 'header' } } })
    expect(server.last().headers['x-api-key']).toBe('k1')
  })
  it('apiKey in query keeps existing query params and encodes values', async () => {
    await run({ url: `${server.baseUrl}/echo?a=1`, auth: { kind: 'apiKey', apiKey: { key: 'api_key', value: 'a b&c', addTo: 'query' } } })
    const url = new URL(server.last().url, 'http://x')
    expect(url.searchParams.get('a')).toBe('1')
    expect(url.searchParams.get('api_key')).toBe('a b&c')
  })
  it('none sends no Authorization header', async () => {
    await run({ auth: { kind: 'none' } })
    expect(server.last().headers.authorization).toBeUndefined()
  })
  it('apiKey requires a name', async () => {
    await expect(run({ auth: { kind: 'apiKey', apiKey: { key: ' ', value: 'v', addTo: 'header' } } })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('body modes', () => {
  it('raw: sends the content with the given content type', async () => {
    await run({ method: 'POST', body: { mode: 'raw', raw: { content: '{"a":"é"}', contentType: 'application/json' } } })
    expect(server.last().method).toBe('POST')
    expect(server.last().headers['content-type']).toBe('application/json')
    expect(server.last().body.toString('utf8')).toBe('{"a":"é"}')
  })

  it('raw: an explicit Content-Type header wins over the body content type', async () => {
    await run({ method: 'POST', headers: [{ key: 'content-type', value: 'application/vnd.custom+json' }], body: { mode: 'raw', raw: { content: '{}', contentType: 'application/json' } } })
    expect(server.last().headers['content-type']).toBe('application/vnd.custom+json')
  })

  it('urlEncoded: sends only enabled rows, percent-encoded', async () => {
    await run({
      method: 'POST',
      body: {
        mode: 'urlEncoded',
        urlEncoded: [
          { key: 'a', value: '1 2', enabled: true },
          { key: 'off', value: 'nope', enabled: false },
          { key: 'b&c', value: 'x=y', enabled: true },
        ],
      },
    })
    expect(server.last().headers['content-type']).toBe('application/x-www-form-urlencoded')
    const params = new URLSearchParams(server.last().body.toString('utf8'))
    expect([...params.entries()]).toEqual([['a', '1 2'], ['b&c', 'x=y']])
  })

  it('formData: real multipart with text and file parts, enabled rows only', async () => {
    const filePath = join(fileDir, 'note.txt')
    writeFileSync(filePath, 'file-contents-ÄÖ')
    const res = await run({
      method: 'POST',
      // A stale Content-Type header must not break the multipart boundary.
      headers: [{ key: 'Content-Type', value: 'application/json' }],
      body: {
        mode: 'formData',
        formData: [
          { key: 'title', value: 'hello', type: 'text', enabled: true },
          { key: 'attachment', value: '', filePath, type: 'file', enabled: true },
          { key: 'disabled', value: 'no', type: 'text', enabled: false },
        ],
      },
    })
    expect(res.status).toBe(200)
    const ct = server.last().headers['content-type']!
    expect(ct).toMatch(/^multipart\/form-data; boundary=/)
    const body = server.last().body.toString('utf8')
    expect(body).toContain('name="title"\r\n\r\nhello')
    expect(body).toMatch(/name="attachment"; filename="note\.txt"\r\nContent-Type: [^\r\n]+\r\n\r\nfile-contents-ÄÖ/)
    expect(body).not.toContain('disabled')
    expect(body.split(ct.split('boundary=')[1]!).length).toBeGreaterThan(3)
  })

  it('formData: missing file and relative file paths are rejected before sending', async () => {
    const mk = (filePath: string): Partial<HttpRequestInput> => ({
      method: 'POST',
      body: { mode: 'formData', formData: [{ key: 'f', value: '', filePath, type: 'file', enabled: true }] },
    })
    await expect(run(mk(join(fileDir, 'missing.bin')))).rejects.toMatchObject({ code: 'io_error' })
    await expect(run(mk('relative/file.txt'))).rejects.toMatchObject({ code: 'invalid_input' })
    expect(server.requests.length).toBe(0)
  })

  it('binary: uploads the exact file bytes', async () => {
    const bytes = Buffer.from([0, 1, 2, 0xff, 0xfe, 0x80, 0x00, 0x7f])
    const filePath = join(fileDir, 'blob.bin')
    writeFileSync(filePath, bytes)
    await run({ method: 'PUT', body: { mode: 'binary', binaryFilePath: filePath } })
    expect(server.last().method).toBe('PUT')
    expect(server.last().headers['content-type']).toBe('application/octet-stream')
    expect(Buffer.compare(server.last().body, bytes)).toBe(0)
  })

  it('mode none sends no body even if stale body data is present', async () => {
    await run({ method: 'POST', body: { mode: 'none', raw: { content: 'stale', contentType: 'text/plain' } } })
    expect(server.last().body.length).toBe(0)
  })
})

describe('responses', () => {
  it('non-UTF-8 bodies come back as base64 with the exact bytes and never throw', async () => {
    const res = await run({ url: `${server.baseUrl}/binary` })
    expect(res.bodyText).toBeNull()
    expect(Buffer.from(res.bodyBase64!, 'base64')).toEqual(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]))
    expect(res.bodyByteLength).toBe(6)
  })

  it('honours a declared non-UTF-8 charset when it can decode it', async () => {
    const res = await run({ url: `${server.baseUrl}/latin1` })
    expect(res.bodyText).toBe('café')
    expect(res.bodyByteLength).toBe(4)
  })
})

describe('unresolved placeholders', () => {
  const post = (over: Partial<HttpRequestInput>) => run({ method: 'POST', ...over })
  it.each([
    ['url', { url: '{{baseUrl}}/x' }],
    ['url host', { url: 'http://{{host}}/x' }],
    ['header value', { headers: [{ key: 'X-A', value: 'Bearer {{token}}' }] }],
    ['header name', { headers: [{ key: '{{name}}', value: 'v' }] }],
    ['bearer token', { auth: { kind: 'bearer', bearer: { token: '{{token}}' } } as const }],
    ['basic password', { auth: { kind: 'basic', basic: { username: 'u', password: '{{pw}}' } } as const }],
    ['apiKey value', { auth: { kind: 'apiKey', apiKey: { key: 'k', value: '{{v}}', addTo: 'query' } } as const }],
    ['raw body', { body: { mode: 'raw', raw: { content: '{"id":"{{id}}"}', contentType: 'application/json' } } as const }],
    ['urlEncoded field', { body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: '{{x}}', enabled: true }] } as const }],
    ['form text field', { body: { mode: 'formData', formData: [{ key: 'a', value: '{{x}}', type: 'text', enabled: true }] } as const }],
  ])('rejects an unresolved variable in %s without sending anything', async (_label, over) => {
    const err = await post(over as Partial<HttpRequestInput>).catch((e) => e)
    expect(err.code).toBe('invalid_input')
    expect(err.message).toMatch(/Unresolved variable/)
    expect(server.requests.length).toBe(0)
  })

  it('ignores placeholders in disabled rows and accepts JSON with nested braces', async () => {
    const res = await post({
      body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: '{{ignored}}', enabled: false }, { key: 'b', value: '1', enabled: true }] },
    })
    expect(res.status).toBe(200)
    const res2 = await post({ body: { mode: 'raw', raw: { content: '{"a":{"b":{"c":1}}}', contentType: 'application/json' } } })
    expect(res2.status).toBe(200)
  })
})

describe('cancellation and timeout', () => {
  it('cancelHttpRequest aborts an in-flight run identified by requestRunId', async () => {
    const pending = run({ url: `${server.baseUrl}/slow`, requestRunId: 'run-1' })
    await waitFor(() => server.requests.length === 1)
    await env.api.cancelHttpRequest('run-1')
    const err = await pending.catch((e) => e)
    expect(err.code).toBe('network_error')
    expect(err.message).toMatch(/cancel/i)
    expect(err.details).toMatchObject({ cancelled: true })
  })

  it('cancelling an unknown run is a no-op and does not affect other runs', async () => {
    await expect(env.api.cancelHttpRequest('nope')).resolves.toBeUndefined()
    const pending = run({ url: `${server.baseUrl}/delay`, requestRunId: 'keep' })
    await env.api.cancelHttpRequest('other')
    expect((await pending).status).toBe(200)
  })

  it('a run id is reusable after the run finished, but not while in flight', async () => {
    const a = run({ url: `${server.baseUrl}/slow`, requestRunId: 'dup' })
    await waitFor(() => server.requests.length === 1)
    await expect(run({ requestRunId: 'dup' })).rejects.toMatchObject({ code: 'invalid_input' })
    await env.api.cancelHttpRequest('dup')
    await a.catch(() => {})
    expect((await run({ requestRunId: 'dup' })).status).toBe(200)
  })

  it('times out slow servers', async () => {
    const err = await run({ url: `${server.baseUrl}/slow`, timeoutMs: 100 }).catch((e) => e)
    expect(err.code).toBe('network_error')
    expect(err.message).toMatch(/timed out/i)
    expect(err.details).toMatchObject({ timedOut: true })
  })
})

describe('history', () => {
  it('records successful requests (status, ok, duration, request link)', async () => {
    const collection = await env.api.createCollection(wsId, 'C')
    const saved = await env.api.createRequest({ workspaceId: wsId, collectionId: collection.id, name: 'Saved', method: 'GET', url: 'x', documentJson: '{}' })
    await run({ requestId: saved.id, requestName: 'Saved' })
    await run({ url: `${server.baseUrl}/status/500`, method: 'GET' })
    const [newest, oldest] = await env.api.listHistory(wsId)
    expect(oldest).toMatchObject({ requestId: saved.id, requestName: 'Saved', method: 'GET', statusCode: 200, ok: true, errorMessage: null })
    expect(oldest!.url).toBe(`${server.baseUrl}/echo`)
    expect(oldest!.durationMs).toBeGreaterThanOrEqual(0)
    expect(newest).toMatchObject({ statusCode: 500, ok: false, errorMessage: null })
  })

  it('records network failures, cancellations, and validation failures', async () => {
    await run({ url: `http://127.0.0.1:${await closedPort()}/x` }).catch(() => {})
    const p = run({ url: `${server.baseUrl}/slow`, requestRunId: 'h1' })
    await waitFor(() => server.requests.length === 1)
    await env.api.cancelHttpRequest('h1')
    await p.catch(() => {})
    await run({ url: '{{missing}}/x' }).catch(() => {})
    const history = await env.api.listHistory(wsId)
    expect(history.length).toBe(3)
    expect(history.every((h) => !h.ok && h.statusCode === null && h.errorMessage)).toBe(true)
    expect(history.map((h) => h.errorMessage)).toEqual([
      expect.stringMatching(/Unresolved variable/),
      expect.stringMatching(/cancel/i),
      expect.stringMatching(/refused/i),
    ])
  })

  it('does not write API keys added to the query string into history', async () => {
    await run({ auth: { kind: 'apiKey', apiKey: { key: 'api_key', value: 'SUPERSECRET', addTo: 'query' } } })
    const [entry] = await env.api.listHistory(wsId)
    expect(entry!.url).not.toContain('SUPERSECRET')
  })

  it('stores historyUrl instead of the sent URL when provided', async () => {
    await run({ url: `${server.baseUrl}/echo?key=SUPERSECRET`, historyUrl: `${server.baseUrl}/echo?key={{apikey}}` })
    const [entry] = await env.api.listHistory(wsId)
    expect(entry!.url).toBe(`${server.baseUrl}/echo?key={{apikey}}`)
    expect(JSON.stringify(await env.api.listHistory(wsId))).not.toContain('SUPERSECRET')
  })

  it('still returns the HTTP outcome if the request id is unknown', async () => {
    const res = await run({ requestId: '00000000-0000-4000-8000-000000000001', requestName: 'ghost' })
    expect(res.status).toBe(200)
    expect((await env.api.listHistory(wsId))[0]).toMatchObject({ requestId: null, requestName: 'ghost' })
  })
})

async function waitFor(cond: () => boolean, ms = 3000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
