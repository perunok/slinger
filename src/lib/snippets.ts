/**
 * Code snippet generation from an already-resolved HttpRequestInput.
 * Pure string builders, one per target language. `{{vars}}` are left verbatim.
 *
 * MCP requests get one snippet instead: an MCP Inspector CLI command line (`mcpInspectorSnippet`, input built from the
 * draft by `prepareMcpSnippet`).
 */

import type { HttpRequestInput, McpClientTransport, McpOperationName } from '../../shared/types'
import { prepareRequest, resolveJsonTemplates, templateResolver, type PrepareContext } from './prepare'
import { dataRows } from './kv'
import type { RequestDraft } from './request'
import { textToBase64, type EditorLanguage } from './response'
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
  { id: 'curl', label: 'cURL', editorLanguage: 'text' },
  { id: 'fetch', label: 'JavaScript (fetch)', editorLanguage: 'javascript' },
  { id: 'axios', label: 'JavaScript (axios)', editorLanguage: 'javascript' },
  { id: 'python', label: 'Python (requests)', editorLanguage: 'text' },
  { id: 'go', label: 'Go (net/http)', editorLanguage: 'text' },
  { id: 'php', label: 'PHP (cURL)', editorLanguage: 'text' },
  { id: 'powershell', label: 'PowerShell', editorLanguage: 'text' },
  { id: 'http', label: 'HTTP file (.http)', editorLanguage: 'text', fileExtension: '.http' },
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

interface Prepared {
  method: string
  url: string
  headers: Pair[]
  body: Body
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

  return { method, url, headers, body }
}

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

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

function curl(p: Prepared): string {
  const parts: string[] = []
  const hasBody = p.body.kind !== 'none'
  if (p.method === 'HEAD') parts.push('curl --head ' + shq(p.url))
  else if (p.method !== 'GET' || hasBody) parts.push(`curl -X ${(/^[A-Z]+$/.test(p.method) ? p.method : shq(p.method))} ${shq(p.url)}`)
  else parts.push(`curl ${shq(p.url)}`)
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

function fetchSnippet(p: Prepared): string {
  const { imports, prelude, expr } = jsBodyPrelude(p.body)
  const lower = new Set(p.headers.map(([k]) => k.toLowerCase()))
  const asPairs = lower.size !== p.headers.length
  let out = imports.length ? imports.join('\n') + '\n\n' : ''
  if (prelude.length) out += prelude.join('\n') + '\n\n'
  out += `const response = await fetch(${jsStr(p.url)}, {\n  method: ${jsStr(p.method)},\n`
  out += jsHeaders(p.headers, asPairs, '  ')
  if (expr) out += `  body: ${expr},\n`
  out += '});\n\nconsole.log(response.status);\nconsole.log(await response.text());\n'
  return out
}

function axiosSnippet(p: Prepared): string {
  const { imports, prelude, expr } = jsBodyPrelude(p.body)
  let out = [...imports, "import axios from 'axios';"].join('\n') + '\n\n'
  if (prelude.length) out += prelude.join('\n') + '\n\n'
  out += `const response = await axios.request({\n  method: ${jsStr(p.method.toLowerCase())},\n  url: ${jsStr(p.url)},\n`
  out += jsHeaders(collapseHeaders(p.headers), false, '  ')
  if (expr) out += `  data: ${expr},\n`
  out += '  validateStatus: () => true,\n});\n\nconsole.log(response.status);\nconsole.log(response.data);\n'
  return out
}

function python(p: Prepared): string {
  const lines: string[] = ['import requests', '', `url = ${pyStr(p.url)}`]
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
  lines.push('', `response = requests.request(${args.join(', ')})`, '', 'print(response.status_code)', 'print(response.text)', '')
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
  const sorted = [...imports].sort()
  let out = `package main\n\nimport (\n${sorted.map((i) => `\t"${i}"`).join('\n')}\n)\n\nfunc main() {\n`
  for (const l of pre) out += `\t${l}\n`
  out += `\treq, err := http.NewRequest(${goStr(p.method)}, ${goStr(p.url)}, ${bodyExpr})\n\tif err != nil {\n\t\tpanic(err)\n\t}\n`
  for (const [k, v] of p.headers) out += `\treq.Header.Add(${goStr(k)}, ${goStr(v)})\n`
  if (b.kind === 'formData') out += '\treq.Header.Set("Content-Type", writer.FormDataContentType())\n'
  out +=
    '\n\tres, err := http.DefaultClient.Do(req)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\tdefer res.Body.Close()\n\n' +
    '\tbody, err := io.ReadAll(res.Body)\n\tif err != nil {\n\t\tpanic(err)\n\t}\n\n\tfmt.Println(res.Status)\n\tfmt.Println(string(body))\n}\n'
  return out
}

function php(p: Prepared): string {
  const b = p.body
  const opts: string[] = [`    CURLOPT_URL => ${phpStr(p.url)},`, '    CURLOPT_RETURNTRANSFER => true,']
  opts.push(`    CURLOPT_CUSTOMREQUEST => ${phpStr(p.method)},`)
  if (p.method === 'HEAD') opts.push('    CURLOPT_NOBODY => true,')
  if (p.headers.length) {
    opts.push('    CURLOPT_HTTPHEADER => [', ...p.headers.map(([k, v]) => `        ${phpStr(`${k}: ${v}`)},`), '    ],')
  }
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
  return [
    '<?php',
    '',
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

function powershell(p: Prepared): string {
  const lines: string[] = []
  let contentType: string | null = null
  const headers: Pair[] = []
  for (const h of collapseHeaders(p.headers)) {
    if (h[0].toLowerCase() === 'content-type') contentType = h[1]
    else headers.push(h)
  }
  if (headers.length) lines.push('$headers = @{', ...headers.map(([k, v]) => `    ${psStr(k)} = ${psStr(v)}`), '}', '')
  const b = p.body
  const args = [`-Uri ${psStr(p.url)}`, `-Method ${psStr(p.method)}`]
  if (headers.length) args.push('-Headers $headers')
  if (contentType !== null) args.push(`-ContentType ${psStr(contentType)}`)
  if (b.kind === 'raw') {
    lines.push(`$body = ${psStr(b.content)}`, '')
    args.push('-Body $body')
  } else if (b.kind === 'urlEncoded') {
    lines.push(
      '$body = ' + b.fields.map(([k, v]) => `[uri]::EscapeDataString(${psStr(k)}) + '=' + [uri]::EscapeDataString(${psStr(v)})`).join(" + '&' + "),
      '',
    )
    args.push('-Body $body')
  } else if (b.kind === 'formData') {
    lines.push(
      '# -Form requires PowerShell 7+',
      '$form = @{',
      ...b.fields.map((f) => `    ${psStr(f.key)} = ${f.file ? `Get-Item -LiteralPath ${psStr(f.value)}` : psStr(f.value)}`),
      '}',
      '',
    )
    args.push('-Form $form')
  } else if (b.kind === 'binary') {
    args.push(`-InFile ${psStr(b.path)}`)
  }
  lines.push(`$response = Invoke-WebRequest ${args.join(' ')}`, '$response.StatusCode', '$response.Content', '')
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
export const MCP_SNIPPET_LANG = { id: 'mcpInspector', label: 'MCP Inspector CLI', editorLanguage: 'text' as EditorLanguage }

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
