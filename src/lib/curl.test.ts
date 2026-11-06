import { describe, expect, it } from 'vitest'
import { curlRequestName, curlSettingsLabels, curlToDraft, looksLikeCurl, parseCurl, type ParsedCurl } from './curl'
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
      'This command uses the proxy http://proxy:8080, which was not imported: Slinger sets it for all requests in Settings > Network.',
      'This command uses a client or CA certificate, which was not imported: Slinger sets it for all requests in Settings > Network.',
      '--frobnicate was ignored.',
      'The header "nocolon" has no colon and was skipped.',
    ])
  })

  describe('request settings and app-wide options (0.30)', () => {
    it('-k / --insecure turns SSL verification off for the request', () => {
      expect(one('curl -k https://h.example/').settings).toEqual({ strictSSL: false })
      expect(one('curl --insecure https://h.example/').settings).toEqual({ strictSSL: false })
      expect(one('curl -skL https://h.example/')).toMatchObject({ settings: { strictSSL: false }, warnings: [] })
      expect(one('curl https://h.example/').settings).toEqual({})
    })

    it('-L and its absence both keep the default (follow redirects, like the browser the command was copied from)', () => {
      expect(one('curl -L https://h.example/')).toMatchObject({ settings: {}, warnings: [] })
      expect(one('curl --location https://h.example/')).toMatchObject({ settings: {}, warnings: [] })
      expect(one('curl https://h.example/').settings).toEqual({})
    })

    it('--max-redirs sets the maximum (10 is the default; -1 = no limit = the largest maximum)', () => {
      expect(one('curl -L --max-redirs 3 https://h.example/').settings).toEqual({ maxRedirects: 3 })
      expect(one('curl --max-redirs=0 https://h.example/').settings).toEqual({ maxRedirects: 0 })
      expect(one('curl --max-redirs 10 https://h.example/').settings).toEqual({})
      expect(one('curl --max-redirs -1 https://h.example/').settings).toEqual({ maxRedirects: 1000 })
      expect(one('curl --max-redirs 5000 https://h.example/').settings).toEqual({ maxRedirects: 1000 })
      const bad = one('curl --max-redirs lots https://h.example/')
      expect(bad.settings).toEqual({})
      expect(bad.warnings).toEqual(['--max-redirs lots is not a number and was ignored.'])
    })

    it('--post301/302/303 keep the method on redirects; --location-trusted keeps Authorization', () => {
      for (const f of ['--post301', '--post302', '--post303']) {
        expect(one(`curl -L ${f} -d a=1 https://h.example/`).settings).toEqual({ followOriginalHttpMethod: true })
      }
      expect(one('curl --location-trusted -u a:b https://h.example/')).toMatchObject({ settings: { followAuthorizationHeader: true }, warnings: [] })
    })

    it('a proxy (credentials hidden), proxy credentials and certificates point to Settings > Network', () => {
      const p = one('curl --proxy http://bob:pw@proxy.example:3128 -U bob:pw2 https://h.example/')
      expect(p.warnings).toEqual([
        'This command uses the proxy http://proxy.example:3128, which was not imported: Slinger sets it for all requests in Settings > Network.',
        'This command uses proxy credentials, which were not imported: Slinger sets it for all requests in Settings > Network.',
      ])
      expect(JSON.stringify(p)).not.toContain('pw')
      const c = one('curl -E client.pem:secretpass --key k.pem --cacert ca.pem --capath /etc/ssl --pass pp https://h.example/')
      expect(c.warnings).toEqual(['This command uses a client or CA certificate, which was not imported: Slinger sets it for all requests in Settings > Network.'])
      expect(JSON.stringify(c)).not.toContain('secretpass')
    })

    it('-b stays a Cookie header; -c / --cookie-jar points to the cookie jar', () => {
      const p = one(`curl -b 'sid=abc' -c jar.txt https://h.example/`)
      expect(p.headers).toEqual([{ key: 'Cookie', value: 'sid=abc' }])
      expect(p.warnings).toEqual([
        "The cookie file jar.txt was not used: Slinger keeps the cookies responses set in the workspace's cookie jar (Ctrl+K, Cookies).",
      ])
    })

    it('--compressed is silent; -m / --max-time is the timeout', () => {
      expect(one('curl --compressed -m 7 https://h.example/')).toMatchObject({ timeoutMs: 7000, warnings: [] })
      expect(one('curl --max-time 0.5 https://h.example/').timeoutMs).toBe(500)
    })

    it("Chrome's Copy as cURL (cmd) and (bash) with -k and --compressed", () => {
      const cmd = one(`curl "https://self-signed.example/api" ^
  -H "accept: */*" ^
  --compressed ^
  --insecure`)
      expect(cmd).toMatchObject({ url: 'https://self-signed.example/api', settings: { strictSSL: false }, warnings: [] })
      const bash = one(`curl 'https://self-signed.example/api' \\
  -H 'accept: */*' \\
  --compressed \\
  --insecure`)
      expect(bash).toMatchObject({ url: 'https://self-signed.example/api', settings: { strictSSL: false }, warnings: [] })
    })

    it('the settings go into the draft (request Settings tab) and the preview labels', () => {
      const p = one('curl -k --max-redirs 2 --post302 --location-trusted https://h.example/')
      expect(curlToDraft(p).protocolProfileBehavior).toEqual({ strictSSL: false, maxRedirects: 2, followOriginalHttpMethod: true, followAuthorizationHeader: true })
      expect(curlSettingsLabels(p)).toEqual(['SSL verification off', 'at most 2 redirects', 'keeps the method on redirects', 'keeps Authorization on redirects'])
      expect(curlSettingsLabels(one('curl https://h.example/'))).toEqual([])
    })
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

  it('keeps :name path segments as path variables (empty values)', () => {
    const d = curlToDraft(one(`curl 'https://h.example:8443/users/:id/posts/:postId?x=1'`))
    expect(d.url).toBe('https://h.example:8443/users/:id/posts/:postId?x=1')
    expect(d.pathVariables).toEqual([{ key: 'id', value: '', description: '' }, { key: 'postId', value: '', description: '' }])
  })
})
