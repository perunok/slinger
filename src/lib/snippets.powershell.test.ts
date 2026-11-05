// @vitest-environment node
/**
 * Runs the PowerShell snippets for real, in every PowerShell installed here: Windows PowerShell 5.1 (`powershell.exe`, built
 * into Windows) and PowerShell 7 (`pwsh`). Skipped where neither exists; the release workflow's Windows job runs it.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '../../shared/types'
import { generateSnippet } from './snippets'

function available(cmd: string): boolean {
  const r = spawnSync(cmd, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 60_000 })
  return r.status === 0 && /^\d+/.test(r.stdout.trim())
}
const SHELLS = ['powershell.exe', 'pwsh'].filter(available)

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
let server: Server
let tlsServer: Server
let base = ''
/** https with a certificate from the test CA (not trusted by the OS): only a snippet with SSL verification off gets through. */
let tlsBase = ''
let seen: Seen[] = []
let dir = ''

/**
 * Digest (RFC 2617, MD5, qop auth) for paths under /digest: user "alice", password "s3cret pw". Answers 401 with a challenge
 * until a request carries a correct answer for its own method and URI. Checks the snippet's `-Credential` / handler
 * Credentials claim in both shells.
 */
const DIGEST_REALM = 'ps@test'
const DIGEST_NONCE = randomBytes(12).toString('hex')
function digestOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? ''
  if (!h.startsWith('Digest ')) return false
  const p: Record<string, string> = {}
  for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) p[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? ''
  const md5 = (t: string) => createHash('md5').update(t).digest('hex')
  if (p.username !== 'alice' || p.realm !== DIGEST_REALM || p.nonce !== DIGEST_NONCE || p.uri !== req.url) return false
  const ha1 = md5(`alice:${DIGEST_REALM}:s3cret pw`)
  const ha2 = md5(`${req.method}:${p.uri}`)
  const expected = p.qop ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`)
  return expected === p.response
}

beforeAll(async () => {
  if (!SHELLS.length) return
  dir = mkdtempSync(join(tmpdir(), 'slinger-ps-'))
  const handler: RequestListener = (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      if (req.url?.startsWith('/digest') && !digestOk(req)) {
        res.writeHead(401, { 'WWW-Authenticate': `Digest realm="${DIGEST_REALM}", nonce="${DIGEST_NONCE}", qop="auth", algorithm=MD5`, 'content-type': 'text/plain' })
        res.end('digest required')
        return
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/x' })
        res.end('moved')
        return
      }
      if (req.url === '/missing') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not here"}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('ok-from-server')
    })
  }
  server = createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const tls = join(__dirname, '../../electron/__tests__/fixtures/tls')
  tlsServer = createHttpsServer({ cert: readFileSync(join(tls, 'server.crt')), key: readFileSync(join(tls, 'server.key')) }, handler)
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r))
  tlsBase = `https://localhost:${(tlsServer.address() as AddressInfo).port}`
})
afterAll(async () => {
  if (!SHELLS.length) return
  await new Promise<void>((r) => server.close(() => r()))
  await new Promise<void>((r) => tlsServer.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

/** Runs the snippet without blocking: the test's HTTP server lives in this process and must keep answering meanwhile. */
function runShell(shell: string, file: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

/** `requests`: how many requests the server must see (null: at least one; .NET decides how it retries an auth challenge). */
async function run(shell: string, input: Partial<HttpRequestInput>, requests: number | null = 1): Promise<{ out: string; last: Seen }> {
  seen = []
  const script = generateSnippet('powershell', {
    method: 'GET', url: `${base}/x`, headers: [], auth: { kind: 'none' }, body: { mode: 'none' }, workspaceId: 'w', ...input,
  } as HttpRequestInput)
  const file = join(dir, 'snippet.ps1')
  // UTF-8 with BOM: Windows PowerShell 5.1 reads a .ps1 without a BOM as the ANSI code page.
  writeFileSync(file, '\uFEFF' + script, 'utf8')
  const r = await runShell(shell, file)
  expect(r.status, `${shell} failed:\n${r.stderr}\n--- script ---\n${script}`).toBe(0)
  if (requests === null) expect(seen.length, `${shell} sent no request:\n${r.stderr}`).toBeGreaterThan(0)
  else expect(seen.length, `${shell} sent ${seen.length} requests:\n${r.stderr}`).toBe(requests)
  return { out: r.stdout, last: seen[seen.length - 1]! }
}

describe.runIf(SHELLS.length > 0).each(SHELLS)('PowerShell snippets in %s', { timeout: 150_000 }, (shell) => {
  it('GET with headers and a User-Agent', async () => {
    const { out, last } = await run(shell, { headers: [{ key: 'X-Trace', value: 'abc' }, { key: 'User-Agent', value: 'slinger-test/1' }] })
    expect(last.method).toBe('GET')
    expect(last.headers['x-trace']).toBe('abc')
    expect(last.headers['user-agent']).toBe('slinger-test/1')
    expect(out).toContain('200')
    expect(out).toContain('ok-from-server')
  })

  it('POST JSON with non-ASCII text arrives as UTF-8', async () => {
    const json = '{"name":"Ābebe ሰላም ✓"}'
    const { last } = await run(shell, { method: 'POST', headers: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: { content: json, contentType: 'application/json' } } })
    expect(last.method).toBe('POST')
    expect(last.headers['content-type']).toContain('application/json')
    expect(last.body.toString('utf8')).toBe(json)
  })

  it('a 404 prints the status and the server answer instead of only an error', async () => {
    const { out } = await run(shell, { url: `${base}/missing` })
    expect(out).toContain('404')
    expect(out).toContain('not here')
  })

  it('urlencoded form', async () => {
    const { last } = await run(shell, {
      method: 'POST',
      headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: 'b c&d', enabled: true }] },
    })
    expect(last.body.toString('utf8')).toBe('a=b%20c%26d')
  })

  it('multipart with a text field and a file', async () => {
    const file = join(dir, 'upload.txt')
    writeFileSync(file, 'file-content-123')
    const { out, last } = await run(shell, {
      method: 'POST',
      headers: [{ key: 'X-Trace', value: 'mp' }],
      body: {
        mode: 'formData',
        formData: [
          { key: 'note', value: 'hello', type: 'text', enabled: true },
          { key: 'doc', value: '', filePath: file, type: 'file', enabled: true },
        ],
      },
    } as Partial<HttpRequestInput>)
    expect(last.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(last.headers['x-trace']).toBe('mp')
    const body = last.body.toString('utf8')
    expect(body).toMatch(/name="?note"?/)
    expect(body).toContain('hello')
    expect(body).toMatch(/filename="?upload\.txt"?/)
    expect(body).toContain('file-content-123')
    expect(out).toContain('200')
  })

  it('follows redirects by default; not when the request says so (status 302 printed, one request)', async () => {
    const followed = await run(shell, { url: `${base}/redirect` }, 2)
    expect(followed.last.url).toBe('/x')
    expect(followed.out).toContain('ok-from-server')
    const stopped = await run(shell, { url: `${base}/redirect`, followRedirects: false })
    expect(stopped.last.url).toBe('/redirect')
    expect(stopped.out).toContain('302')
  })

  it('SSL verification off reaches a server whose certificate is not trusted (Invoke-WebRequest and HttpClient)', async () => {
    const { out } = await run(shell, { url: `${tlsBase}/x`, strictSSL: false })
    expect(out).toContain('ok-from-server')
    const { out: multipart } = await run(shell, {
      url: `${tlsBase}/x`,
      method: 'POST',
      strictSSL: false,
      body: { mode: 'formData', formData: [{ key: 'note', value: 'hi', type: 'text', enabled: true }] },
    } as Partial<HttpRequestInput>)
    expect(multipart).toContain('ok-from-server')
  })

  it('multipart without following redirects', async () => {
    const { out } = await run(shell, {
      url: `${base}/redirect`,
      method: 'POST',
      followRedirects: false,
      body: { mode: 'formData', formData: [{ key: 'note', value: 'hi', type: 'text', enabled: true }] },
    } as Partial<HttpRequestInput>)
    expect(out).toContain('302')
  })

  it('Digest auth over plain http: -Credential answers the challenge (Invoke-WebRequest and HttpClient)', async () => {
    const auth = { kind: 'digest' as const, digest: { username: 'alice', password: 's3cret pw' } }
    const get = await run(shell, { url: `${base}/digest/get?q=1`, auth }, null)
    expect(get.out).toContain('ok-from-server')
    expect(get.last.headers.authorization).toMatch(/^Digest /)
    expect(digestOk({ ...get.last, headers: get.last.headers } as unknown as IncomingMessage)).toBe(true)
    const post = await run(shell, { url: `${base}/digest/post`, method: 'POST', auth, body: { mode: 'raw', raw: { content: '{"a":1}', contentType: 'application/json' } } }, null)
    expect(post.out).toContain('ok-from-server')
    expect(post.last.body.toString('utf8')).toBe('{"a":1}')
    const multipart = await run(
      shell,
      { url: `${base}/digest/form`, method: 'POST', auth, body: { mode: 'formData', formData: [{ key: 'note', value: 'hi', type: 'text', enabled: true }] } } as Partial<HttpRequestInput>,
      null,
    )
    expect(multipart.out).toContain('ok-from-server')
    expect(multipart.last.body.toString('utf8')).toContain('hi')
    // A wrong password ends with the server's 401 (printed by the catch block / the status line).
    const wrong = await run(shell, { url: `${base}/digest/get`, auth: { kind: 'digest', digest: { username: 'alice', password: 'nope' } } }, null)
    expect(wrong.out).toContain('401')
  })

  it('binary body from a file', async () => {
    const file = join(dir, 'blob.bin')
    writeFileSync(file, Buffer.from([0, 1, 2, 250, 255]))
    const { last } = await run(shell, { method: 'PUT', body: { mode: 'binary', binaryFilePath: file } } as Partial<HttpRequestInput>)
    expect([...last.body]).toEqual([0, 1, 2, 250, 255])
  })
})

describe.skipIf(SHELLS.length > 0)('PowerShell snippets', () => {
  it('no PowerShell installed here: the real-shell checks run on Windows (release workflow)', () => {
    expect(SHELLS).toEqual([])
  })
})
