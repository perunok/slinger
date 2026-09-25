import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Recorded {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
}

// 1x1 transparent PNG.
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
// Smallest single-page PDF that Chromium's viewer opens.
export const PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 40 Td (Slinger PDF) Tj ET\nendstream\nendobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
)

/**
 * Local target for the app under test. Records every request in full (including the
 * Authorization header value) so tests can assert what really went over the wire, while
 * the JSON it answers with deliberately omits credentials.
 */
export async function startTarget(): Promise<{ url: string; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      const path = (req.url ?? '').split('?')[0]
      if (path === '/binary.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return void res.end(PNG)
      }
      if (path === '/doc.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        return void res.end(PDF)
      }
      if (path === '/page.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return void res.end(
          '<html><body><h1 id="hello">Hello preview</h1><p style="color:red">styled</p>' +
            '<img src="http://127.0.0.1:1/beacon.png"><script>document.title="script-ran"</script></body></html>',
        )
      }
      if (path === '/blob.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        return void res.end(Buffer.from([0, 255, 254, 1, 2, 3, 128, 200]))
      }
      if (path === '/redirect/ok') {
        res.writeHead(302, { Location: '/redirect/landed' })
        return void res.end()
      }
      if (path === '/redirect/nowhere') {
        // A 3xx without a Location: fetch cannot follow it, so the client sees the 302 itself.
        res.writeHead(302)
        return void res.end()
      }
      const auth = req.headers.authorization
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Echo-Path': path ?? '' })
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headerNames: Object.keys(req.headers),
          trace: req.headers['x-trace'] ?? null,
          hasAuthorization: Boolean(auth),
          contentType: req.headers['content-type'] ?? null,
          bodyLength: body.length,
          // Text bodies are echoed except when they carry the secret (checked separately on the wire).
          body: req.headers['content-type']?.includes('json') ? JSON.parse(body.toString() || 'null')?.user ?? null : null,
        }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  }
}
