import type { RequestHeader } from '../../../shared/types'
import { base64ToBytes, fail } from './util'

export const MOCK_HOST = 'mock.slinger.local'

export interface CannedResponse {
  status: number
  statusText: string
  contentType: string
  extraHeaders?: RequestHeader[]
  body: string | Uint8Array
  /** Simulated server-side delay in ms (abortable). */
  delayMs?: number
}

export interface CannedRequest {
  method: string
  url: string
  headers: RequestHeader[]
  bodyText: string
}

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff)

/** Minimal PDF with a real xref table; the binary comment line makes the body non-UTF-8. */
function minimalPdf(): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 18 Tf 20 50 Td (Slinger mock) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
  const offsets: number[] = []
  objs.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return latin1(out)
}

const json = (value: unknown, status = 200, statusText = 'OK'): CannedResponse => ({
  status,
  statusText,
  contentType: 'application/json',
  body: JSON.stringify(value, null, 2),
})

function bigJson(): string {
  const rows = Array.from({ length: 24000 }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    email: `user${i}@example.test`,
    active: i % 3 === 0,
    score: (i * 7919) % 1000,
  }))
  return JSON.stringify(rows)
}

function randomBytes(): Uint8Array {
  const out = new Uint8Array(64)
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(Math.random() * 256)
  out[0] = 0xff // 0xFF is never valid UTF-8, so this always stays binary
  return out
}

function echo(req: CannedRequest): CannedResponse {
  const headers = Object.fromEntries(req.headers.map((h) => [h.key, h.value]))
  return json({ method: req.method, url: req.url, headers, body: req.bodyText })
}

export function isMockHost(url: string): boolean {
  try {
    return new URL(url).hostname === MOCK_HOST
  } catch {
    return false
  }
}

export function cannedResponse(req: CannedRequest): CannedResponse {
  let path: string
  try {
    path = new URL(req.url).pathname.replace(/\/+$/, '') || '/'
  } catch {
    return fail('invalid_input', `Invalid URL: ${req.url}`)
  }
  switch (path) {
    case '/json':
      return json({
        id: 1,
        name: 'Slinger mock',
        tags: ['demo', 'mock'],
        data: { user: { id: 42, profile: { email: 'demo@example.test', roles: ['admin', 'dev'] } }, items: [{ sku: 'a1', qty: 2 }, { sku: 'b2', qty: 5 }] },
      })
    case '/xml':
      return { status: 200, statusText: 'OK', contentType: 'application/xml', body: '<?xml version="1.0"?>\n<root><item id="1">One</item><item id="2">Two</item></root>' }
    case '/html':
      return { status: 200, statusText: 'OK', contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><head><title>Mock</title></head><body><h1>Hello from Slinger</h1><p>Canned HTML page.</p></body></html>' }
    case '/text':
      return { status: 200, statusText: 'OK', contentType: 'text/plain; charset=utf-8', body: 'Hello from the Slinger mock backend.\nSecond line.\n' }
    case '/csv':
      return { status: 200, statusText: 'OK', contentType: 'text/csv', body: 'id,name,score\n1,Ada,98\n2,Linus,87\n3,Grace,99\n' }
    case '/png':
      return { status: 200, statusText: 'OK', contentType: 'image/png', body: base64ToBytes(PNG_1X1) }
    case '/pdf':
      return { status: 200, statusText: 'OK', contentType: 'application/pdf', body: minimalPdf() }
    case '/binary':
      return { status: 200, statusText: 'OK', contentType: 'application/octet-stream', body: randomBytes() }
    case '/404':
      return json({ error: 'not_found', message: 'Resource does not exist' }, 404, 'Not Found')
    case '/500':
      return json({ error: 'internal_error', message: 'Something went wrong' }, 500, 'Internal Server Error')
    case '/302':
      // A redirect that was not followed to a final 2xx (e.g. no usable target): the runner must not pass it.
      return json({ redirect: true }, 302, 'Found')
    case '/slow':
      return { ...json({ ok: true, waitedMs: 3000 }), delayMs: 3000 }
    case '/echo':
      return echo(req)
    case '/cookies':
      return {
        ...json({ cookies: ['session', 'theme'] }),
        extraHeaders: [
          { key: 'Set-Cookie', value: 'session=abc123; Path=/; HttpOnly; SameSite=Lax' },
          { key: 'Set-Cookie', value: 'theme=dark; Path=/; Max-Age=31536000' },
        ],
      }
    case '/big':
      return { status: 200, statusText: 'OK', contentType: 'application/json', body: bigJson() }
    default:
      return json({ error: 'not_found', message: `No canned route for ${path}` }, 404, 'Not Found')
  }
}
