// @vitest-environment node
/**
 * Runs the PowerShell snippets for real, in every PowerShell installed here: Windows PowerShell 5.1 (`powershell.exe`, built
 * into Windows) and PowerShell 7 (`pwsh`). Skipped where neither exists; the release workflow's Windows job runs it.
 */
import { spawnSync } from 'node:child_process'
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

beforeAll(async () => {
  if (!SHELLS.length) return
  dir = mkdtempSync(join(tmpdir(), 'slinger-ps-'))
  const handler: RequestListener = (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
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

function run(shell: string, input: Partial<HttpRequestInput>, requests = 1): { out: string; last: Seen } {
  seen = []
  const script = generateSnippet('powershell', {
    method: 'GET', url: `${base}/x`, headers: [], auth: { kind: 'none' }, body: { mode: 'none' }, workspaceId: 'w', ...input,
  } as HttpRequestInput)
  const file = join(dir, 'snippet.ps1')
  // UTF-8 with BOM: Windows PowerShell 5.1 reads a .ps1 without a BOM as the ANSI code page.
  writeFileSync(file, '﻿' + script, 'utf8')
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 120_000 })
  expect(r.status, `${shell} failed:\n${r.stderr}\n--- script ---\n${script}`).toBe(0)
  expect(seen.length, `${shell} sent ${seen.length} requests:\n${r.stderr}`).toBe(requests)
  return { out: r.stdout, last: seen[seen.length - 1]! }
}

describe.runIf(SHELLS.length > 0).each(SHELLS)('PowerShell snippets in %s', (shell) => {
  it('GET with headers and a User-Agent', () => {
    const { out, last } = run(shell, { headers: [{ key: 'X-Trace', value: 'abc' }, { key: 'User-Agent', value: 'slinger-test/1' }] })
    expect(last.method).toBe('GET')
    expect(last.headers['x-trace']).toBe('abc')
    expect(last.headers['user-agent']).toBe('slinger-test/1')
    expect(out).toContain('200')
    expect(out).toContain('ok-from-server')
  })

  it('POST JSON with non-ASCII text arrives as UTF-8', () => {
    const json = '{"name":"Ābebe ሰላም ✓"}'
    const { last } = run(shell, { method: 'POST', headers: [{ key: 'Content-Type', value: 'application/json' }], body: { mode: 'raw', raw: { content: json, contentType: 'application/json' } } })
    expect(last.method).toBe('POST')
    expect(last.headers['content-type']).toContain('application/json')
    expect(last.body.toString('utf8')).toBe(json)
  })

  it('a 404 prints the status and the server answer instead of only an error', () => {
    const { out } = run(shell, { url: `${base}/missing` })
    expect(out).toContain('404')
    expect(out).toContain('not here')
  })

  it('urlencoded form', () => {
    const { last } = run(shell, {
      method: 'POST',
      headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
      body: { mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: 'b c&d', enabled: true }] },
    })
    expect(last.body.toString('utf8')).toBe('a=b%20c%26d')
  })

  it('multipart with a text field and a file', () => {
    const file = join(dir, 'upload.txt')
    writeFileSync(file, 'file-content-123')
    const { out, last } = run(shell, {
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

  it('follows redirects by default; not when the request says so (status 302 printed, one request)', () => {
    const followed = run(shell, { url: `${base}/redirect` }, 2)
    expect(followed.last.url).toBe('/x')
    expect(followed.out).toContain('ok-from-server')
    const stopped = run(shell, { url: `${base}/redirect`, followRedirects: false })
    expect(stopped.last.url).toBe('/redirect')
    expect(stopped.out).toContain('302')
  })

  it('SSL verification off reaches a server whose certificate is not trusted (Invoke-WebRequest and HttpClient)', () => {
    const { out } = run(shell, { url: `${tlsBase}/x`, strictSSL: false })
    expect(out).toContain('ok-from-server')
    const { out: multipart } = run(shell, {
      url: `${tlsBase}/x`,
      method: 'POST',
      strictSSL: false,
      body: { mode: 'formData', formData: [{ key: 'note', value: 'hi', type: 'text', enabled: true }] },
    } as Partial<HttpRequestInput>)
    expect(multipart).toContain('ok-from-server')
  })

  it('multipart without following redirects', () => {
    const { out } = run(shell, {
      url: `${base}/redirect`,
      method: 'POST',
      followRedirects: false,
      body: { mode: 'formData', formData: [{ key: 'note', value: 'hi', type: 'text', enabled: true }] },
    } as Partial<HttpRequestInput>)
    expect(out).toContain('302')
  })

  it('binary body from a file', () => {
    const file = join(dir, 'blob.bin')
    writeFileSync(file, Buffer.from([0, 1, 2, 250, 255]))
    const { last } = run(shell, { method: 'PUT', body: { mode: 'binary', binaryFilePath: file } } as Partial<HttpRequestInput>)
    expect([...last.body]).toEqual([0, 1, 2, 250, 255])
  })
})

describe.skipIf(SHELLS.length > 0)('PowerShell snippets', () => {
  it('no PowerShell installed here: the real-shell checks run on Windows (release workflow)', () => {
    expect(SHELLS).toEqual([])
  })
})
