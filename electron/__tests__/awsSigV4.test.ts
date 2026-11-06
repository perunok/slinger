/**
 * AWS Signature Version 4 (0.30): vectors of the official SigV4 test suite (awslabs/aws-c-auth
 * tests/aws-signing-test-suite/v4, the successor of the aws-sig-v4-test-suite), then the executor against a real server
 * that checks the signature of what it received.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AwsV4AuthInput, HttpRequestInput } from '../../shared/types'
import { amzDate, canonicalQuery, canonicalUri, EMPTY_SHA256, signHop, signV4, uriEncode, type SignInput } from '../services/awsSigV4'
import { executeHttp, scrubRequestValues } from '../services/httpExecutor'
import { baseHttp } from './helpers'

const SUITE = {
  accessKey: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z',
}
const HOST: [string, string] = ['Host', 'example.amazonaws.com']
const DATE: [string, string] = ['X-Amz-Date', '20150830T123600Z']
const SCOPE = 'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request'

interface Vector {
  name: string
  input: Omit<SignInput, keyof typeof SUITE>
  canonicalRequest: string
  stringToSign: string
  authorization: string
}

/** Copied from the suite's request.txt / header-canonical-request.txt / header-string-to-sign.txt / header-signed-request.txt. */
const VECTORS: Vector[] = [
  {
    name: 'get-vanilla',
    input: { method: 'GET', path: '/', query: '', headers: [HOST, DATE], payloadHash: EMPTY_SHA256 },
    canonicalRequest: `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31`,
  },
  {
    name: 'post-vanilla',
    input: { method: 'POST', path: '/', query: '', headers: [HOST, DATE], payloadHash: EMPTY_SHA256 },
    canonicalRequest: `POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n553f88c9e4d10fc9e109e2aeb65f030801b70c2f6468faca261d401ae622fc87',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b`,
  },
  {
    name: 'get-vanilla-query-order-key-case',
    input: { method: 'GET', path: '/', query: '?Param2=value2&Param1=value1', headers: [HOST, DATE], payloadHash: EMPTY_SHA256 },
    canonicalRequest: `GET\n/\nParam1=value1&Param2=value2\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500`,
  },
  {
    name: 'get-vanilla-query-unreserved',
    input: {
      method: 'GET',
      path: '/',
      query: '-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
      headers: [HOST, DATE],
      payloadHash: EMPTY_SHA256,
    },
    canonicalRequest:
      'GET\n/\n-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n' +
      `host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nc30d4703d9f799439be92736156d47ccfb2d879ddf56f5befa6d1d6aab979177',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197`,
  },
  {
    name: 'post-vanilla-query',
    input: { method: 'POST', path: '/', query: 'Param1=value1', headers: [HOST, DATE], payloadHash: EMPTY_SHA256 },
    canonicalRequest: `POST\n/\nParam1=value1\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n9d659678c1756bb3113e2ce898845a0a79dbbc57b740555917687f1b3340fbbd',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11`,
  },
  {
    name: 'get-header-value-trim',
    input: { method: 'GET', path: '/', query: '', headers: [HOST, ['My-Header1', ' value1'], ['My-Header2', ' "a   b   c"'], DATE], payloadHash: EMPTY_SHA256 },
    canonicalRequest:
      'GET\n/\n\nhost:example.amazonaws.com\nmy-header1:value1\nmy-header2:"a b c"\nx-amz-date:20150830T123600Z\n\n' +
      `host;my-header1;my-header2;x-amz-date\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\na726db9b0df21c14f559d0a978e563112acb1b9e05476f0a6a1c7d68f28605c7',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;my-header1;my-header2;x-amz-date, Signature=acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736`,
  },
  {
    // The suite's request line is the raw `/ሴ`: encoded once (no double encoding of an already-encoded wire path).
    name: 'get-utf8',
    input: { method: 'GET', path: '/ሴ', query: '', headers: [HOST, DATE], payloadHash: EMPTY_SHA256, uri: { doubleEncode: false, normalize: true } },
    canonicalRequest: `GET\n/%E1%88%B4\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n2a0a97d02205e45ce2e994789806b19270cfbbb0921b278ccf58f5249ac42102',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date, Signature=8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85`,
  },
  {
    name: 'post-x-www-form-urlencoded (sign_body: content headers and x-amz-content-sha256 signed)',
    input: {
      method: 'POST',
      path: '/',
      query: '',
      headers: [
        ['Content-Type', 'application/x-www-form-urlencoded'],
        HOST,
        ['Content-Length', '13'],
        DATE,
        ['x-amz-content-sha256', '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e'],
      ],
      payloadHash: createHash('sha256').update('Param1=value1').digest('hex'),
    },
    canonicalRequest:
      'POST\n/\n\ncontent-length:13\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\n' +
      'x-amz-content-sha256:9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e\nx-amz-date:20150830T123600Z\n\n' +
      'content-length;content-type;host;x-amz-content-sha256;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nb1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b`,
  },
  {
    name: 'post-sts-header-before (session token signed)',
    input: {
      method: 'POST',
      path: '/',
      query: '',
      headers: [
        HOST,
        DATE,
        [
          'X-Amz-Security-Token',
          'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==',
        ],
      ],
      payloadHash: EMPTY_SHA256,
    },
    canonicalRequest:
      'POST\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n' +
      'x-amz-security-token:AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==\n\n' +
      `host;x-amz-date;x-amz-security-token\n${EMPTY_SHA256}`,
    stringToSign: 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nc237e1b440d4c63c32ca95b5b99481081cb7b13c7e40434868e71567c1a882f6',
    authorization: `AWS4-HMAC-SHA256 ${SCOPE}, SignedHeaders=host;x-amz-date;x-amz-security-token, Signature=85d96828115b5dc0cfc3bd16ad9e210dd772bbebba041836c64533a82be05ead`,
  },
]

describe('SigV4 test suite vectors', () => {
  for (const v of VECTORS) {
    it(v.name, () => {
      const r = signV4({ ...SUITE, ...v.input })
      expect(r.canonicalRequest).toBe(v.canonicalRequest)
      expect(r.stringToSign).toBe(v.stringToSign)
      expect(r.authorization).toBe(v.authorization)
    })
  }
})

describe('SigV4 building blocks', () => {
  it('URI-encodes per AWS (unreserved only)', () => {
    expect(uriEncode("a b!*'()~é/")).toBe('a%20b%21%2A%27%28%29~%C3%A9%2F')
  })

  it('canonical URI: S3 encodes the key once; other services normalise and encode the wire path again', () => {
    const s3 = { doubleEncode: false, normalize: false }
    const other = { doubleEncode: true, normalize: true }
    expect(canonicalUri('/my%20bucket/a%2Bb.txt', s3)).toBe('/my%20bucket/a%2Bb.txt')
    expect(canonicalUri('/a/./b/../c//d', s3)).toBe('/a/./b/../c//d')
    expect(canonicalUri('/a/./b/../c//d/', other)).toBe('/a/c/d/')
    expect(canonicalUri('/my%20doc', other)).toBe('/my%2520doc')
    expect(canonicalUri('', other)).toBe('/')
  })

  it('canonical query: decoded, encoded, sorted by name then value; empty values kept', () => {
    expect(canonicalQuery('?b=2&a=z&a=y&c&d=%7e+x')).toBe('a=y&a=z&b=2&c=&d=~%2Bx')
    expect(canonicalQuery('')).toBe('')
  })

  it('formats x-amz-date', () => {
    expect(amzDate(new Date('2015-08-30T12:36:00.123Z'))).toBe('20150830T123600Z')
  })

  it('signHop replaces auth headers the request set and skips unsigned ones', () => {
    const headers = new Headers({ Authorization: 'old', 'X-Amz-Date': 'old', 'User-Agent': 'Slinger', 'Content-Type': 'text/plain' })
    const auth: AwsV4AuthInput = { accessKey: 'AK', secretKey: 'SK', region: '', service: 's3', sessionToken: 'TOK' }
    const r = signHop(auth, 'PUT', new URL('https://bucket.s3.amazonaws.com/key%20one?x=1'), headers, Buffer.from('hi'), new Date('2015-08-30T12:36:00Z'))
    expect(r.signedHeaders).toBe('content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token')
    expect(headers.get('x-amz-content-sha256')).toBe(createHash('sha256').update('hi').digest('hex'))
    expect(headers.get('x-amz-date')).toBe('20150830T123600Z')
    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20150830\/us-east-1\/s3\/aws4_request, /)
    expect(r.canonicalRequest.split('\n')[1]).toBe('/key%20one')
  })
})

// ---- executor against a server that verifies what it received ---------------------------------------------------------

interface Seen {
  url: string
  method: string
  headers: IncomingMessage['headers']
  rawHeaders: string[]
  body: Buffer
}

const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'

/** Recomputes the signature from the request as received (its SignedHeaders, wire path and body). */
function verify(s: Seen, service: string): boolean {
  const auth = String(s.headers.authorization ?? '')
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth)
  if (!m) return false
  const signed = m[5]!.split(';')
  const headers: Array<[string, string]> = []
  for (let i = 0; i < s.rawHeaders.length; i += 2) if (signed.includes(s.rawHeaders[i]!.toLowerCase())) headers.push([s.rawHeaders[i]!, s.rawHeaders[i + 1]!])
  const url = new URL(s.url, 'http://x')
  const r = signV4({
    method: s.method,
    path: url.pathname,
    query: url.search,
    headers,
    payloadHash: createHash('sha256').update(s.body).digest('hex'),
    accessKey: m[1]!,
    secretKey: SECRET,
    region: m[3]!,
    service,
    amzDate: String(s.headers['x-amz-date']),
  })
  return r.signature === m[6] && m[4] === service && headers.length === signed.length
}

async function startServer() {
  const seen: Seen[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) })
      const url = new URL(req.url ?? '/', 'http://x')
      const to = url.searchParams.get('to')
      if (url.pathname.startsWith('/redirect') && to) {
        res.writeHead(307, { Location: to })
        return void res.end()
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(r)) }
}

let a: Awaited<ReturnType<typeof startServer>>
let b: Awaited<ReturnType<typeof startServer>>
beforeAll(async () => {
  a = await startServer()
  b = await startServer()
})
afterAll(async () => {
  await a.close()
  await b.close()
})
beforeEach(() => {
  a.seen.length = 0
  b.seen.length = 0
})

const aws = (over: Partial<AwsV4AuthInput> = {}): HttpRequestInput['auth'] => ({
  kind: 'awsv4',
  awsv4: { accessKey: 'AKIDEXAMPLE', secretKey: SECRET, region: 'eu-west-1', service: 'execute-api', sessionToken: '', ...over },
})
const req = (over: Partial<HttpRequestInput> & { url: string }): HttpRequestInput => baseHttp('', { auth: aws(), ...over })

describe('executor: AWS SigV4 on the final request', () => {
  it('signs the request as received (headers, query, path, body)', async () => {
    const res = await executeHttp(
      req({
        method: 'POST',
        url: `${a.base}/a%20b/c?z=1&a=2`,
        headers: [{ key: 'X-Custom', value: '  spaced   value ' }],
        body: { mode: 'raw', raw: { content: '{"x":1}', contentType: 'application/json' } },
        cookies: 'jar',
      }),
    )
    expect(res.status).toBe(200)
    expect(res.authNote).toBe('AWS Signature Version 4 (eu-west-1, execute-api)')
    const s = a.seen[0]!
    expect(verify(s, 'execute-api')).toBe(true)
    expect(s.headers.authorization).toMatch(/SignedHeaders=content-type;host;x-amz-date;x-custom,/)
    expect(s.headers['x-amz-content-sha256']).toBeUndefined()
  })

  it('S3: x-amz-content-sha256 of the body, single-encoded path; session token signed', async () => {
    const res = await executeHttp(
      req({ method: 'PUT', url: `${a.base}/bucket/key%20one.txt`, auth: aws({ service: 's3', sessionToken: 'TOKEN' }), body: { mode: 'raw', raw: { content: 'data', contentType: 'text/plain' } } }),
    )
    expect(res.status).toBe(200)
    const s = a.seen[0]!
    expect(s.headers['x-amz-content-sha256']).toBe(createHash('sha256').update('data').digest('hex'))
    expect(s.headers['x-amz-security-token']).toBe('TOKEN')
    expect(s.headers.authorization).toMatch(/SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token,/)
    expect(verify(s, 's3')).toBe(true)
  })

  it('multipart bodies are signed as the bytes sent', async () => {
    const res = await executeHttp(req({ method: 'POST', url: `${a.base}/form`, body: { mode: 'formData', formData: [{ key: 'k', value: 'v', type: 'text', enabled: true }] } }))
    expect(res.status).toBe(200)
    expect(String(a.seen[0]!.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/)
    expect(verify(a.seen[0]!, 'execute-api')).toBe(true)
  })

  it('re-signs each redirect hop that keeps auth; a cross-origin hop drops it', async () => {
    let res = await executeHttp(req({ url: `${a.base}/redirect?to=${encodeURIComponent('/final?q=1')}` }))
    expect(res.status).toBe(200)
    expect(a.seen).toHaveLength(2)
    expect(a.seen.map((s) => verify(s, 'execute-api'))).toEqual([true, true])
    expect(a.seen[0]!.headers.authorization).not.toBe(a.seen[1]!.headers.authorization)
    expect(res.authNote).toMatch(/signed again for the redirect/)

    res = await executeHttp(req({ url: `${a.base}/redirect?to=${encodeURIComponent(`${b.base}/x`)}` }))
    expect(res.status).toBe(200)
    expect(b.seen[0]!.headers.authorization).toBeUndefined()
    expect(b.seen[0]!.headers['x-amz-date']).toBeUndefined()

    b.seen.length = 0
    res = await executeHttp(req({ url: `${a.base}/redirect?to=${encodeURIComponent(`${b.base}/x`)}`, followAuthorizationHeader: true }))
    expect(verify(b.seen[0]!, 'execute-api')).toBe(true)
  })

  it('rejects missing credentials and scrubs the secret key from messages', async () => {
    await expect(executeHttp(req({ url: `${a.base}/`, auth: aws({ secretKey: '' }) }))).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(executeHttp(req({ url: `${a.base}/`, auth: aws({ region: 'eu west' }) }))).rejects.toMatchObject({ code: 'invalid_input' })
    const input = req({ url: `${a.base}/`, auth: aws({ sessionToken: 'session-token-value' }) })
    expect(scrubRequestValues(`x ${SECRET} session-token-value`, input)).toBe('x ••• •••')
  })
})
