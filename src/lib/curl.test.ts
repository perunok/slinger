import { describe, expect, it } from 'vitest'
import { curlRequestName, curlToDraft, looksLikeCurl, parseCurl, type ParsedCurl } from './curl'
import { dataRows } from './kv'

function one(text: string): ParsedCurl {
  const r = parseCurl(text)
  if (!r.ok) throw new Error(r.error)
  expect(r.requests).toHaveLength(1)
  return r.requests[0]!
}

const rows = (list: Array<{ key: string; value: string; kind?: string }>) => dataRows(list as never).map((r) => [r.key, r.value, r.kind])

describe('parseCurl', () => {
  it('reads a plain GET', () => {
    const p = one("curl 'https://api.example.com/users?page=2'")
    expect(p).toMatchObject({ method: 'GET', url: 'https://api.example.com/users?page=2', headers: [], auth: null, warnings: [] })
    expect(p.body.kind).toBe('none')
  })

  it('reads a multi-line POST with JSON, headers and line continuations', () => {
    const p = one(`curl -X POST https://api.example.com/orders \\
  -H 'Content-Type: application/json' \\
  -H "Authorization: Bearer abc.def" \\
  -d '{"item": "book", "qty": 2}'`)
    expect(p.method).toBe('POST')
    expect(p.headers).toEqual([
      { key: 'Content-Type', value: 'application/json' },
      { key: 'Authorization', value: 'Bearer abc.def' },
    ])
    expect(p.body).toMatchObject({ kind: 'raw', raw: '{"item": "book", "qty": 2}', rawLanguage: 'json' })
  })

  it("reads Chrome's Copy as cURL (bash): $'…' quoting and --data-raw", () => {
    const p = one(`curl 'https://example.com/api/x' \\
  -H 'accept: application/json' \\
  -H 'content-type: application/json' \\
  --data-raw $'{"note":"it\\'s ok\\\\n","a":"\\u00e9"}' \\
  --compressed`)
    expect(p.method).toBe('POST')
    expect(p.body).toMatchObject({ kind: 'raw', rawLanguage: 'json' })
    expect(JSON.parse(p.body.raw)).toEqual({ note: "it's ok\n", a: 'é' })
    expect(p.warnings).toEqual([])
  })

  it("reads Chrome's Copy as cURL (cmd): ^ escapes and ^ line ends", () => {
    const p = one(`curl "https://example.com/api/x" ^
  -H "accept: */*" ^
  -H "content-type: application/json" ^
  --data-raw ^"^{^\\^"a^\\^":1^}^"`)
    expect(p.url).toBe('https://example.com/api/x')
    expect(p.headers).toContainEqual({ key: 'accept', value: '*/*' })
    expect(JSON.parse(p.body.raw)).toEqual({ a: 1 })
  })

  it('splits several commands (Copy all as cURL, ;, &&) and skips other commands', () => {
    const r = parseCurl(`export TOKEN=abc;
curl https://a.example/one
curl -X DELETE https://a.example/two && curl https://a.example/three | jq .`)
    expect(r.ok && r.requests.map((x) => [x.method, x.url])).toEqual([
      ['GET', 'https://a.example/one'],
      ['DELETE', 'https://a.example/two'],
      ['GET', 'https://a.example/three'],
    ])
  })

  it('turns shell variables into {{variables}}, but not inside single quotes', () => {
    const p = one(`curl "$BASE_URL/users" -H "Authorization: Bearer \${TOKEN}" -H 'X-Literal: $NOT'`)
    expect(p.url).toBe('{{BASE_URL}}/users')
    expect(p.headers).toEqual([
      { key: 'Authorization', value: 'Bearer {{TOKEN}}' },
      { key: 'X-Literal', value: '$NOT' },
    ])
  })

  it('combined and attached short options, --long=value', () => {
    const p = one(`curl -sSL -XPUT -H'X-A: 1' --header=X-B:2 --url=https://h.example/p -m 2.5`)
    expect(p).toMatchObject({ method: 'PUT', url: 'https://h.example/p', timeoutMs: 2500, warnings: [] })
    expect(p.headers).toEqual([
      { key: 'X-A', value: '1' },
      { key: 'X-B', value: '2' },
    ])
  })

  it('-d without a Content-Type is url-encoded form data; several -d join with &', () => {
    const p = one(`curl https://h.example/login -d 'user=ann' -d 'pass=a%26b+c'`)
    expect(p.method).toBe('POST')
    expect(p.body.kind).toBe('urlEncoded')
    expect(rows(p.body.urlEncoded)).toEqual([
      ['user', 'ann', 'text'],
      ['pass', 'a&b c', 'text'],
    ])
  })

  it('JSON data without a Content-Type becomes a JSON body, with a note', () => {
    const p = one(`curl https://h.example/x -d '{"a":1}'`)
    expect(p.body).toMatchObject({ kind: 'raw', rawLanguage: 'json', raw: '{"a":1}' })
    expect(p.warnings[0]).toContain('imported as a JSON body')
  })

  it('--json sets JSON headers; --data-urlencode encodes the value', () => {
    const j = one(`curl --json '{"x":true}' https://h.example/j`)
    expect(j.headers).toEqual([
      { key: 'Content-Type', value: 'application/json' },
      { key: 'Accept', value: 'application/json' },
    ])
    expect(j.body).toMatchObject({ kind: 'raw', rawLanguage: 'json' })
    const u = one(`curl https://h.example/s --data-urlencode 'q=a b&c' --data-urlencode 'raw'`)
    expect(u.body.kind).toBe('raw')
    expect(u.body.raw).toBe('q=a%20b%26c&raw')
  })

  it('-F form fields (text and files) drop a copied multipart Content-Type', () => {
    const p = one(`curl https://h.example/up -H 'Content-Type: multipart/form-data; boundary=x' -F name=report -F 'file=@/tmp/a.pdf;type=application/pdf' --form-string 'raw=@not-a-file'`)
    expect(p.method).toBe('POST')
    expect(p.headers).toEqual([])
    expect(rows(p.body.formData)).toEqual([
      ['name', 'report', 'text'],
      ['file', '/tmp/a.pdf', 'file'],
      ['raw', '@not-a-file', 'text'],
    ])
  })

  it('-G puts data in the query; -I is HEAD; -T uploads a file with PUT', () => {
    expect(one(`curl -G https://h.example/s -d q=cats -d page=2`)).toMatchObject({ method: 'GET', url: 'https://h.example/s?q=cats&page=2' })
    expect(one(`curl -I https://h.example/`).method).toBe('HEAD')
    const t = one(`curl -T ./photo.jpg https://h.example/photos/1`)
    expect(t).toMatchObject({ method: 'PUT', body: { kind: 'binary', binaryPath: './photo.jpg' } })
    expect(t.warnings[0]).toContain('photo.jpg')
  })

  it('-u is basic auth, --oauth2-bearer bearer auth; -A, -e and -b become headers', () => {
    expect(one(`curl -u ann:s3cr:et https://h.example/`).auth).toEqual({ kind: 'basic', username: 'ann', password: 's3cr:et' })
    expect(one(`curl --oauth2-bearer tok https://h.example/`).auth).toEqual({ kind: 'bearer', token: 'tok' })
    expect(one(`curl -A 'Agent/1' -e https://ref.example -b 'a=1; b=2' https://h.example/`).headers).toEqual([
      { key: 'User-Agent', value: 'Agent/1' },
      { key: 'Referer', value: 'https://ref.example' },
      { key: 'Cookie', value: 'a=1; b=2' },
    ])
  })

  it('adds http:// to a URL without a scheme, like curl; keeps a leading {{variable}}', () => {
    expect(one('curl localhost:3000/health').url).toBe('http://localhost:3000/health')
    expect(one('curl {{baseUrl}}/health').url).toBe('{{baseUrl}}/health')
  })

  it('lists options it did not import', () => {
    const p = one(`curl -x http://proxy:8080 --cert c.pem --frobnicate https://h.example/ -H 'nocolon'`)
    expect(p.warnings).toEqual([
      'The proxy http://proxy:8080 was not imported (Slinger uses the system proxy).',
      '--cert was ignored.',
      '--frobnicate was ignored.',
      'The header "nocolon" has no colon and was skipped.',
    ])
  })

  it('reports what cannot be read', () => {
    expect(parseCurl('wget https://x')).toEqual({ ok: false, error: 'Not a cURL command: it must start with "curl".' })
    expect(parseCurl("curl 'https://x")).toEqual({ ok: false, error: "A single quote (') is never closed." })
    expect(parseCurl('curl -s -L')).toEqual({ ok: false, error: 'No URL found.' })
    expect(parseCurl('curl https://x -H')).toEqual({ ok: false, error: '-H needs a value.' })
    expect(parseCurl('curl https://a.example\ncurl -X')).toEqual({ ok: false, error: 'Command 2: -X needs a value.' })
  })

  it('looksLikeCurl', () => {
    expect(looksLikeCurl('  curl https://x')).toBe(true)
    expect(looksLikeCurl('curl.exe https://x')).toBe(true)
    expect(looksLikeCurl('curly https://x')).toBe(false)
    expect(looksLikeCurl('https://x')).toBe(false)
  })
})

describe('drafts', () => {
  it('names requests by method and path (the host for the root)', () => {
    expect(curlRequestName({ method: 'GET', url: 'https://api.example.com/users/1?x=1' })).toBe('GET /users/1')
    expect(curlRequestName({ method: 'POST', url: 'https://api.example.com' })).toBe('POST api.example.com')
    expect(curlRequestName({ method: 'GET', url: '{{base}}/x' })).toBe('GET {{base}}/x')
  })

  it('builds a draft with query params, headers, body and auth', () => {
    const d = curlToDraft(one(`curl -u ann:pw -H 'X-A: 1' 'https://h.example/s?q=1' -d '{"a":1}' -H 'Content-Type: application/json'`))
    expect(d).toMatchObject({ name: 'POST /s', method: 'POST', url: 'https://h.example/s?q=1', auth: { kind: 'basic', basic: { username: 'ann', password: 'pw' } } })
    expect(dataRows(d.params).map((r) => [r.key, r.value])).toEqual([['q', '1']])
    expect(dataRows(d.headers).map((r) => [r.key, r.value])).toEqual([
      ['X-A', '1'],
      ['Content-Type', 'application/json'],
    ])
    expect(d.body).toMatchObject({ kind: 'raw', rawLanguage: 'json' })
  })
})
