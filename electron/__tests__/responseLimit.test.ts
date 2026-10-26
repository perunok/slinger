import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clampMaxResponseBytes, clampMaxResponseMb, MB } from '../../shared/responseLimit'
import type { HttpRequestInput } from '../../shared/types'
import { safeDownloadName } from '../ipc/api'
import { readLimitedBody } from '../lib/limitedBody'
import { OpenApiService } from '../openapi/service'
import { executeHttp } from '../services/httpExecutor'
import { runScriptSendRequest, SCRIPT_MAX_RESPONSE_BYTES } from '../services/scriptHttp'
import { baseHttp, makeEnv, scaffold, type TestEnv } from './helpers'

/** Bytes the server managed to write for the last streamed response, and whether the client hung up early. */
const sent = { bytes: 0, aborted: false }
let server: Server
let base: string
let dir: string

/** Streams `total` bytes in 64 KB chunks (no Content-Length unless `declare`), stopping when the client goes away. */
function stream(res: ServerResponse, total: number, declare: boolean, type = 'application/octet-stream') {
  sent.bytes = 0
  sent.aborted = false
  res.writeHead(200, { 'content-type': type, 'x-kind': 'big', ...(declare ? { 'content-length': String(total) } : {}) })
  const chunk = Buffer.alloc(64 * 1024, 0x61)
  res.on('close', () => {
    if (!res.writableFinished) sent.aborted = true
  })
  const pump = () => {
    while (sent.bytes < total) {
      if (res.destroyed) return
      const n = Math.min(chunk.length, total - sent.bytes)
      sent.bytes += n
      if (!res.write(chunk.subarray(0, n))) return void res.once('drain', pump)
    }
    res.end()
  }
  pump()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'slinger-limit-'))
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const size = Number(u.searchParams.get('size') ?? 0)
    if (u.pathname === '/chunked') return stream(res, size, false, u.searchParams.get('type') ?? undefined)
    if (u.pathname === '/declared') return stream(res, size, true)
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
  rmSync(dir, { recursive: true, force: true })
})

const req = (path: string, over: Partial<HttpRequestInput> = {}): HttpRequestInput => ({
  method: 'GET',
  url: `${base}${path}`,
  headers: [],
  auth: { kind: 'none' },
  body: { mode: 'none' },
  workspaceId: '',
  ...over,
})

describe('the limit setting', () => {
  it('clamps MB and bytes to 1-256 MB with a 50 MB default', () => {
    expect(clampMaxResponseMb(undefined)).toBe(50)
    expect(clampMaxResponseMb('x')).toBe(50)
    expect(clampMaxResponseMb(0)).toBe(50) // no "unlimited"
    expect(clampMaxResponseMb(0.4)).toBe(1)
    expect(clampMaxResponseMb(10_000)).toBe(256)
    expect(clampMaxResponseMb(75)).toBe(75)
    expect(clampMaxResponseBytes(undefined)).toBe(50 * MB)
    expect(clampMaxResponseBytes(1)).toBe(1 * MB)
    expect(clampMaxResponseBytes(2 ** 40)).toBe(256 * MB)
  })
})

describe('executeHttp: the body is read with a hard cap', () => {
  it('reports a body over the limit without loading it, keeping status and headers, and stops the download', async () => {
    const res = await executeHttp(req('/chunked?size=' + 8 * MB), { maxResponseBytes: 1 * MB, oversize: 'report' })
    expect(res).toMatchObject({ status: 200, bodyText: null, bodyBase64: null, bodyTooLarge: { limitBytes: 1 * MB } })
    expect(res.headers).toContainEqual({ key: 'x-kind', value: 'big' })
    expect(res.bodyByteLength).toBeGreaterThan(1 * MB)
    await expect.poll(() => sent.aborted).toBe(true)
    expect(sent.bytes).toBeLessThan(8 * MB)
  })

  it('a declared Content-Length over the limit stops before reading the body', async () => {
    const res = await executeHttp(req('/declared?size=' + 4 * MB), { maxResponseBytes: 1 * MB, oversize: 'report' })
    expect(res.bodyTooLarge).toEqual({ limitBytes: 1 * MB })
    expect(res.bodyByteLength).toBe(4 * MB)
  })

  it('a body within the limit loads as before', async () => {
    const res = await executeHttp(req('/chunked?size=1000&type=text/plain'), { maxResponseBytes: 1 * MB, oversize: 'report' })
    expect(res.bodyText).toBe('a'.repeat(1000))
    expect(res.bodyTooLarge).toBeUndefined()
  })

  it("internal callers get an error instead (default 50 MB, 'error')", async () => {
    await expect(executeHttp(req('/chunked?size=' + 3 * MB), { maxResponseBytes: 2 * MB })).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('larger than 2 MB'),
    })
  })

  it('streams the body to a file without a size limit', async () => {
    const file = join(dir, 'out.bin')
    const res = await executeHttp(req('/chunked?size=' + 3 * MB), { maxResponseBytes: 1 * MB, oversize: 'report', toFile: file })
    expect(res).toMatchObject({ status: 200, bodyText: null, bodyBase64: null, bodyByteLength: 3 * MB, savedToFile: file })
    expect(res.bodyTooLarge).toBeUndefined()
    expect(readFileSync(file).length).toBe(3 * MB)
  })

  it('a file that cannot be written is an io_error and leaves nothing behind', async () => {
    await expect(executeHttp(req('/chunked?size=1000'), { toFile: join(dir, 'missing', 'x.bin') })).rejects.toMatchObject({ code: 'io_error' })
  })

  it('readLimitedBody: exactly the limit is fine, one byte more is not', async () => {
    const at = await readLimitedBody(await fetch(`${base}/chunked?size=${MB}`), MB)
    expect(at.ok && at.bytes.length).toBe(MB)
    const over = await readLimitedBody(await fetch(`${base}/chunked?size=${MB + 1}`), MB)
    expect(over.ok).toBe(false)
  })
})

describe('user sends (executeHttpRequest)', () => {
  let env: TestEnv
  let wsId: string
  beforeEach(async () => {
    env = makeEnv()
    wsId = (await scaffold(env)).workspace.id
  })
  afterEach(() => env.cleanup())

  it('applies the limit from the request (clamped) and records the send in history', async () => {
    const res = await env.api.executeHttpRequest(baseHttp(wsId, { url: `${base}/chunked?size=${2 * MB}`, maxResponseBytes: 1 }))
    expect(res.bodyTooLarge).toEqual({ limitBytes: 1 * MB }) // 1 byte is clamped up to 1 MB
    const ok = await env.api.executeHttpRequest(baseHttp(wsId, { url: `${base}/chunked?size=${2 * MB}`, maxResponseBytes: 3 * MB }))
    expect(ok.bodyTooLarge).toBeUndefined()
    expect(ok.bodyText).toHaveLength(2 * MB)
    expect((await env.api.listHistory(wsId)).map((h) => h.statusCode)).toEqual([200, 200])
  })

  it('Send and download to file: main picks the file, the id works once, the renderer never names a path', async () => {
    const file = join(dir, 'download.bin')
    env.saved.result = file
    const target = await env.api.chooseResponseDownloadFile('../../etc/report?.bin')
    expect(env.saved.calls).toEqual([{ title: 'Download the response to', defaultName: 'report_.bin' }])
    expect(target).toEqual({ downloadId: expect.any(String), fileName: 'download.bin' })
    const res = await env.api.executeHttpRequest(baseHttp(wsId, { url: `${base}/chunked?size=${2 * MB}`, maxResponseBytes: 1 * MB, downloadId: target!.downloadId }))
    expect(res).toMatchObject({ savedToFile: file, bodyByteLength: 2 * MB, bodyText: null })
    expect(readFileSync(file).length).toBe(2 * MB)
    // One request per choice; unknown ids are refused before anything is sent.
    await expect(env.api.executeHttpRequest(baseHttp(wsId, { url: `${base}/chunked?size=1`, downloadId: target!.downloadId }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.executeHttpRequest(baseHttp(wsId, { url: `${base}/chunked?size=1`, downloadId: 'not-a-uuid' }))).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a cancelled save dialog sends nothing', async () => {
    env.saved.result = null
    expect(await env.api.chooseResponseDownloadFile('x.bin')).toBeNull()
    expect(await env.api.listHistory(wsId)).toEqual([])
  })

  it('download ids expire', () => {
    const t = env.core.http.registerDownload(join(dir, 'late.bin'), Date.now() - 11 * 60_000)
    return expect(env.api.executeHttpRequest(baseHttp(wsId, { url: `${base}/chunked?size=1`, downloadId: t.downloadId }))).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('safe suggested names', () => {
    expect(safeDownloadName('a/b\\c.json')).toBe('c.json')
    expect(safeDownloadName('..')).toBe('response')
    expect(safeDownloadName('')).toBe('response')
    expect(safeDownloadName('.hidden')).toBe('hidden')
  })
})

describe('fixed caps', () => {
  it('pm.sendRequest loads at most 10 MB and says so', async () => {
    expect(SCRIPT_MAX_RESPONSE_BYTES).toBe(10 * MB)
    const out = await runScriptSendRequest(
      { method: 'GET', url: `${base}/chunked?size=${40 * MB}`, headers: [], auth: { kind: 'none' }, body: { mode: 'none' }, timeoutMs: 10_000 } as never,
      new AbortController().signal,
      { redact: (t) => t },
    )
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('larger than 10 MB') })
    await expect.poll(() => sent.aborted).toBe(true)
  })

  it('OpenAPI import by URL stops downloading at 50 MB even without a Content-Length', async () => {
    const svc = new OpenApiService({ db: {} as never, fetchImpl: fetch })
    await expect(svc.fetchSpec(`${base}/chunked?size=${120 * MB}`)).rejects.toMatchObject({ code: 'invalid_input', message: 'The document is larger than 50 MB' })
    await expect.poll(() => sent.aborted).toBe(true)
    expect(sent.bytes).toBeLessThan(120 * MB)
  })
})
