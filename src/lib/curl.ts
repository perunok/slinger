/**
 * cURL commands -> request drafts (Import dialog, and a curl pasted into the URL bar). Pure, no DOM.
 *
 * Reads what browsers' "Copy as cURL" and API docs produce: bash quoting ('…', "…", $'…', backslash escapes and line
 * continuations) and Windows cmd quoting (^ escapes, ^ line ends), several commands in one text (one per `curl` at the
 * start of a line, or separated by `;` / `&&`), short options combined (`-sSL`, `-XPOST`) and `--long=value`.
 *
 * Mapped: method (-X, -I, -G, -T), URL (first argument or --url; no scheme means http://, like curl), headers (-H, -A, -e,
 * -b with cookies), body (-d / --data-* / --json joined with &, -F / --form-string as form data, -T / --data-binary @file as
 * a binary file), basic auth (-u), bearer auth (--oauth2-bearer) and the timeout (-m). Options that do not change the
 * request (-s, -L, --compressed, -v, ...) are skipped silently; anything else ignored is listed in `warnings`.
 * Shell variables outside single quotes (`$API_KEY`, `${TOKEN}`) become Slinger variables (`{{API_KEY}}`), so a command
 * from API docs works with an environment. Other commands in the text (`export X=1;`, `| jq`) are skipped.
 */
import { emptyAuth, emptyBody, newDraft, type BodyDraft, type RawLanguage, type RequestDraft } from './request'
import { ensureTrailingEmpty, newRow, type KvRow } from './kv'
import { mergeParamsFromUrl } from './urlParams'

export interface ParsedCurl {
  method: string
  url: string
  headers: Array<{ key: string; value: string }>
  body: BodyDraft
  auth: { kind: 'basic'; username: string; password: string } | { kind: 'bearer'; token: string } | null
  timeoutMs: number | null
  /** Options that were not imported, in words. */
  warnings: string[]
}

export type CurlParse = { ok: true; requests: ParsedCurl[] } | { ok: false; error: string }

/** Options that take a value, by every spelling (short ones without the dash). */
const WITH_VALUE = new Set([
  'X', 'request', 'H', 'header', 'd', 'data', 'data-raw', 'data-ascii', 'data-binary', 'data-urlencode', 'json', 'F', 'form',
  'form-string', 'u', 'user', 'A', 'user-agent', 'e', 'referer', 'b', 'cookie', 'url', 'oauth2-bearer', 'T', 'upload-file',
  'm', 'max-time', 'o', 'output', 'x', 'proxy', 'U', 'proxy-user', 'connect-timeout', 'retry', 'retry-delay', 'retry-max-time',
  'w', 'write-out', 'cacert', 'capath', 'E', 'cert', 'key', 'cert-type', 'key-type', 'pass', 'resolve', 'connect-to',
  'limit-rate', 'max-redirs', 'c', 'cookie-jar', 'D', 'dump-header', 'K', 'config', 'r', 'range', 'C', 'continue-at', 'Y',
  'speed-limit', 'y', 'speed-time', 'interface', 'local-port', 'dns-servers', 'unix-socket', 'abstract-unix-socket',
  'aws-sigv4', 'ciphers', 'tls-max', 'trace', 'trace-ascii', 'stderr', 'expect100-timeout', 'happy-eyeballs-timeout-ms',
  'keepalive-time', 'netrc-file', 'noproxy', 'preproxy', 'proxy-header', 'socks5', 'socks5-hostname', 'z', 'time-cond',
])

/** Options that only affect how curl runs or prints, not the request Slinger sends: skipped without a warning. */
const QUIET = new Set([
  's', 'silent', 'S', 'show-error', 'L', 'location', 'compressed', 'v', 'verbose', 'i', 'include', 'f', 'fail',
  'fail-with-body', 'k', 'insecure', 'g', 'globoff', 'N', 'no-buffer', '#', 'progress-bar', 'http1.0', 'http1.1', 'http2',
  'http2-prior-knowledge', 'http3', 'tlsv1', 'tlsv1.0', 'tlsv1.1', 'tlsv1.2', 'tlsv1.3', 'ipv4', '4', 'ipv6', '6',
  'no-keepalive', 'tcp-nodelay', 'path-as-is', 'raw', 'q', 'disable', 'no-progress-meter', 'no-sessionid', 'remote-name',
  'O', 'remote-header-name', 'J', 'trace-time', 'location-trusted', 'max-time', 'm', 'connect-timeout', 'retry',
  'retry-delay', 'retry-max-time', 'output', 'o', 'write-out', 'w', 'max-redirs', 'stderr', 'dump-header', 'D',
])

/** Text that starts with a curl command (what the URL bar treats as an import). */
export function looksLikeCurl(text: string): boolean {
  return /^\s*curl(?:\.exe)?\s/i.test(text)
}

/** Text with a curl command anywhere at the start of a command (`export X=1; curl …` too). */
export function containsCurl(text: string): boolean {
  return /(?:^|[\n;&|])\s*curl(?:\.exe)?\s/i.test(text)
}

/** Every command in `text`, parsed. An error when nothing parses, or names the command that does not. */
export function parseCurl(text: string): CurlParse {
  if (!containsCurl(text)) return { ok: false, error: 'Not a cURL command: it must start with "curl".' }
  const cmd = isCmdStyle(text)
  let tokens: string[]
  try {
    tokens = tokenize(cmd ? fromCmd(text) : text, !cmd)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const commands: string[][] = []
  for (const t of tokens) {
    if (t === SEPARATOR) commands.push([])
    else if (commands.length === 0) commands.push([t])
    else commands[commands.length - 1]!.push(t)
  }
  const requests: ParsedCurl[] = []
  const curls = commands.filter((c) => c.length > 0 && /^curl(?:\.exe)?$/i.test(c[0]!))
  for (const [i, words] of curls.entries()) {
    const r = parseOne(words.slice(1))
    if (typeof r === 'string') return { ok: false, error: curls.length > 1 ? `Command ${i + 1}: ${r}` : r }
    requests.push(r)
  }
  return requests.length ? { ok: true, requests } : { ok: false, error: 'No cURL command found.' }
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

const SEPARATOR = '\u0000;'

/** Windows cmd (Chrome's "Copy as cURL (cmd)"): ^ escapes, a ^ at the end of a line continues it. */
function isCmdStyle(text: string): boolean {
  return /\^\r?\n/.test(text) || /\^"/.test(text)
}

/** cmd -> bash-like text: drop ^ line continuations, then ^X -> X (the rest is double-quoted like bash). */
function fromCmd(text: string): string {
  return text.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1')
}

/**
 * Shell words. A newline (outside quotes, not escaped) followed by `curl`, or `;` / `&&` / `|` between words, starts a new
 * command (SEPARATOR). `$'…'` (ANSI-C quoting) is understood when `bash` is true.
 */
function tokenize(text: string, bash: boolean): string[] {
  const out: string[] = []
  let word = ''
  let inWord = false
  let i = 0
  const push = () => {
    if (inWord) out.push(word)
    word = ''
    inWord = false
  }
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      i += text[i + 1] === '\r' ? 3 : 2
      continue
    }
    if (c === ' ' || c === '\t') {
      push()
      i++
      continue
    }
    if (c === '\n' || c === '\r') {
      push()
      // A new line that starts with curl is a new command (Chrome's "Copy all as cURL").
      if (/^[\r\n\s]*curl(?:\.exe)?\s/i.test(text.slice(i)) && out.length > 0 && out.at(-1) !== SEPARATOR) out.push(SEPARATOR)
      i++
      continue
    }
    if (c === ';' || (c === '&' && text[i + 1] === '&') || c === '|') {
      push()
      if (out.length > 0 && out.at(-1) !== SEPARATOR) out.push(SEPARATOR)
      i += c === '&' || (c === '|' && text[i + 1] === '|') ? 2 : 1
      continue
    }
    if (c === '#' && !inWord) {
      // A comment runs to the end of the line.
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    inWord = true
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end < 0) throw new Error('A single quote (\') is never closed.')
      word += text.slice(i + 1, end)
      i = end + 1
    } else if (bash && c === '$' && text[i + 1] === "'") {
      const [value, next] = ansiC(text, i + 2)
      word += value
      i = next
    } else if (bash && c === '$' && shellVar(text, i)) {
      const [name, next] = shellVar(text, i)!
      word += `{{${name}}}`
      i = next
    } else if (c === '"') {
      i++
      let closed = false
      while (i < text.length) {
        const d = text[i]!
        if (d === '"') {
          closed = true
          i++
          break
        }
        if (d === '\\' && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) {
          if (text[i + 1] !== '\n') word += text[i + 1]
          i += 2
          continue
        }
        const v = bash && d === '$' ? shellVar(text, i) : null
        if (v) {
          word += `{{${v[0]}}}`
          i = v[1]
          continue
        }
        word += d
        i++
      }
      if (!closed) throw new Error('A double quote (") is never closed.')
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[i + 1]
      i += 2
    } else {
      word += c
      i++
    }
  }
  push()
  return out
}

/** `$NAME` or `${NAME}` at `i`: the name and the index after it; null when it is not a variable. */
function shellVar(text: string, i: number): [string, number] | null {
  const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(text.slice(i, i + 260))
  return m ? [m[1] ?? m[2]!, i + m[0].length] : null
}

/** `$'…'` from `start` (after the opening quote): returns the value and the index after the closing quote. */
function ansiC(text: string, start: number): [string, number] {
  let out = ''
  let i = start
  const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', '?': '?' }
  while (i < text.length) {
    const c = text[i]!
    if (c === "'") return [out, i + 1]
    if (c === '\\' && i + 1 < text.length) {
      const n = text[i + 1]!
      if (n in simple) {
        out += simple[n]
        i += 2
      } else if (n === 'x' && /^[0-9a-f]{1,2}/i.test(text.slice(i + 2))) {
        const hex = /^[0-9a-f]{1,2}/i.exec(text.slice(i + 2))![0]
        out += String.fromCharCode(parseInt(hex, 16))
        i += 2 + hex.length
      } else if ((n === 'u' || n === 'U') && /^[0-9a-f]{1,8}/i.test(text.slice(i + 2))) {
        const hex = new RegExp(`^[0-9a-f]{1,${n === 'u' ? 4 : 8}}`, 'i').exec(text.slice(i + 2))![0]
        out += String.fromCodePoint(parseInt(hex, 16))
        i += 2 + hex.length
      } else if (/[0-7]/.test(n)) {
        const oct = /^[0-7]{1,3}/.exec(text.slice(i + 1))![0]
        out += String.fromCharCode(parseInt(oct, 8))
        i += 1 + oct.length
      } else {
        out += `\\${n}`
        i += 2
      }
      continue
    }
    out += c
    i++
  }
  throw new Error("A $'…' quote is never closed.")
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The words after `curl` as [option, value] pairs (value null for flags) and positional arguments. */
function options(words: string[]): { opts: Array<[string, string | null]>; args: string[] } | string {
  const opts: Array<[string, string | null]> = []
  const args: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '--') {
      args.push(...words.slice(i + 1))
      break
    }
    if (w.startsWith('--') && w.length > 2) {
      const eq = w.indexOf('=')
      const name = eq > 0 ? w.slice(2, eq) : w.slice(2)
      if (WITH_VALUE.has(name)) {
        const value = eq > 0 ? w.slice(eq + 1) : words[++i]
        if (value === undefined) return `--${name} needs a value.`
        opts.push([name, value])
      } else opts.push([name, null])
    } else if (w.startsWith('-') && w.length > 1) {
      for (let j = 1; j < w.length; j++) {
        const f = w[j]!
        if (WITH_VALUE.has(f)) {
          const rest = w.slice(j + 1)
          const value = rest !== '' ? rest : words[++i]
          if (value === undefined) return `-${f} needs a value.`
          opts.push([f, value])
          break
        }
        opts.push([f, null])
      }
    } else args.push(w)
  }
  return { opts, args }
}

const LONG: Record<string, string> = {
  X: 'request', H: 'header', d: 'data', F: 'form', u: 'user', A: 'user-agent', e: 'referer', b: 'cookie', T: 'upload-file',
  m: 'max-time', I: 'head', G: 'get', x: 'proxy',
}

function parseOne(words: string[]): ParsedCurl | string {
  const parsed = options(words)
  if (typeof parsed === 'string') return parsed
  const warnings: string[] = []
  let method: string | null = null
  let url: string | null = null
  let head = false
  let get = false
  let upload: string | null = null
  let json = false
  const headers: Array<{ key: string; value: string }> = []
  const data: Array<{ text: string; file: string | null }> = []
  const form: KvRow[] = []
  let auth: ParsedCurl['auth'] = null
  let timeoutMs: number | null = null

  for (const [raw, value] of parsed.opts) {
    const name = LONG[raw] ?? raw
    const v = value ?? ''
    switch (name) {
      case 'request':
        method = v.trim().toUpperCase() || null
        break
      case 'url':
        url ??= v
        break
      case 'header': {
        const colon = v.indexOf(':')
        const semi = v.indexOf(';')
        if (colon > 0) headers.push({ key: v.slice(0, colon).trim(), value: v.slice(colon + 1).trim() })
        else if (semi > 0 && v.trim().endsWith(';')) headers.push({ key: v.trim().slice(0, -1).trim(), value: '' })
        else if (v.startsWith('@')) warnings.push(`Headers from the file ${v.slice(1)} were not imported.`)
        else warnings.push(`The header "${v}" has no colon and was skipped.`)
        break
      }
      case 'user-agent':
        headers.push({ key: 'User-Agent', value: v })
        break
      case 'referer':
        headers.push({ key: 'Referer', value: v.replace(/;auto$/, '') })
        break
      case 'cookie':
        if (v.includes('=')) headers.push({ key: 'Cookie', value: v })
        else warnings.push(`Cookies from the file ${v} were not imported.`)
        break
      case 'data':
      case 'data-ascii':
      case 'data-binary':
        if (v.startsWith('@')) data.push({ text: '', file: v.slice(1) })
        else data.push({ text: name === 'data-binary' ? v : v.replace(/[\r\n]/g, ''), file: null })
        break
      case 'data-raw':
        data.push({ text: v, file: null })
        break
      case 'json':
        json = true
        if (v.startsWith('@')) data.push({ text: '', file: v.slice(1) })
        else data.push({ text: v, file: null })
        break
      case 'data-urlencode':
        data.push({ text: urlencodeArg(v, warnings), file: null })
        break
      case 'form':
      case 'form-string': {
        const eq = v.indexOf('=')
        if (eq <= 0) {
          warnings.push(`The form field "${v}" has no name and was skipped.`)
          break
        }
        const key = v.slice(0, eq)
        let val = v.slice(eq + 1)
        if (name === 'form' && (val.startsWith('@') || val.startsWith('<'))) {
          const path = val.slice(1).split(';')[0]!
          if (val.startsWith('@')) form.push(newRow({ key, value: path, kind: 'file' }))
          else warnings.push(`The form field "${key}" reads its value from ${path}; it was imported empty.`), form.push(newRow({ key, value: '' }))
          break
        }
        if (name === 'form') val = val.replace(/;type=[^;]*$/, '')
        form.push(newRow({ key, value: val }))
        break
      }
      case 'user': {
        const colon = v.indexOf(':')
        auth = colon >= 0 ? { kind: 'basic', username: v.slice(0, colon), password: v.slice(colon + 1) } : { kind: 'basic', username: v, password: '' }
        break
      }
      case 'oauth2-bearer':
        auth = { kind: 'bearer', token: v }
        break
      case 'head':
        head = true
        break
      case 'get':
        get = true
        break
      case 'upload-file':
        upload = v
        break
      case 'max-time': {
        const s = Number(v)
        if (Number.isFinite(s) && s > 0) timeoutMs = Math.round(s * 1000)
        break
      }
      case 'proxy':
        warnings.push(`The proxy ${v} was not imported (Slinger uses the system proxy).`)
        break
      default:
        if (!QUIET.has(raw) && !QUIET.has(name)) warnings.push(`${raw.length === 1 ? '-' : '--'}${raw} was ignored.`)
    }
  }

  url ??= parsed.args[0] ?? null
  if (!url) return 'No URL found.'
  if (parsed.args.length > 1) warnings.push(`Only the first URL was imported (${parsed.args.length} were given).`)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.startsWith('{{')) url = `http://${url}`

  if (json) {
    if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/json' })
    if (!headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push({ key: 'Accept', value: 'application/json' })
  }

  let body: BodyDraft = emptyBody()
  const dataText = data.filter((d) => d.file === null).map((d) => d.text).join('&')
  const dataFile = data.find((d) => d.file !== null)?.file ?? null
  if (get && data.length > 0) {
    if (dataText) url += (url.includes('?') ? '&' : '?') + dataText
    if (dataFile) warnings.push(`Data from the file ${dataFile} was not imported.`)
  } else if (form.length > 0) {
    body = { ...emptyBody(), kind: 'formData', formData: ensureTrailingEmpty(form) }
    // curl sets multipart/form-data with its boundary; a copied one would not match Slinger's.
    removeHeader(headers, 'content-type')
    if (data.length > 0) warnings.push('-d data next to -F form fields was not imported (curl refuses that too).')
  } else if (upload !== null || (dataFile !== null && data.length === 1)) {
    body = { ...emptyBody(), kind: 'binary', binaryPath: upload ?? dataFile! }
    warnings.push(`The body is the file ${upload ?? dataFile}: check the path in the Body tab.`)
  } else if (data.length > 0) {
    if (dataFile) warnings.push(`Data from the file ${dataFile} was not imported.`)
    body = bodyFromData(dataText, headerValue(headers, 'content-type'), warnings)
  }

  const finalMethod = method ?? (head ? 'HEAD' : upload !== null ? 'PUT' : !get && (data.length > 0 || form.length > 0) ? 'POST' : 'GET')
  return { method: finalMethod, url, headers, body, auth, timeoutMs, warnings }
}

function headerValue(headers: Array<{ key: string; value: string }>, name: string): string | null {
  return headers.find((h) => h.key.toLowerCase() === name)?.value ?? null
}

function removeHeader(headers: Array<{ key: string; value: string }>, name: string): void {
  for (let i = headers.length - 1; i >= 0; i--) if (headers[i]!.key.toLowerCase() === name) headers.splice(i, 1)
}

/** `--data-urlencode` forms: `content`, `=content`, `name=content`, `@file`, `name@file`. */
function urlencodeArg(v: string, warnings: string[]): string {
  const at = v.indexOf('@')
  const eq = v.indexOf('=')
  if (at >= 0 && (eq < 0 || at < eq)) {
    warnings.push(`--data-urlencode reads ${v.slice(at + 1)}; it was not imported.`)
    return at > 0 ? `${v.slice(0, at)}=` : ''
  }
  if (eq < 0) return encodeURIComponent(v)
  const name = v.slice(0, eq)
  const content = encodeURIComponent(v.slice(eq + 1))
  return name ? `${name}=${content}` : content
}

function languageOf(contentType: string): RawLanguage {
  const ct = contentType.toLowerCase()
  if (ct.includes('json')) return 'json'
  if (ct.includes('xml')) return 'xml'
  if (ct.includes('html')) return 'html'
  if (ct.includes('javascript')) return 'javascript'
  return 'text'
}

function isJson(text: string): boolean {
  const t = text.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

/** -d data as a body: url-encoded rows for form data, raw text otherwise (JSON when it is JSON). */
function bodyFromData(text: string, contentType: string | null, warnings: string[]): BodyDraft {
  const formType = contentType === null || contentType.toLowerCase().includes('application/x-www-form-urlencoded')
  const pairs = text.split('&')
  if (formType && !isJson(text) && pairs.every((p) => /^[^=&]+=/.test(p))) {
    const rows = pairs.map((p) => {
      const eq = p.indexOf('=')
      return newRow({ key: decodeForm(p.slice(0, eq)), value: decodeForm(p.slice(eq + 1)) })
    })
    return { ...emptyBody(), kind: 'urlEncoded', urlEncoded: ensureTrailingEmpty(rows) }
  }
  if (contentType === null && isJson(text)) {
    warnings.push('The data is JSON but had no Content-Type: it was imported as a JSON body (curl would send it as form data).')
    return { ...emptyBody(), kind: 'raw', raw: text, rawLanguage: 'json' }
  }
  return { ...emptyBody(), kind: 'raw', raw: text, rawLanguage: contentType ? languageOf(contentType) : 'text' }
}

function decodeForm(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** A short name for an imported request: "GET /users/1", or the host for the root path. */
export function curlRequestName(p: Pick<ParsedCurl, 'method' | 'url'>): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(p.url)
  const path = m ? m[2] || '/' : p.url
  const label = path === '/' && m ? m[1]! : path
  const name = `${p.method} ${label}`
  return name.length > 120 ? `${name.slice(0, 119)}…` : name
}

export function curlToDraft(p: ParsedCurl, name = curlRequestName(p)): RequestDraft {
  const draft = newDraft({
    name,
    method: p.method,
    url: p.url,
    params: mergeParamsFromUrl(p.url, []),
    headers: ensureTrailingEmpty(p.headers.map((h) => newRow({ key: h.key, value: h.value }))),
    body: p.body,
    timeoutMs: p.timeoutMs,
  })
  if (p.auth?.kind === 'basic') draft.auth = { ...emptyAuth(), kind: 'basic', basic: { username: p.auth.username, password: p.auth.password } }
  else if (p.auth?.kind === 'bearer') draft.auth = { ...emptyAuth(), kind: 'bearer', bearer: { token: p.auth.token } }
  return draft
}
