/**
 * Digest and AWS Signature auth (0.30) in the renderer: the Postman v2.1 model round trip (fixtures as Postman exports
 * them), resolution in prepare.ts (secrets just in time), inheritance, script and version views, code snippets and cURL
 * import. Sending (challenge answers, signing) happens in main: electron/__tests__/digestAuth.test.ts / awsSigV4.test.ts.
 */
import { describe, expect, it } from 'vitest'
import type { HttpRequestInput } from '../../shared/types'
import { resolveEffectiveAuth, authKindLabel } from './authInheritance'
import { autoHeaders } from './autoHeaders'
import { curlToDraft, parseCurl } from './curl'
import { newMcpRequestDraft } from './mcpRequest'
import { prepareMcp, prepareRequest, secretsNeeded } from './prepare'
import { emptyAuth, newDraft, parseAuth, parseDocument, serializeAuth, serializeDraft, upgradeDraft, type AuthDraft, type RequestDraft } from './request'
import { scriptAuthView } from './scripts'
import { generateSnippet } from './snippets'
import { makeScope } from './template'
import { render as renderVersion } from './versionDiff'

/** As the Postman app exports them (v2.1, `{key, value, type}`, its own key order, booleans typed). */
const DIGEST_POSTMAN = {
  type: 'digest',
  digest: [
    { key: 'opaque', value: '5ccc069c403ebaf9f0171e9517f40e41', type: 'string' },
    { key: 'clientNonce', value: '0a4f113b', type: 'string' },
    { key: 'nonceCount', value: '00000001', type: 'string' },
    { key: 'qop', value: 'auth', type: 'string' },
    { key: 'nonce', value: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', type: 'string' },
    { key: 'realm', value: 'testrealm@host.com', type: 'string' },
    { key: 'disableRetryRequest', value: true, type: 'boolean' },
    { key: 'algorithm', value: 'MD5', type: 'string' },
    { key: 'password', value: '{{digestPassword}}', type: 'string' },
    { key: 'username', value: 'Mufasa', type: 'string' },
  ],
}
const AWS_POSTMAN = {
  type: 'awsv4',
  awsv4: [
    { key: 'sessionToken', value: '{{awsSession}}', type: 'string' },
    { key: 'service', value: 's3', type: 'string' },
    { key: 'region', value: 'eu-central-1', type: 'string' },
    { key: 'secretKey', value: '{{awsSecret}}', type: 'string' },
    { key: 'accessKey', value: 'AKIAIOSFODNN7EXAMPLE', type: 'string' },
    { key: 'addAuthDataToQuery', value: false, type: 'boolean' },
  ],
}

const base = { name: 'R', method: 'GET', url: 'https://api.test/x' }
const docWith = (auth: unknown) => JSON.stringify({ method: 'GET', url: base.url, auth })
const roundTrip = (auth: unknown) => JSON.parse(serializeDraft(parseDocument({ ...base, documentJson: docWith(auth) })).documentJson).auth

describe('PowerShell Digest helpers', () => {
  it('use names no built-in alias can shadow (h = Get-History)', async () => {
    const { generateSnippet } = await import('./snippets')
    const out = generateSnippet('powershell', {
      method: 'GET', url: 'http://x.test/a?b=1', headers: [], body: { mode: 'none' }, workspaceId: 'w',
      auth: { kind: 'digest', digest: { username: 'u', password: 'p' } },
    } as never)
    const defined = [...out.matchAll(/function ([\w-]+)/g)].map((m) => m[1]!)
    expect(defined.length).toBeGreaterThan(0)
    for (const name of defined) expect(name, name).toMatch(/^[A-Z][a-z]+-[A-Za-z]+$/) // Verb-Noun, like cmdlets
  })
})

describe('model: Postman v2.1 round trip', () => {
  it('Digest: every field read; written back exactly (order, types, booleans)', () => {
    const a = parseAuth(DIGEST_POSTMAN)
    expect(a.kind).toBe('digest')
    expect(a.digest).toMatchObject({
      username: 'Mufasa',
      password: '{{digestPassword}}',
      realm: 'testrealm@host.com',
      nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      algorithm: 'MD5',
      qop: 'auth',
      nonceCount: '00000001',
      clientNonce: '0a4f113b',
      opaque: '5ccc069c403ebaf9f0171e9517f40e41',
      disableRetryRequest: true,
    })
    expect(roundTrip(DIGEST_POSTMAN)).toEqual(DIGEST_POSTMAN)
    expect(authKindLabel(a)).toBe('Digest Auth')
  })

  it('AWS Signature: every field read; written back exactly', () => {
    const a = parseAuth(AWS_POSTMAN)
    expect(a.kind).toBe('awsv4')
    expect(a.awsv4).toMatchObject({
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: '{{awsSecret}}',
      region: 'eu-central-1',
      service: 's3',
      sessionToken: '{{awsSession}}',
      addAuthDataToQuery: false,
    })
    expect(roundTrip(AWS_POSTMAN)).toEqual(AWS_POSTMAN)
    expect(authKindLabel(a)).toBe('AWS Signature')
  })

  it('edits keep the stored order and unknown keys; new keys are appended when set', () => {
    const withUnknown = { type: 'digest', digest: [{ key: 'x-future', value: 'keep' }, ...DIGEST_POSTMAN.digest.slice(-2)] }
    const a = parseAuth(withUnknown)
    a.digest = { ...a.digest!, username: 'Simba', realm: 'pride rock', disableRetryRequest: false }
    expect(serializeAuth(a)).toEqual({
      type: 'digest',
      digest: [
        { key: 'x-future', value: 'keep' },
        { key: 'password', value: '{{digestPassword}}', type: 'string' },
        { key: 'username', value: 'Simba', type: 'string' },
        { key: 'realm', value: 'pride rock', type: 'string' },
      ],
    })
  })

  it('a new auth writes Postman defaults; v2.0 objects and string booleans are read', () => {
    const d: AuthDraft = { ...emptyAuth(), kind: 'digest' }
    expect(serializeAuth(d)).toEqual({
      type: 'digest',
      digest: [
        { key: 'algorithm', value: 'MD5', type: 'string' },
        { key: 'username', value: '', type: 'string' },
        { key: 'password', value: '', type: 'string' },
      ],
    })
    expect(serializeAuth({ ...emptyAuth(), kind: 'awsv4' })).toEqual({
      type: 'awsv4',
      awsv4: [
        { key: 'accessKey', value: '', type: 'string' },
        { key: 'secretKey', value: '', type: 'string' },
      ],
    })
    const v20 = parseAuth({ type: 'awsv4', awsv4: { accessKey: 'a', secretKey: 's', addAuthDataToQuery: 'true' } })
    expect(v20.awsv4).toMatchObject({ accessKey: 'a', secretKey: 's', addAuthDataToQuery: true })
  })

  it('a draft kept by an older Slinger (no digest / awsv4 objects) still serialises', () => {
    const old = { ...newDraft({ url: base.url }), auth: { kind: 'digest' } as unknown as AuthDraft } as RequestDraft
    expect(JSON.parse(serializeDraft(upgradeDraft(old)).documentJson).auth.type).toBe('digest')
    const aws = { ...old, auth: { kind: 'awsv4' } as unknown as AuthDraft }
    expect(prepareRequest(aws, { workspaceId: 'w', scope: makeScope(null, []) })).toMatchObject({ ok: true })
  })
})

// ---------------------------------------------------------------------------

const scope = makeScope('Dev', [
  { key: 'digestPassword', value: null, secret: true, id: 'v1' },
  { key: 'awsSecret', value: null, secret: true, id: 'v2' },
  { key: 'awsSession', value: null, secret: true, id: 'v3' },
  { key: 'region', value: 'eu-north-1', secret: false },
])
const secrets = new Map([
  ['digestPassword', 'Circle Of Life'],
  ['awsSecret', 'wJalrXUtnFEMI'],
  ['awsSession', 'FQoGZXIvYXdz'],
])
const draftWith = (auth: unknown): RequestDraft => parseDocument({ ...base, documentJson: docWith(auth) })

describe('prepare: secrets resolved just in time', () => {
  it('Digest: the secret password is needed, resolved for main and never in the history URL', () => {
    const d = draftWith(DIGEST_POSTMAN)
    expect(secretsNeeded(d, scope).map((v) => v.key)).toEqual(['digestPassword'])
    expect(prepareRequest(d, { workspaceId: 'w', scope })).toMatchObject({ ok: false })
    const res = prepareRequest(d, { workspaceId: 'w', scope, secrets })
    if (!res.ok) throw new Error(res.error)
    expect(res.input.auth).toEqual({
      kind: 'digest',
      digest: {
        username: 'Mufasa',
        password: 'Circle Of Life',
        realm: 'testrealm@host.com',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        algorithm: 'MD5',
        qop: 'auth',
        nonceCount: '00000001',
        clientNonce: '0a4f113b',
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
        disableRetryRequest: true,
      },
    })
    expect(JSON.stringify(res.input.historyUrl)).not.toContain('Circle')
  })

  it('AWS: secret key and session token resolved; region from a variable; query signing warns', () => {
    const auth = { ...AWS_POSTMAN, awsv4: AWS_POSTMAN.awsv4.map((e) => (e.key === 'region' ? { ...e, value: '{{region}}' } : e.key === 'addAuthDataToQuery' ? { ...e, value: true } : e)) }
    const d = draftWith(auth)
    expect(secretsNeeded(d, scope).map((v) => v.key).sort()).toEqual(['awsSecret', 'awsSession'])
    const res = prepareRequest(d, { workspaceId: 'w', scope, secrets })
    if (!res.ok) throw new Error(res.error)
    expect(res.input.auth).toEqual({
      kind: 'awsv4',
      awsv4: { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI', region: 'eu-north-1', service: 's3', sessionToken: 'FQoGZXIvYXdz' },
    })
    expect(res.warnings.join(' ')).toMatch(/query is not supported/)
  })

  it('MCP requests refuse both (no per-exchange hook in the MCP transport)', () => {
    const m = newMcpRequestDraft('M')
    const res = prepareMcp({ ...m, url: 'https://mcp.test/mcp', auth: parseAuth(DIGEST_POSTMAN) }, { workspaceId: 'w', scope, secrets })
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/Digest auth is not supported for MCP requests/) })
  })
})

describe('inheritance, scripts, versions, auto headers', () => {
  const chain = (folderAuth: unknown, collectionAuth: unknown) => ({
    collection: { id: 'c', name: 'Col', authJson: JSON.stringify(collectionAuth) },
    folders: [{ id: 'f', name: 'S3', parentFolderId: null, authJson: folderAuth ? JSON.stringify(folderAuth) : null }],
    folderId: 'f',
  })

  it("a request set to inherit uses the folder's AWS or the collection's Digest auth", () => {
    const viaFolder = resolveEffectiveAuth(emptyAuth(), chain(AWS_POSTMAN, DIGEST_POSTMAN))
    expect(viaFolder).toMatchObject({ inherited: true, source: { kind: 'folder', name: 'S3' }, auth: { kind: 'awsv4' } })
    expect(viaFolder.auth.awsv4?.service).toBe('s3')
    const viaCollection = resolveEffectiveAuth(emptyAuth(), chain(null, DIGEST_POSTMAN))
    expect(viaCollection).toMatchObject({ source: { kind: 'collection' }, auth: { kind: 'digest' } })
  })

  it('pm.request.auth masks the literal password / secret key / session token', () => {
    const literal = parseAuth({ type: 'awsv4', awsv4: [{ key: 'accessKey', value: 'AK' }, { key: 'secretKey', value: 'literal-secret' }, { key: 'sessionToken', value: 'literal-token' }] })
    const view = scriptAuthView(literal)!
    expect(view.type).toBe('awsv4')
    expect(JSON.stringify(view)).not.toContain('literal-')
    const digest = scriptAuthView(parseAuth({ type: 'digest', digest: [{ key: 'username', value: 'u' }, { key: 'password', value: 'pw-literal' }] }))!
    expect(JSON.stringify(digest)).not.toContain('pw-literal')
    expect(digest.params.find((p) => p.key === 'username')?.value).toBe('u')
  })

  it('version diffs list the stored parameters', () => {
    const r = renderVersion({ ...base, documentJson: docWith(DIGEST_POSTMAN) })
    expect(r.auth).toContain('digest')
    expect(r.auth).toContain('realm: testrealm@host.com')
    expect(renderVersion({ ...base, documentJson: docWith(AWS_POSTMAN) }).auth).toContain('service: s3')
  })

  it('the Headers tab announces the computed Authorization', () => {
    expect(autoHeaders(draftWith(DIGEST_POSTMAN)).find((h) => h.key === 'Authorization')?.source).toBe('Authorization tab (Digest)')
    expect(autoHeaders(draftWith(AWS_POSTMAN)).find((h) => h.key === 'Authorization')?.value).toMatch(/^AWS4-HMAC-SHA256/)
  })
})

// ---------------------------------------------------------------------------

const input = (auth: HttpRequestInput['auth'], over: Partial<HttpRequestInput> = {}): HttpRequestInput => ({
  method: 'GET',
  url: 'http://api.test/items',
  headers: [],
  auth,
  body: { mode: 'none' },
  workspaceId: 'w',
  ...over,
})
const DIGEST = { kind: 'digest' as const, digest: { username: 'alice', password: "p'w" } }
const AWS = { kind: 'awsv4' as const, awsv4: { accessKey: 'AKID', secretKey: 'SECRET', region: '', service: 's3', sessionToken: 'TOKEN' } }

describe('code snippets', () => {
  it('curl: --digest -u and --aws-sigv4 with the session token header', () => {
    expect(generateSnippet('curl', input(DIGEST))).toBe("curl -L 'http://api.test/items' \\\n  --digest -u 'alice:p'\\''w'")
    expect(generateSnippet('curl', input(AWS))).toBe(
      "curl -L 'http://api.test/items' \\\n  --aws-sigv4 'aws:amz:us-east-1:s3' -u 'AKID:SECRET' \\\n  -H 'x-amz-security-token: TOKEN'",
    )
  })

  it('Python: HTTPDigestAuth and requests-aws4auth', () => {
    const digest = generateSnippet('python', input(DIGEST))
    expect(digest).toContain('from requests.auth import HTTPDigestAuth')
    expect(digest).toContain("auth = HTTPDigestAuth('alice', 'p\\'w')")
    expect(digest).toContain("response = requests.request('GET', url, auth=auth)")
    const aws = generateSnippet('python', input(AWS))
    expect(aws).toContain('from requests_aws4auth import AWS4Auth  # pip install requests-aws4auth')
    expect(aws).toContain("auth = AWS4Auth('AKID', 'SECRET', 'us-east-1', 's3', session_token='TOKEN')")
  })

  it('PHP: CURLAUTH_DIGEST; AWS only as a comment', () => {
    const digest = generateSnippet('php', input(DIGEST))
    expect(digest).toContain('CURLOPT_HTTPAUTH => CURLAUTH_DIGEST,')
    expect(digest).toContain("CURLOPT_USERPWD => 'alice:p\\'w',")
    const aws = generateSnippet('php', input(AWS))
    expect(aws).toContain('// AWS Signature Version 4 (region us-east-1, service s3): sign this request')
    expect(aws).not.toContain('SECRET')
  })

  it('PowerShell: the snippet answers the Digest challenge itself (5.1 and 7; .NET Framework drops the query from uri=)', () => {
    const ps = generateSnippet('powershell', input(DIGEST, { url: 'http://api.test/items?page=2' }))
    expect(ps).toContain('function Get-DigestChallenge($Response) {')
    expect(ps).toContain('function New-DigestAuthorization(')
    expect(ps).not.toContain('-Credential')
    expect(ps).not.toContain('AllowUnencryptedAuthentication')
    expect(ps).not.toContain('${')
    expect(ps).toContain("$digestUser = 'alice'")
    expect(ps).toContain("$digestPassword = 'p''w'")
    expect(ps).toMatch(/Invoke-WebRequest .*-Headers \$headers/)
    expect(ps).toContain("$headers['Authorization'] = New-DigestAuthorization $challenge 'GET' ([uri]'http://api.test/items?page=2').PathAndQuery $null $digestUser $digestPassword")
    // raw bodies are hashed as sent (auth-int)
    expect(generateSnippet('powershell', input(DIGEST, { method: 'POST', body: { mode: 'raw', raw: { content: '{}', contentType: 'application/json' } } }))).toMatch(
      /New-DigestAuthorization \$challenge 'POST' \(\[uri\]'http:\/\/api\.test\/items'\)\.PathAndQuery \$body /,
    )
    const form = generateSnippet(
      'powershell',
      input(DIGEST, { method: 'POST', strictSSL: false, body: { mode: 'formData', formData: [{ key: 'a', value: '1', type: 'text', enabled: true }] } } as Partial<HttpRequestInput>),
    )
    expect(form).toContain('$formBytes = $form.ReadAsByteArrayAsync().GetAwaiter().GetResult()')
    expect(form).toContain('function New-Request {')
    expect(form).toContain('$request.Content = New-Object System.Net.Http.ByteArrayContent -ArgumentList (,$formBytes)')
    expect(form).toContain("$authorization = New-DigestAuthorization $challenge 'POST' $request.RequestUri.PathAndQuery $formBytes 'alice' 'p''w'")
    // L's certificate setup stays on the same handler
    expect(form).toContain('$handler.ServerCertificateCustomValidationCallback')
    expect(form).not.toContain('Credentials')
    const aws = generateSnippet('powershell', input(AWS))
    expect(aws).toContain('# AWS Signature Version 4')
    expect(aws).not.toContain('Digest')
  })

  it('fetch, axios and Go say the auth must be computed and emit no fake header', () => {
    for (const lang of ['fetch', 'axios', 'go'] as const) {
      const digest = generateSnippet(lang, input(DIGEST))
      expect(digest.startsWith('// Digest auth:')).toBe(true)
      expect(digest).not.toMatch(/["']Authorization["']/)
      expect(digest).not.toContain("p'w")
      const aws = generateSnippet(lang, input(AWS))
      expect(aws.startsWith('// AWS Signature Version 4')).toBe(true)
      expect(aws).not.toContain('SECRET')
    }
    expect(generateSnippet('go', input(AWS))).toContain('aws-sdk-go-v2/aws/signer/v4')
  })

  it(".http: Digest in the clients' own form; AWS as a comment after the title", () => {
    expect(generateSnippet('http', input(DIGEST, { requestName: 'D' }))).toBe("### D\nGET http://api.test/items\nAuthorization: Digest alice p'w\n")
    const aws = generateSnippet('http', input(AWS, { requestName: 'A' })).split('\n')
    expect(aws[0]).toBe('### A')
    expect(aws[1]).toMatch(/^# AWS Signature Version 4/)
    expect(aws).toContain('GET http://api.test/items')
  })
})

describe('cURL import', () => {
  it('--digest -u becomes Digest auth; --aws-sigv4 -u becomes AWS Signature with the token header as session token', () => {
    const d = parseCurl("curl --digest -u 'alice:secret' https://api.test/x")
    if (!d.ok) throw new Error(d.error)
    expect(curlToDraft(d.requests[0]!).auth).toMatchObject({ kind: 'digest', digest: { username: 'alice', password: 'secret', algorithm: 'MD5' } })
    const a = parseCurl("curl --aws-sigv4 'aws:amz:eu-west-1:s3' -u AKID:SEC -H 'x-amz-security-token: TOK' -H 'X-Other: 1' https://b.s3.amazonaws.com/k")
    if (!a.ok) throw new Error(a.error)
    const draft = curlToDraft(a.requests[0]!)
    expect(draft.auth).toMatchObject({ kind: 'awsv4', awsv4: { accessKey: 'AKID', secretKey: 'SEC', region: 'eu-west-1', service: 's3', sessionToken: 'TOK' } })
    expect(draft.headers.filter((h) => h.key).map((h) => h.key)).toEqual(['X-Other'])
    expect(a.requests[0]!.warnings).toEqual([])
  })

  it('a generated curl snippet imports back to the same auth', () => {
    for (const auth of [DIGEST, AWS]) {
      const parsed = parseCurl(generateSnippet('curl', input(auth)))
      if (!parsed.ok) throw new Error(parsed.error)
      const draft = curlToDraft(parsed.requests[0]!)
      expect(draft.auth.kind).toBe(auth.kind)
      if (auth.kind === 'awsv4') expect(draft.auth.awsv4).toMatchObject({ accessKey: 'AKID', secretKey: 'SECRET', region: 'us-east-1', service: 's3', sessionToken: 'TOKEN' })
      else expect(draft.auth.digest).toMatchObject({ username: 'alice', password: "p'w" })
    }
  })
})
