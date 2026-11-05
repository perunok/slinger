/**
 * AWS Signature Version 4 (header signing), implemented with node:crypto, no SDK
 * (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html).
 *
 * The executor signs the final request of each hop, after every header (cookies included) and the body are known
 * (httpExecutor.ts). Every header the request sends is signed except the ones proxies or the HTTP stack may change
 * (the list of the `aws4` library Postman uses), plus `host`, `x-amz-date` and, with a session token,
 * `x-amz-security-token`. S3 also gets `x-amz-content-sha256` (the body's SHA-256).
 *
 * URI encoding: S3 encodes the object key once and keeps the path as it is; every other service normalises the path
 * (`.`/`..`, repeated slashes) and URI-encodes the path that goes on the wire again ("double encoding").
 */
import { createHash, createHmac } from 'node:crypto'
import type { AwsV4AuthInput } from '../../shared/types'

export const AWS_DEFAULT_REGION = 'us-east-1'
/** Postman's default service (API Gateway). */
export const AWS_DEFAULT_SERVICE = 'execute-api'
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Headers never signed (they may legitimately change on the way, or are set by the HTTP stack). */
const UNSIGNED_HEADERS = new Set(['authorization', 'connection', 'x-amzn-trace-id', 'user-agent', 'expect', 'presigned-expires', 'range'])

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest()

/** RFC 3986 URI encoding as AWS defines it: everything but A-Z a-z 0-9 - . _ ~ is percent-encoded (UTF-8). */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** Removes `.` and `..` segments and repeated slashes (RFC 3986 section 5.2.4); a trailing slash is kept. */
function normalizePath(path: string): string {
  const out: string[] = []
  const segments = path.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  const trailing = path.length > 1 && /\/\.{0,2}$/.test(path) && out.length > 0
  return `/${out.join('/')}${trailing ? '/' : ''}`
}

export interface CanonicalUriOptions {
  /** Encode the wire path again (all services but S3). */
  doubleEncode: boolean
  /** Resolve `.`/`..` and repeated slashes (all services but S3). */
  normalize: boolean
}

export const uriOptionsFor = (service: string): CanonicalUriOptions => {
  const s3 = service.toLowerCase() === 's3'
  return { doubleEncode: !s3, normalize: !s3 }
}

/**
 * The canonical URI of a path. `path` is as it goes on the wire (percent-encoded, as `URL.pathname` gives it); a raw,
 * unencoded path (the AWS test suite's `/ሴ`) is encoded once with `doubleEncode` off.
 */
export function canonicalUri(path: string, opts: CanonicalUriOptions): string {
  let p = path || '/'
  if (opts.normalize) p = normalizePath(p)
  return p
    .split('/')
    .map((seg) => (opts.doubleEncode ? uriEncode(seg) : uriEncode(safeDecode(seg))))
    .join('/')
}

/** The canonical query string: every name and value decoded, URI-encoded, then sorted by name and value. */
export function canonicalQuery(search: string): string {
  const q = search.startsWith('?') ? search.slice(1) : search
  if (!q) return ''
  const pairs = q
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=')
      const k = eq < 0 ? p : p.slice(0, eq)
      const v = eq < 0 ? '' : p.slice(eq + 1)
      return [uriEncode(safeDecode(k)), uriEncode(safeDecode(v))] as const
    })
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

/** Header value as signed: trimmed, runs of spaces collapsed to one. */
const canonicalHeaderValue = (v: string) => v.trim().replace(/\s+/g, ' ')

export interface SignInput {
  method: string
  /** Wire path (percent-encoded) and query string (with or without `?`). */
  path: string
  query: string
  /** The headers to sign, `host` included (any case; repeated names are joined with `,`). */
  headers: ReadonlyArray<readonly [string, string]>
  /** Hex SHA-256 of the payload. */
  payloadHash: string
  accessKey: string
  secretKey: string
  region: string
  service: string
  /** `YYYYMMDDTHHMMSSZ` (also sent as `x-amz-date`, which must be among `headers`). */
  amzDate: string
  uri?: CanonicalUriOptions
}

export interface SignResult {
  canonicalRequest: string
  stringToSign: string
  signedHeaders: string
  signature: string
  authorization: string
}

/** Signs a request whose headers are final (the core of SigV4; used by the test-suite vectors directly). */
export function signV4(i: SignInput): SignResult {
  const byName = new Map<string, string[]>()
  for (const [name, value] of i.headers) {
    const n = name.toLowerCase().trim()
    const list = byName.get(n) ?? []
    list.push(canonicalHeaderValue(value))
    byName.set(n, list)
  }
  const names = [...byName.keys()].sort()
  const canonicalHeaders = names.map((n) => `${n}:${byName.get(n)!.join(',')}\n`).join('')
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    i.method.toUpperCase(),
    canonicalUri(i.path, i.uri ?? uriOptionsFor(i.service)),
    canonicalQuery(i.query),
    canonicalHeaders,
    signedHeaders,
    i.payloadHash,
  ].join('\n')
  const date = i.amzDate.slice(0, 8)
  const scope = `${date}/${i.region}/${i.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', i.amzDate, scope, sha256(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${i.secretKey}`, date)
  const kRegion = hmac(kDate, i.region)
  const kService = hmac(kRegion, i.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  return {
    canonicalRequest,
    stringToSign,
    signedHeaders,
    signature,
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/** `20150830T123600Z` */
export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

const AUTH_HEADERS = ['authorization', 'x-amz-date', 'x-amz-security-token', 'x-amz-content-sha256']

/**
 * Signs one hop in place: removes any Authorization / X-Amz-* auth header the request set (Postman does too), adds
 * `X-Amz-Date`, `X-Amz-Security-Token` (with a session token), `X-Amz-Content-Sha256` (S3) and `Authorization`.
 */
export function signHop(auth: AwsV4AuthInput, method: string, url: URL, headers: Headers, body: Buffer | undefined, now = new Date()): SignResult {
  const region = auth.region.trim() || AWS_DEFAULT_REGION
  const service = auth.service.trim() || AWS_DEFAULT_SERVICE
  for (const h of AUTH_HEADERS) headers.delete(h)
  const date = amzDate(now)
  headers.set('X-Amz-Date', date)
  if (auth.sessionToken) headers.set('X-Amz-Security-Token', auth.sessionToken)
  const payloadHash = body && body.length > 0 ? sha256(body) : EMPTY_SHA256
  if (service.toLowerCase() === 's3') headers.set('X-Amz-Content-Sha256', payloadHash)
  const signed: Array<[string, string]> = []
  if (!headers.has('host')) signed.push(['host', url.host])
  headers.forEach((value, name) => {
    if (!UNSIGNED_HEADERS.has(name)) signed.push([name, value])
  })
  const result = signV4({
    method,
    path: url.pathname,
    query: url.search,
    headers: signed,
    payloadHash,
    accessKey: auth.accessKey,
    secretKey: auth.secretKey,
    region,
    service,
    amzDate: date,
  })
  headers.set('Authorization', result.authorization)
  return result
}
