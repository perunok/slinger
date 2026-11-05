/**
 * Code snippet generation from an already-resolved HttpRequestInput.
 * Pure string builders, one per target language. `{{vars}}` are left verbatim.
 *
 * The request Settings tab (0.30) is honoured where the language can express it (`SnippetSettings`): SSL verification off
 * for the request (`strictSSL: false`; the app-wide Settings > Network switch is not the snippet's business), redirects
 * (follow or not, the maximum, keeping the method or Authorization), and the cookie jar switch for `.http`. Following
 * redirects is Slinger's default, so clients that do not follow by default (curl, PHP cURL) get the option that makes them.
 * Cookies from the workspace's jar are never put into a snippet (they are credentials, kept out of anything pasted); a
 * Cookie header the request sets itself is an ordinary header and stays.
 *
 * MCP requests get one snippet instead: an MCP Inspector CLI command line (`mcpInspectorSnippet`, input built from the
 * draft by `prepareMcpSnippet`).
 */

import type { HttpRequestInput, McpClientTransport, McpOperationName } from '../../shared/types'
import { prepareRequest, resolveJsonTemplates, templateResolver, type PrepareContext } from './prepare'
import { dataRows } from './kv'
import type { RequestDraft } from './request'
import type { EditorLanguage } from './editorLanguage'
import { textToBase64 } from './response'
import { mapOutsideTokens } from './urlParams'

/** Stands in for an OAuth 2.0 access token in generated code (the real token never leaves the keychain for this). */
export const OAUTH2_TOKEN_PLACEHOLDER = '<access token>'

/**
 * The OAuth 2.0 token in `.http` output: a variable rather than OAUTH2_TOKEN_PLACEHOLDER, since `.http` clients resolve
 * `{{name}}` themselves (e.g. from http-client.private.env.json) and a space would end the request line's URL.
 */
export const HTTP_OAUTH2_TOKEN_VARIABLE = 'oauth2_access_token'

export type SnippetLang = 'curl' | 'fetch' | 'axios' | 'python' | 'go' | 'php' | 'powershell' | 'http'

/** `fileExtension`: the snippet can also be saved as a file of that type. */
export const SNIPPET_LANGS: { id: SnippetLang; label: string; editorLanguage: EditorLanguage; fileExtension?: string }[] = [
  { id: 'curl', label: 'cURL', editorLanguage: 'shell' },
  { id: 'fetch', label: 'JavaScript (fetch)', editorLanguage: 'javascript' },
  { id: 'axios', label: 'JavaScript (axios)', editorLanguage: 'javascript' },
  { id: 'python', label: 'Python (requests)', editorLanguage: 'python' },
  { id: 'go', label: 'Go (net/http)', editorLanguage: 'go' },
  { id: 'php', label: 'PHP (cURL)', editorLanguage: 'php' },
  { id: 'powershell', label: 'PowerShell', editorLanguage: 'powershell' },
  { id: 'http', label: 'HTTP file (.http)', editorLanguage: 'http', fileExtension: '.http' },
]

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

type Pair = [string, string]

type Body =
  | { kind: 'none' }
  | { kind: 'raw'; content: string }
  | { kind: 'urlEncoded'; fields: Pair[] }
  | { kind: 'formData'; fields: { key: string; value: string; file: boolean }[] }
  | { kind: 'binary'; path: string }

/** The request settings a snippet reproduces (from HttpRequestInput; absent = Slinger's default). */
interface SnippetSettings {
  /** strictSSL === false: certificate verification off for this request. */
  insecure: boolean
  follow: boolean
  /** Set explicitly on the request (else each client keeps its own default). */
  maxRedirects: number | null
  keepMethod: boolean
  keepAuth: boolean
  noCookieJar: boolean
}

/**
 * ADDED (0.30) Auth a snippet cannot express as a fixed header: Digest answers the server's challenge, AWS Signature
 * signs the final request. Each generator uses its client's own support, or says in a comment that it must be computed.
 */
type ComputedAuth =
  | { kind: 'digest'; username: string; password: string }
  | { kind: 'awsv4'; accessKey: string; secretKey: string; region: string; service: string; sessionToken: string }

interface Prepared {
  method: string
  url: string
  headers: Pair[]
  body: Body
  settings: SnippetSettings
  computedAuth?: ComputedAuth
}

function snippetSettings(input: HttpRequestInput): SnippetSettings {
  const max = input.maxRedirects
  return {
    insecure: input.strictSSL === false,
    follow: input.followRedirects !== false,
    maxRedirects: typeof max === 'number' && Number.isFinite(max) && max >= 0 ? Math.trunc(max) : null,
    keepMethod: input.followOriginalHttpMethod === true,
    keepAuth: input.followAuthorizationHeader === true,
    noCookieJar: input.cookies === 'off',
  }
}

function hasHeader(headers: Pair[], name: string): boolean {
  const l = name.toLowerCase()
  return headers.some(([k]) => k.toLowerCase() === l)
}

/** Percent-encodes everything but `{{vars}}`. */
const encodeKeepingVars = (s: string) => mapOutsideTokens(s, encodeURIComponent)

const hasVariable = (s: string) => /\{\{[^{}]*\}\}/.test(s)

function appendQuery(url: string, key: string, value: string): string {
  const hash = url.indexOf('#')
  const base = hash === -1 ? url : url.slice(0, hash)
  const frag = hash === -1 ? '' : url.slice(hash)
  const sep = base.includes('?') ? (/[?&]$/.test(base) ? '' : '&') : '?'
  return `${base}${sep}${encodeKeepingVars(key)}=${encodeKeepingVars(value)}${frag}`
}

interface PrepareOptions {
  /** Stands in for the OAuth 2.0 access token (default OAUTH2_TOKEN_PLACEHOLDER). */
  oauth2Token?: string
  /**
   * Basic auth as `Basic <username> <password>` when either part holds a `{{variable}}`: base64 would freeze the
   * variable's name, while `.http` clients accept this form and encode it after resolving the variables.
   */
  plainBasicWithVariables?: boolean
}

function prepare(input: HttpRequestInput, opts: PrepareOptions = {}): Prepared {
  const method = (input.method || 'GET').trim().toUpperCase() || 'GET'
  let url = input.url ?? ''
  const headers: Pair[] = []
  for (const h of input.headers ?? []) {
    const k = (h?.key ?? '').trim()
    if (!k) continue
    headers.push([k, h.value ?? ''])
  }

  // Auth (an explicit user header of the same name wins).
  const auth = input.auth
  if (auth?.kind === 'basic' && auth.basic && !hasHeader(headers, 'Authorization')) {
    const { username, password } = auth.basic
    headers.push([
      'Authorization',
      opts.plainBasicWithVariables && hasVariable(username + password) ? `Basic ${username} ${password}` : `Basic ${textToBase64(`${username}:${password}`)}`,
    ])
  } else if (auth?.kind === 'bearer' && auth.bearer?.token && !hasHeader(headers, 'Authorization')) {
    headers.push(['Authorization', `Bearer ${auth.bearer.token}`])
  } else if (auth?.kind === 'oauth2' && auth.oauth2) {
    // The token stays in the keychain: snippets show a placeholder to paste it into.
    const prefix = auth.oauth2.headerPrefix.trim()
    const token = opts.oauth2Token ?? OAUTH2_TOKEN_PLACEHOLDER
    if (auth.oauth2.addTo === 'query') {
      const marked = appendQuery(url, 'access_token', '\u0000')
      const at = marked.lastIndexOf('access_token=%00')
      url = `${marked.slice(0, at)}access_token=${token}${marked.slice(at + 'access_token=%00'.length)}`
    } else if (!hasHeader(headers, 'Authorization')) headers.push(['Authorization', prefix ? `${prefix} ${token}` : token])
  } else if (auth?.kind === 'apiKey' && auth.apiKey?.key) {
    if (auth.apiKey.addTo === 'query') url = appendQuery(url, auth.apiKey.key, auth.apiKey.value)
    else if (!hasHeader(headers, auth.apiKey.key)) headers.push([auth.apiKey.key, auth.apiKey.value])
  }
  let computedAuth: ComputedAuth | undefined
  if (auth?.kind === 'digest' && auth.digest) computedAuth = { kind: 'digest', username: auth.digest.username, password: auth.digest.password }
  else if (auth?.kind === 'awsv4' && auth.awsv4) {
    const w = auth.awsv4
    computedAuth = {
      kind: 'awsv4',
      accessKey: w.accessKey,
      secretKey: w.secretKey,
      region: w.region.trim() || 'us-east-1',
      service: w.service.trim() || 'execute-api',
      sessionToken: w.sessionToken ?? '',
    }
  }

  const b = input.body
  let body: Body = { kind: 'none' }
  if (b?.mode === 'raw' && b.raw && b.raw.content !== '') {
    body = { kind: 'raw', content: b.raw.content }
    const ct = (b.raw.contentType ?? '').trim()
    if (ct && !hasHeader(headers, 'Content-Type')) headers.push(['Content-Type', ct])
  } else if (b?.mode === 'urlEncoded') {
    const fields = (b.urlEncoded ?? []).filter((f) => f.enabled && f.key).map((f): Pair => [f.key, f.value ?? ''])
    if (fields.length) {
      body = { kind: 'urlEncoded', fields }
      if (!hasHeader(headers, 'Content-Type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded'])
    }
  } else if (b?.mode === 'formData') {
    const fields = (b.formData ?? [])
      .filter((f) => f.enabled && f.key && (f.type !== 'file' || f.filePath))
      .map((f) => ({ key: f.key, value: f.type === 'file' ? (f.filePath as string) : (f.value ?? ''), file: f.type === 'file' }))
    if (fields.length) {
      body = { kind: 'formData', fields }
      // A multipart Content-Type without boundary would break the request; let the client set it.
      for (let i = headers.length - 1; i >= 0; i--) {
        if (headers[i][0].toLowerCase() === 'content-type' && !/boundary=/i.test(headers[i][1])) headers.splice(i, 1)
      }
    }
  } else if (b?.mode === 'binary' && b.binaryFilePath) {
    body = { kind: 'binary', path: b.binaryFilePath }
  }

  return { method, url, headers, body, settings: snippetSettings(input), ...(computedAuth ? { computedAuth } : {}) }
}

/** The comment for a client without Digest / AWS Signature support (the request below it is sent without the auth). */
function computedAuthNote(a: ComputedAuth | undefined, lib: string): string[] {
  if (!a) return []
  if (a.kind === 'digest') {
    return [
      `Digest auth: ${lib} does not answer the server's challenge by itself. Send the request, then repeat it with an`,
      `Authorization: Digest header computed from the 401's WWW-Authenticate challenge (RFC 7616), user "${a.username}".`,
    ]
  }
  return [
    `AWS Signature Version 4 (region ${a.region}, service ${a.service}): sign this request before sending it; the signer`,
    `adds the Authorization and X-Amz-Date headers. Access key "${a.accessKey}". Signer: ${lib}.`,
  ]
}

const lineComments = (lines: string[], prefix: string) => lines.map((l) => `${prefix} ${l}`)

/** Collapse duplicate header names (case-insensitive) into one comma-joined value. */
function collapseHeaders(headers: Pair[]): Pair[] {
  const out: Pair[] = []
  const idx = new Map<string, number>()
  for (const [k, v] of headers) {
    const l = k.toLowerCase()
    const at = idx.get(l)
    if (at === undefined) {
      idx.set(l, out.length)
      out.push([k, v])
    } else out[at][1] += `, ${v}`
  }
  return out
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

// ---------------------------------------------------------------------------
// String literal helpers
// ---------------------------------------------------------------------------

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/** JS double-quoted literal (JSON.stringify is valid JS; also escape U+2028/9 for older engines). */
const jsStr = (s: string) => JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

function pyStr(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === "'") out += "\\'"
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`
    else if (c >= 0xd800 && c <= 0xdfff) out += `\\ufffd`
    else out += ch
  }
  return `'${out}'`
}

function goStr(s: string): string {
  let out = ''
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (c < 0x20 || c === 0x7f) out += `\\x${c.toString(16).padStart(2, '0')}`
    else if (c >= 0xd800 && c <= 0xdfff) out += `\\uFFFD`
    else out += ch
  }
  return `"${out}"`
}

const phpStr = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

/** PowerShell single-quoted literal; typographic single quotes also terminate strings. */
const psStr = (s: string) => `'${s.replace(/['‘’‚‛]/g, (m) => m + m)}'`

/**
 * Windows PowerShell 5.1: certificate checks off for this session. The callback is a compiled C# delegate, not a script
 * block: .NET may validate on a thread without a PowerShell runspace (always for HttpClient), and a script block callback
 * then fails the handshake ("The underlying connection was closed"; seen with Invoke-WebRequest on the Windows runner too).
 */
const PS51_INSECURE =
  "if (-not ('SlingerInsecureTls' -as [type])) { Add-Type -TypeDefinition 'public static class SlingerInsecureTls { public static void Enable() { System.Net.ServicePointManager.ServerCertificateValidationCallback = delegate { return true; }; } }' }; [SlingerInsecureTls]::Enable()"
const PS51_INSECURE_ASYNC = PS51_INSECURE

/** Turns certificate checks off in either PowerShell: `six` in 6+, `five` in Windows PowerShell 5.1. */
const psInsecure = (six: string, five = PS51_INSECURE) => `if ($PSVersionTable.PSVersion.Major -ge 6) { ${six} } else { ${five} }`

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function curl(p: Prepared): string {
  const parts: string[] = []
  const hasBody = p.body.kind !== 'none'
  // curl follows no redirect without -L (--location-trusted also keeps Authorization on another host).
  const s = p.settings
  const flags = [s.follow ? (s.keepAuth ? '--location-trusted' : '-L') : null, s.insecure ? '-k' : null].filter(Boolean).join(' ')
  const cmd = flags ? `curl ${flags}` : 'curl'
  if (p.method === 'HEAD') parts.push(`${cmd} --head ${shq(p.url)}`)
  else if (p.method !== 'GET' || hasBody) parts.push(`${cmd} -X ${(/^[A-Z]+$/.test(p.method) ? p.method : shq(p.method))} ${shq(p.url)}`)
  else parts.push(`${cmd} ${shq(p.url)}`)
  if (s.follow && s.maxRedirects !== null) parts.push(`--max-redirs ${s.maxRedirects}`)
  // "Keep the original method" has no flag here: with -X (every method but GET) curl keeps the method on redirects anyway.
  const a = p.computedAuth
  if (a?.kind === 'digest') parts.push(`--digest -u ${shq(`${a.username}:${a.password}`)}`)
  else if (a?.kind === 'awsv4') {
    // curl 7.75+ signs the request itself.
    parts.push(`--aws-sigv4 ${shq(`aws:amz:${a.region}:${a.service}`)} -u ${shq(`${a.accessKey}:${a.secretKey}`)}`)
    if (a.sessionToken) parts.push(`-H ${shq(`x-amz-security-token: ${a.sessionToken}`)}`)
  }
  for (const [k, v] of p.headers) parts.push(`-H ${shq(`${k}: ${v}`)}`)
  const b = p.body
  if (b.kind === 'raw') parts.push(`--data-raw ${shq(b.content)}`)
  else if (b.kind === 'urlEncoded') for (const [k, v] of b.fields) parts.push(`--data-urlencode ${shq(`${k}=${v}`)}`)
  else if (b.kind === 'formData') {
    for (const f of b.fields) parts.push(f.file ? `-F ${shq(`${f.key}=@${f.value}`)}` : `--form-string ${shq(`${f.key}=${f.value}`)}`)
  } else if (b.kind === 'binary') parts.push(`--data-binary ${shq(`@${b.path}`)}`)
  return parts.join(' \\\n  ')
}

function jsHeaders(headers: Pair[], asPairs: boolean, indent: string): string {
  if (!headers.length) return ''
  if (asPairs) {
    return `${indent}headers: [\n${headers.map(([k, v]) => `${indent}  [${jsStr(k)}, ${jsStr(v)}],`).join('\n')}\n${indent}],\n`
  }
  return `${indent}headers: {\n${headers.map(([k, v]) => `${indent}  ${jsStr(k)}: ${jsStr(v)},`).join('\n')}\n${indent}},\n`
}

function jsBodyPrelude(b: Body): { imports: string[]; prelude: string[]; expr: string | null } {
  if (b.kind === 'raw') return { imports: [], prelude: [], expr: jsStr(b.content) }
  if (b.kind === 'urlEncoded') {
    return {
      imports: [],
      prelude: [],
      expr: `new URLSearchParams([\n${b.fields.map(([k, v]) => `    [${jsStr(k)}, ${jsStr(v)}],`).join('\n')}\n  ])`,
    }
  }
  if (b.kind === 'formData') {
    const imports = b.fields.some((f) => f.file) ? ["import { readFile } from 'node:fs/promises';"] : []
    const prelude = ['const form = new FormData();']
    for (const f of b.fields) {
      prelude.push(
        f.file
          ? `form.append(${jsStr(f.key)}, new Blob([await readFile(${jsStr(f.value)})]), ${jsStr(basename(f.value))});`
          : `form.append(${jsStr(f.key)}, ${jsStr(f.value)});`,
      )
    }
    return { imports, prelude, expr: 'form' }
  }
  if (b.kind === 'binary') {
    return {
      imports: ["import { readFile } from 'node:fs/promises';"],
      prelude: [`const body = await readFile(${jsStr(b.path)});`],
      expr: 'body',
    }
  }
  return { imports: [], prelude: [], expr: null }
}

/** fetch has no per-request switch for certificate checks. */
const JS_INSECURE_NOTE =
  '// SSL certificate verification is off for this request in Slinger. fetch has no option for it: in Node, run with\n' +
  '// NODE_TLS_REJECT_UNAUTHORIZED=0 (for testing only).\n\n'

function fetchSnippet(p: Prepared): string {
  const { imports, prelude, expr } = jsBodyPrelude(p.body)
  const lower = new Set(p.headers.map(([k]) => k.toLowerCase()))
  const asPairs = lower.size !== p.headers.length
  const note = lineComments(
    computedAuthNote(p.computedAuth, p.computedAuth?.kind === 'awsv4' ? 'e.g. @smithy/signature-v4 from the AWS SDK for JavaScript v3, or the aws4 package' : 'fetch'),
    '//',
  )
  let out = note.length ? note.join('\n') + '\n' : ''
  out += imports.length ? imports.join('\n') + '\n\n' : note.length ? '\n' : ''
  if (prelude.length) out += prelude.join('\n') + '\n\n'
  if (p.settings.insecure) out += JS_INSECURE_NOTE
  out += `const response = await fetch(${jsStr(p.url)}, {\n  method: ${jsStr(p.method)},\n`
  out += jsHeaders(p.headers, asPairs, '  ')
  if (expr) out += `  body: ${expr},\n`
  // 'manual' returns the 3xx response itself (in Node; a browser hides it behind an opaque response).
  if (!p.settings.follow) out += "  redirect: 'manual',\n"
  out += '});\n\nconsole.log(response.status);\nconsole.log(await response.text());\n'
  return out
}

function axiosSnippet(p: Prepared): string {
  const { imports, prelude, expr } = jsBodyPrelude(p.body)
  const s = p.settings
  const note = lineComments(
    computedAuthNote(p.computedAuth, p.computedAuth?.kind === 'awsv4' ? 'e.g. @smithy/signature-v4 from the AWS SDK for JavaScript v3, or the aws4 package' : 'axios'),
    '//',
  )
  let out = [...note, ...imports, ...(s.insecure ? ["import https from 'node:https';"] : []), "import axios from 'axios';"].join('\n') + '\n\n'
  if (prelude.length) out += prelude.join('\n') + '\n\n'
  out += `const response = await axios.request({\n  method: ${jsStr(p.method.toLowerCase())},\n  url: ${jsStr(p.url)},\n`
  out += jsHeaders(collapseHeaders(p.headers), false, '  ')
  if (expr) out += `  data: ${expr},\n`
  if (!s.follow) out += '  maxRedirects: 0,\n'
  else if (s.maxRedirects !== null) out += `  maxRedirects: ${s.maxRedirects},\n`
  if (s.insecure) out += '  httpsAgent: new https.Agent({ rejectUnauthorized: false }), // SSL certificate verification off\n'
  out += '  validateStatus: () => true,\n});\n\nconsole.log(response.status);\nconsole.log(response.data);\n'
  return out
}

function python(p: Prepared): string {
  const a = p.computedAuth
  const lines: string[] = ['import requests']
  if (a?.kind === 'digest') lines.push('from requests.auth import HTTPDigestAuth')
  if (a?.kind === 'awsv4') lines.push('from requests_aws4auth import AWS4Auth  # pip install requests-aws4auth')
  lines.push('', `url = ${pyStr(p.url)}`)
  const headers = collapseHeaders(p.headers)
  if (headers.length) {
    lines.push('headers = {', ...headers.map(([k, v]) => `    ${pyStr(k)}: ${pyStr(v)},`), '}')
  }
  const b = p.body
  const args: string[] = [pyStr(p.method), 'url']
  if (headers.length) args.push('headers=headers')
  if (b.kind === 'raw') {
    lines.push(`payload = ${pyStr(b.content)}`)
    args.push("data=payload.encode('utf-8')")
  } else if (b.kind === 'urlEncoded') {
    lines.push('payload = [', ...b.fields.map(([k, v]) => `    (${pyStr(k)}, ${pyStr(v)}),`), ']')
    args.push('data=payload')
  } else if (b.kind === 'formData') {
    lines.push(
      'files = [',
      ...b.fields.map((f) =>
        f.file
          ? `    (${pyStr(f.key)}, (${pyStr(basename(f.value))}, open(${pyStr(f.value)}, 'rb'))),`
          : `    (${pyStr(f.key)}, (None, ${pyStr(f.value)})),`,
      ),
      ']',
    )
    args.push('files=files')
  } else if (b.kind === 'binary') {
    lines.push(`with open(${pyStr(b.path)}, 'rb') as f:`, '    payload = f.read()')
    args.push('data=payload')
  }
  if (a?.kind === 'digest') {
    lines.push(`auth = HTTPDigestAuth(${pyStr(a.username)}, ${pyStr(a.password)})`)
    args.push('auth=auth')
  } else if (a?.kind === 'awsv4') {
    const token = a.sessionToken ? `, session_token=${pyStr(a.sessionToken)}` : ''
    lines.push(`auth = AWS4Auth(${pyStr(a.accessKey)}, ${pyStr(a.secretKey)}, ${pyStr(a.region)}, ${pyStr(a.service)}${token})`)
    args.push('auth=auth')
  }
  const s = p.settings
  if (!s.follow) args.push('allow_redirects=False')
  if (s.insecure) args.push('verify=False')
  if (s.follow && s.maxRedirects !== null) {
    // requests keeps the limit on a Session (default 30).
    lines.push('', 'session = requests.Session()', `session.max_redirects = ${s.maxRedirects}`, `response = session.request(${args.join(', ')})`)
  } else lines.push('', `response = requests.request(${args.join(', ')})`)
  lines.push('', 'print(response.status_code)', 'print(response.text)', '')
  return lines.join('\n')
}

function go(p: Prepared): string {
  const b = p.body
  const imports = new Set<string>(['fmt', 'io', 'net/http'])
  const pre: string[] = []
  let bodyExpr = 'nil'
  if (b.kind === 'raw') {
    imports.add('strings')
    bodyExpr = `strings.NewReader(${goStr(b.content)})`
  } else if (b.kind === 'urlEncoded') {
    imports.add('strings').add('net/url')
    pre.push(
      'form := []string{',
      ...b.fields.map(([k, v]) => `\t\turl.QueryEscape(${goStr(k)}) + "=" + url.QueryEscape(${goStr(v)}),`),
      '}',
    )
    bodyExpr = 'strings.NewReader(strings.Join(form, "&"))'
  } else if (b.kind === 'formData') {
    imports.add('bytes').add('mime/multipart')
    pre.push('payload := &bytes.Buffer{}', 'writer := multipart.NewWriter(payload)')
    let n = 0
    for (const f of b.fields) {
      if (f.file) {
        imports.add('os').add('path/filepath')
        n++
        pre.push(
          `file${n}, err := os.Open(${goStr(f.value)})`,
          'if err != nil {',
          '\tpanic(err)',
          '}',
          `defer file${n}.Close()`,
          `part${n}, err := writer.CreateFormFile(${goStr(f.key)}, filepath.Base(${goStr(f.value)}))`,
          'if err != nil {',
          '\tpanic(err)',
          '}',
          `if _, err := io.Copy(part${n}, file${n}); err != nil {`,
          '\tpanic(err)',
          '}',
        )
      } else {
        pre.push(`if err := writer.WriteField(${goStr(f.key)}, ${goStr(f.value)}); err != nil {`, '\tpanic(err)', '}')
      }
    }
    pre.push('if err := writer.Close(); err != nil {', '\tpanic(err)', '}')
    bodyExpr = 'payload'
  } else if (b.kind === 'binary') {
    imports.add('os')
    pre.push(`file, err := os.Open(${goStr(b.path)})`, 'if err != nil {', '\tpanic(err)', '}', 'defer file.Close()')
    bodyExpr = 'file'
  }
  const s = p.settings
  const client: string[] = []
  if (s.insecure) {
    imports.add('crypto/tls')
    client.push('\tTransport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, // SSL certificate verification off')
  }
  if (!s.follow) {
    client.push('\tCheckRedirect: func(req *http.Request, via []*http.Request) error {', '\t\treturn http.ErrUseLastResponse // do not follow redirects', '\t},')
  } else if (s.maxRedirects !== null) {
    client.push(
      '\tCheckRedirect: func(req *http.Request, via []*http.Request) error {',
      `\t\tif len(via) > ${s.maxRedirects} {`,
      `\t\t\treturn fmt.Errorf("stopped after ${s.maxRedirects} redirects")`,
      '\t\t}',
      '\t\treturn nil',
      '\t},',
    )
  }
  const sorted = [...imports].sort()
  const note = lineComments(computedAuthNote(p.computedAuth, p.computedAuth?.kind === 'awsv4' ? 'e.g. github.com/aws/aws-sdk-go-v2/aws/signer/v4' : 'net/http'), '//')
  let out = `${note.length ? `${note.join('\n')}\n\n` : ''}package main\n\nimport (\n${sorted.map((i) => `\t"${i}"`).join('\n')}\n)\n\nfunc main() {\n`
  for (const l of pre) out += `\t${l}\n`
  out += `\treq, err := http.NewRequest(${goStr(p.method)}, ${goStr(p.url)}, ${bodyExpr})\n\tif err != nil {\n\t\tpanic(err)\n\t}\n`
  for (const [k, v] of p.headers) out += `\treq.Header.Add(${goStr(k)}, ${goStr(v)})\n`
  if (b.kind === 'formData') out += '\treq.Header.Set("Content-Type", writer.FormDataContentType())\n'
  if (client.length) out += `\n\tclient := &http.Client{\n${client.map((l) => `\t${l}`).join('\n')}\n\t}\n`
  out +=
    `\n\tres, err := ${client.length ? 'client' : 'http.DefaultClient'}.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer res.Body.Close()\n\n` +
    '\tbody, err := io.ReadAll(res.Body)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\n\tfmt.Println(res.Status)\n\tfmt.Println(string(body))\n}\n'
  return out
}

function php(p: Prepared): string {
  const b = p.body
  const opts: string[] = [`    CURLOPT_URL => ${phpStr(p.url)},`, '    CURLOPT_RETURNTRANSFER => true,']
  opts.push(`    CURLOPT_CUSTOMREQUEST => ${phpStr(p.method)},`)
  if (p.method === 'HEAD') opts.push('    CURLOPT_NOBODY => true,')
  // PHP's cURL follows no redirect by default; Slinger does.
  const s = p.settings
  if (s.follow) {
    opts.push('    CURLOPT_FOLLOWLOCATION => true,')
    if (s.maxRedirects !== null) opts.push(`    CURLOPT_MAXREDIRS => ${s.maxRedirects},`)
    if (s.keepAuth) opts.push('    CURLOPT_UNRESTRICTED_AUTH => true,')
  }
  if (s.insecure) opts.push('    CURLOPT_SSL_VERIFYPEER => false, // SSL certificate verification off', '    CURLOPT_SSL_VERIFYHOST => 0,')
  if (p.headers.length) {
    opts.push('    CURLOPT_HTTPHEADER => [', ...p.headers.map(([k, v]) => `        ${phpStr(`${k}: ${v}`)},`), '    ],')
  }
  const a = p.computedAuth
  if (a?.kind === 'digest') opts.push('    CURLOPT_HTTPAUTH => CURLAUTH_DIGEST,', `    CURLOPT_USERPWD => ${phpStr(`${a.username}:${a.password}`)},`)
  if (b.kind === 'raw') opts.push(`    CURLOPT_POSTFIELDS => ${phpStr(b.content)},`)
  else if (b.kind === 'urlEncoded') {
    opts.push(
      `    CURLOPT_POSTFIELDS => implode('&', [`,
      ...b.fields.map(([k, v]) => `        urlencode(${phpStr(k)}) . '=' . urlencode(${phpStr(v)}),`),
      '    ]),',
    )
  } else if (b.kind === 'formData') {
    opts.push(
      '    CURLOPT_POSTFIELDS => [',
      ...b.fields.map((f) => `        ${phpStr(f.key)} => ${f.file ? `new CURLFile(${phpStr(f.value)})` : phpStr(f.value)},`),
      '    ],',
    )
  } else if (b.kind === 'binary') opts.push(`    CURLOPT_POSTFIELDS => file_get_contents(${phpStr(b.path)}),`)
  const note = a?.kind === 'awsv4' ? lineComments(computedAuthNote(a, 'e.g. Aws\\Signature\\SignatureV4 from the AWS SDK for PHP'), '//') : []
  return [
    '<?php',
    '',
    ...(note.length ? [...note, ''] : []),
    '$curl = curl_init();',
    '',
    'curl_setopt_array($curl, [',
    ...opts,
    ']);',
    '',
    '$response = curl_exec($curl);',
    '',
    'if ($response === false) {',
    '    echo curl_error($curl);',
    '} else {',
    '    echo $response;',
    '}',
    '',
    'curl_close($curl);',
    '',
  ].join('\n')
}

/**
 * PowerShell that runs in Windows PowerShell 5.1 (the one built into Windows) as well as PowerShell 7+:
 * - `-UseBasicParsing`: 5.1 otherwise parses the page with Internet Explorer's engine, which fails where IE was never set up;
 * - TLS 1.2 enabled for https (5.1 on older .NET offers only TLS 1.0/1.1 by default);
 * - a raw body as UTF-8 bytes (5.1 sends a string body as ISO-8859-1);
 * - User-Agent through `-UserAgent` (5.1 refuses it in `-Headers`);
 * - multipart through .NET's HttpClient (`-Form` only exists in PowerShell 7);
 * - 4xx/5xx throw in both versions: the catch block prints the server's status and answer;
 * - SSL verification off (request setting): `-SkipCertificateCheck` only exists in PowerShell 6+, so it is splatted in there
 *   and 5.1 gets a ServicePointManager callback instead (for HttpClient: the handler's callback in 6+);
 * - not following redirects: `-MaximumRedirection 0` (the 3xx is then reported as a non-terminating error in some versions,
 *   hidden with `-ErrorAction SilentlyContinue`; others throw it, and the catch prints its status like a 4xx).
 */
function powershell(p: Prepared): string {
  const lines: string[] = ['# Works in Windows PowerShell 5.1 and PowerShell 7+.']
  if (p.computedAuth?.kind === 'awsv4') lines.push(...lineComments(computedAuthNote(p.computedAuth, 'e.g. the AWS SDK for .NET'), '#'))
  if (/^https:/i.test(p.url)) {
    lines.push('[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12')
  }
  lines.push('')
  const b = p.body
  if (b.kind === 'formData') return powershellMultipart(p, b.fields, lines)
  const digest = p.computedAuth?.kind === 'digest' ? p.computedAuth : null

  let contentType: string | null = null
  let userAgent: string | null = null
  const headers: Pair[] = []
  for (const h of collapseHeaders(p.headers)) {
    const name = h[0].toLowerCase()
    if (name === 'content-type') contentType = h[1]
    else if (name === 'user-agent') userAgent = h[1]
    else headers.push(h)
  }
  if (headers.length) lines.push('$headers = @{', ...headers.map(([k, v]) => `    ${psStr(k)} = ${psStr(v)}`), '}', '')
  const args = ['-UseBasicParsing', `-Uri ${psStr(p.url)}`, `-Method ${psStr(p.method)}`]
  const s = p.settings
  if (s.insecure) {
    lines.push('# SSL certificate verification is off for this request.', '$insecure = @{}', psInsecure('$insecure.SkipCertificateCheck = $true'), '')
  }
  if (!s.follow) args.push('-MaximumRedirection 0 -ErrorAction SilentlyContinue')
  else if (s.maxRedirects !== null) args.push(`-MaximumRedirection ${s.maxRedirects}`)
  if (s.insecure) args.push('@insecure')
  if (headers.length) args.push('-Headers $headers')
  if (contentType !== null) args.push(`-ContentType ${psStr(contentType)}`)
  if (userAgent !== null) args.push(`-UserAgent ${psStr(userAgent)}`)
  if (digest) {
    // .NET answers the Digest challenge for -Credential in both 5.1 (HttpWebRequest) and 7 (HttpClientHandler).
    lines.push(
      `$credential = New-Object System.Management.Automation.PSCredential -ArgumentList ${psStr(digest.username)}, (ConvertTo-SecureString ${psStr(digest.password)} -AsPlainText -Force)`,
    )
    args.push('-Credential $credential')
    if (!/^https:/i.test(p.url)) {
      lines.push(
        '# PowerShell 7 sends credentials over plain http only with -AllowUnencryptedAuthentication, which 5.1 does not have.',
        '$auth = @{}',
        'if ($PSVersionTable.PSVersion.Major -ge 6) { $auth.AllowUnencryptedAuthentication = $true }',
      )
      args.push('@auth')
    }
    lines.push('')
  }
  if (b.kind === 'raw') {
    lines.push(`$body = [System.Text.Encoding]::UTF8.GetBytes(${psStr(b.content)})`, '')
    args.push('-Body $body')
  } else if (b.kind === 'urlEncoded') {
    lines.push(
      '$body = ' + b.fields.map(([k, v]) => `[uri]::EscapeDataString(${psStr(k)}) + '=' + [uri]::EscapeDataString(${psStr(v)})`).join(" + '&' + "),
      '',
    )
    args.push('-Body $body')
  } else if (b.kind === 'binary') {
    args.push(`-InFile ${psStr(b.path)}`)
  }
  lines.push(
    'try {',
    `    $response = Invoke-WebRequest ${args.join(' ')}`,
    '    $response.StatusCode',
    '    $response.Content',
    '} catch {',
    '    # A 4xx/5xx answer throws: show its status and body.',
    '    $r = $_.Exception.Response',
    '    if (-not $r) { throw }',
    '    [int]$r.StatusCode',
    '    if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message }',
    '    elseif ($r -is [System.Net.WebResponse]) {',
    '        # Windows PowerShell 5.1 leaves the answer in the response stream.',
    '        $stream = $r.GetResponseStream()',
    '        if ($stream.CanSeek) { $stream.Position = 0 }',
    '        (New-Object System.IO.StreamReader -ArgumentList $stream).ReadToEnd()',
    '    }',
    '}',
    '',
  )
  return lines.join('\n')
}

/** Multipart through .NET's HttpClient, which both Windows PowerShell 5.1 and PowerShell 7 have. */
function powershellMultipart(p: Prepared, fields: Extract<Body, { kind: 'formData' }>['fields'], lines: string[]): string {
  const digest = p.computedAuth?.kind === 'digest' ? p.computedAuth : null
  lines.push('Add-Type -AssemblyName System.Net.Http')
  const s = p.settings
  // HttpClient follows up to 50 redirects by default; a limit of 0 is "do not follow" (the handler refuses 0).
  const noFollow = !s.follow || s.maxRedirects === 0
  if (noFollow || s.maxRedirects !== null || s.insecure || digest) {
    lines.push('$handler = New-Object System.Net.Http.HttpClientHandler')
    if (noFollow) lines.push('$handler.AllowAutoRedirect = $false')
    else if (s.maxRedirects !== null) lines.push(`$handler.MaxAutomaticRedirections = ${s.maxRedirects}`)
    if (s.insecure) {
      lines.push(
        '# SSL certificate verification is off for this request.',
        psInsecure('$handler.ServerCertificateCustomValidationCallback = [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator', PS51_INSECURE_ASYNC),
      )
    }
    if (digest) {
      // The handler answers the Digest challenge (the form is buffered below so it can be sent twice).
      lines.push(`$handler.Credentials = New-Object System.Net.NetworkCredential -ArgumentList ${psStr(digest.username)}, ${psStr(digest.password)}`)
    }
    lines.push('$client = New-Object System.Net.Http.HttpClient -ArgumentList $handler')
  } else lines.push('$client = New-Object System.Net.Http.HttpClient')
  lines.push(
    `$request = New-Object System.Net.Http.HttpRequestMessage -ArgumentList (New-Object System.Net.Http.HttpMethod -ArgumentList ${psStr(p.method)}), ${psStr(p.url)}`,
  )
  // The form sets its own Content-Type (with the boundary); every other header goes on the request.
  for (const [k, v] of collapseHeaders(p.headers)) {
    if (k.toLowerCase() !== 'content-type') lines.push(`[void]$request.Headers.TryAddWithoutValidation(${psStr(k)}, ${psStr(v)})`)
  }
  lines.push('$form = New-Object System.Net.Http.MultipartFormDataContent')
  const files: string[] = []
  for (const f of fields) {
    if (f.file) {
      const name = `$file${files.length + 1}`
      files.push(name)
      const fileName = f.value.split(/[\\/]/).pop() || 'file'
      lines.push(
        `${name} = [System.IO.File]::OpenRead(${psStr(f.value)})`,
        `$form.Add((New-Object System.Net.Http.StreamContent -ArgumentList ${name}), ${psStr(f.key)}, ${psStr(fileName)})`,
      )
    } else {
      lines.push(`$form.Add((New-Object System.Net.Http.StringContent -ArgumentList ${psStr(f.value)}), ${psStr(f.key)})`)
    }
  }
  if (digest) lines.push('[void]$form.LoadIntoBufferAsync().GetAwaiter().GetResult()')
  lines.push(
    '$request.Content = $form',
    '',
    'try {',
    '    $response = $client.SendAsync($request).GetAwaiter().GetResult()',
    '    [int]$response.StatusCode',
    '    $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()',
    '} finally {',
    ...files.map((f) => `    ${f}.Dispose()`),
    '    $client.Dispose()',
    '}',
    '',
  )
  return lines.join('\n')
}

// JetBrains HTTP Client / VS Code REST Client request (one block of a `.http` file).

/** Multipart boundary when the request does not set one (the one the JetBrains HTTP Client's examples use). */
export const HTTP_FILE_BOUNDARY = 'WebAppBoundary'

/** Request names, header names and values are single lines in a `.http` file. */
const oneLine = (s: string) => s.replace(/\r\n|[\r\n]/g, ' ')

/** Whitespace would end the request line's URL, so it is percent-encoded (outside `{{vars}}`). */
const httpUrl = (url: string) => mapOutsideTokens(url, (part) => part.replace(/\s/g, (c) => encodeURIComponent(c)))

/** Quoted Content-Disposition parameter, escaped like browsers do (WHATWG multipart/form-data). */
const dispositionParam = (s: string) => s.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

/** `< path` includes a file; a bare relative path gets `./` so it reads as one. */
const fileRef = (path: string) => `< ${/^(?:[/\\~.]|[A-Za-z]:)/.test(path) ? path : `./${path}`}`

function httpFile(p: Prepared, name: string): string {
  const lines: string[] = []
  const title = oneLine(name).trim()
  if (title) lines.push(`### ${title}`)
  // JetBrains HTTP Client directives (other .http clients read them as comments). SSL verification is set per
  // environment there (http-client.private.env.json), not per request, so it has no directive.
  if (!p.settings.follow) lines.push('# @no-redirect')
  if (p.settings.noCookieJar) lines.push('# @no-cookie-jar')
  lines.push(`${p.method} ${httpUrl(p.url)}`)
  const headers = [...p.headers]
  const b = p.body
  let boundary = HTTP_FILE_BOUNDARY
  if (b.kind === 'formData') {
    // prepare() only keeps a multipart Content-Type that names its boundary; the parts below must use it.
    const ct = headers.find(([k]) => k.toLowerCase() === 'content-type')
    const m = ct ? /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(ct[1]) : null
    if (m) boundary = m[1] ?? m[2]
    else headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`])
  }
  const a = p.computedAuth
  // JetBrains HTTP Client and VS Code REST Client both answer a Digest challenge for this form of the header.
  if (a?.kind === 'digest' && !hasHeader(headers, 'Authorization')) headers.push(['Authorization', `Digest ${a.username} ${a.password}`])
  if (a?.kind === 'awsv4') lines.splice(title ? 1 : 0, 0, ...lineComments(computedAuthNote(a, 'VS Code REST Client: Authorization: AWS <access key> <secret key> region:<region> service:<service>'), '#'))
  for (const [k, v] of headers) lines.push(`${oneLine(k)}: ${oneLine(v)}`)
  if (b.kind === 'raw') lines.push('', b.content)
  else if (b.kind === 'urlEncoded') lines.push('', b.fields.map(([k, v]) => `${encodeKeepingVars(k)}=${encodeKeepingVars(v)}`).join('&'))
  else if (b.kind === 'formData') {
    lines.push('')
    for (const f of b.fields) {
      lines.push(`--${boundary}`)
      if (f.file) {
        lines.push(`Content-Disposition: form-data; name="${dispositionParam(f.key)}"; filename="${dispositionParam(basename(f.value))}"`, '', fileRef(f.value))
      } else lines.push(`Content-Disposition: form-data; name="${dispositionParam(f.key)}"`, '', f.value)
    }
    lines.push(`--${boundary}--`)
  } else if (b.kind === 'binary') lines.push('', fileRef(b.path))
  return lines.join('\n') + '\n'
}

export function generateSnippet(lang: SnippetLang, input: HttpRequestInput): string {
  const p = prepare(input, lang === 'http' ? { oauth2Token: `{{${HTTP_OAUTH2_TOKEN_VARIABLE}}}`, plainBasicWithVariables: true } : {})
  switch (lang) {
    case 'curl':
      return curl(p)
    case 'fetch':
      return fetchSnippet(p)
    case 'axios':
      return axiosSnippet(p)
    case 'python':
      return python(p)
    case 'go':
      return go(p)
    case 'php':
      return php(p)
    case 'powershell':
      return powershell(p)
    case 'http':
      return httpFile(p, input.requestName ?? '')
  }
}

// ---------------------------------------------------------------------------
// MCP Inspector CLI (MCP requests)
// ---------------------------------------------------------------------------

/** The only snippet language of an MCP request. */
export const MCP_SNIPPET_LANG = { id: 'mcpInspector', label: 'MCP Inspector CLI', editorLanguage: 'shell' as EditorLanguage }

export const MCP_INSPECTOR_PACKAGE = '@modelcontextprotocol/inspector'

/** An MCP request with its templates applied (unresolved and secret variables stay `{{name}}`). */
export interface McpSnippetInput {
  transport: McpClientTransport
  /** http/sse: the server URL, headers and auth (auth is turned into headers as for the other snippets). */
  http?: HttpRequestInput
  /** stdio */
  command?: string
  args?: string[]
  env?: Array<{ key: string; value: string }>
  cwd?: string
  operation: McpOperationName
  /** Tool or prompt name. */
  name: string
  uri?: string
  /** tools/call: the parsed arguments object; prompts/get: the string arguments. */
  arguments?: Record<string, unknown>
}

/** A shell word: bare when it is plain, single-quoted otherwise. */
const shWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : shq(s))

/** `--tool-arg` value: strings as they are, anything else as JSON (the Inspector parses JSON values). */
const toolArgValue = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? 'null'))

/**
 * Wraps `{{name}}` tokens left outside JSON string literals in quotes, so arguments with an unresolved bare variable
 * (`{"n": {{n}}}`) still parse; the variable then shows in the snippet as `n={{n}}`.
 */
function quoteBareTokens(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const quote = text.indexOf('"', i)
    const plain = quote < 0 ? text.slice(i) : text.slice(i, quote)
    out += plain.replace(/\{\{[^{}]*\}\}/g, (t) => JSON.stringify(t))
    if (quote < 0) break
    let end = quote + 1
    while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1
    out += text.slice(quote, end + 1)
    i = end + 1
  }
  return out
}

export type McpSnippetPrepared = { ok: true; input: McpSnippetInput } | { ok: false; error: string }

/**
 * An MCP draft as McpSnippetInput, resolved like the other snippets (`prepareRequest` with `allowUnresolved`): values of
 * the active scope are applied, secrets and undefined variables stay `{{name}}`, built-ins get sample values.
 */
export function prepareMcpSnippet(draft: RequestDraft, ctx: Omit<PrepareContext, 'allowUnresolved' | 'secrets'>): McpSnippetPrepared {
  const m = draft.mcp
  if (!m) return { ok: false, error: 'This is not an MCP request.' }
  const { resolve: r } = templateResolver(ctx)
  const input: McpSnippetInput = { transport: m.transport, operation: m.operation, name: '' }
  if (m.transport === 'stdio') {
    const command = r(m.command).trim()
    if (!command) return { ok: false, error: 'Enter the command that starts the MCP server.' }
    input.command = command
    input.args = m.args.map(r)
    input.env = dataRows(m.env)
      .filter((e) => e.enabled && e.key.trim())
      .map((e) => ({ key: e.key.trim(), value: r(e.value) }))
    input.cwd = r(m.cwd).trim()
  } else {
    if (!draft.url.trim()) return { ok: false, error: 'Enter the URL of the MCP server.' }
    const prepared = prepareRequest(draft, { ...ctx, allowUnresolved: true })
    if (!prepared.ok) return { ok: false, error: prepared.error }
    input.http = prepared.input
  }
  if (m.operation === 'tools/call') {
    input.name = m.tool.trim()
    const text = quoteBareTokens(resolveJsonTemplates(m.arguments, r)).trim()
    let args: unknown = {}
    if (text) {
      try {
        args = JSON.parse(text)
      } catch (e) {
        return { ok: false, error: `The tool arguments are not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'The tool arguments must be a JSON object.' }
    input.arguments = args as Record<string, unknown>
  } else if (m.operation === 'resources/read') {
    input.uri = r(m.uri).trim()
  } else {
    input.name = m.prompt.trim()
    const args: Record<string, string> = {}
    for (const row of dataRows(m.promptArguments)) if (row.enabled && row.key.trim()) args[row.key.trim()] = r(row.value)
    input.arguments = args
  }
  return { ok: true, input }
}

/**
 * The MCP Inspector CLI command that runs the same operation: `npx @modelcontextprotocol/inspector --cli <server> ...`.
 * http/sse: the URL, `--transport` and one `--header` per header (auth included; an OAuth 2.0 token is a placeholder).
 * stdio: `-e KEY=value` per environment variable, then the command and its arguments; a working directory becomes a
 * leading `cd`. An empty tool, prompt or URI is left as a `<placeholder>`.
 */
export function mcpInspectorSnippet(input: McpSnippetInput): string {
  const first: string[] = ['npx', MCP_INSPECTOR_PACKAGE, '--cli']
  const parts: string[] = []
  if (input.transport === 'stdio') {
    for (const e of input.env ?? []) first.push('-e', shWord(`${e.key}=${e.value}`))
    first.push(shWord(input.command ?? ''), ...(input.args ?? []).map(shWord))
  } else {
    const p = prepare(input.http ?? { method: 'GET', url: '', headers: [], auth: { kind: 'none' }, body: { mode: 'none' }, workspaceId: '' })
    first.push(shWord(p.url))
    parts.push(`--transport ${input.transport}`)
    for (const [k, v] of p.headers) parts.push(`--header ${shq(`${k}: ${v}`)}`)
  }
  parts.push(`--method ${input.operation}`)
  const args = Object.entries(input.arguments ?? {})
  if (input.operation === 'tools/call') {
    parts.push(`--tool-name ${shWord(input.name || '<tool>')}`)
    for (const [k, v] of args) parts.push(`--tool-arg ${shWord(`${k}=${toolArgValue(v)}`)}`)
  } else if (input.operation === 'resources/read') {
    parts.push(`--uri ${shWord(input.uri || '<uri>')}`)
  } else {
    parts.push(`--prompt-name ${shWord(input.name || '<prompt>')}`)
    for (const [k, v] of args) parts.push(`--prompt-args ${shWord(`${k}=${toolArgValue(v)}`)}`)
  }
  const cd = input.transport === 'stdio' && input.cwd ? `cd ${shWord(input.cwd)} && ` : ''
  return `${cd}${first.join(' ')} \\\n  ${parts.join(' \\\n  ')}`
}
