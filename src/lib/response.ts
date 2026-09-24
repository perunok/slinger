/**
 * Pure helpers for the response viewer: body classification, pretty printing,
 * CSV / Set-Cookie parsing, formatting and base64 utilities. No DOM access.
 */

import type { HttpResponseData, RequestHeader } from '../../shared/types'

export type BodyKind =
  | 'json'
  | 'xml'
  | 'html'
  | 'text'
  | 'csv'
  | 'image'
  | 'pdf'
  | 'binary'
  | 'empty'

export type EditorLanguage = 'json' | 'xml' | 'html' | 'css' | 'javascript' | 'text'

export interface ResponseBodyInfo {
  kind: BodyKind
  mime: string
  language: EditorLanguage
  /** Decoded UTF-8 text when text-like (also for svg images), else null. */
  text: string | null
  /** Base64 of raw bytes for image/pdf/binary, else null (svg text also provides base64). */
  base64: string | null
  byteLength: number
}

export const LARGE_BODY_BYTES = 2 * 1024 * 1024

// ---------------------------------------------------------------------------
// base64 / bytes
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i
  t['-'.charCodeAt(0)] = 62
  t['_'.charCodeAt(0)] = 63
  return t
})()

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x6000 // multiple of 3
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk)
    let bin = ''
    for (let j = 0; j < slice.length; j += 0x2000) {
      bin += String.fromCharCode(...slice.subarray(j, j + 0x2000))
    }
    out += btoa(bin)
  }
  return out
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

/** Tolerant decoder: ignores whitespace, data-URL prefix, url-safe alphabet, missing padding, junk. */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof b64 !== 'string' || !b64) return new Uint8Array(0)
  let s = b64
  const comma = s.indexOf(',')
  if (s.startsWith('data:') && comma !== -1) s = s.slice(comma + 1)
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 61) break // '='
    const v = c < 128 ? B64_LOOKUP[c] : -1
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
      acc &= (1 << bits) - 1
    }
  }
  return Uint8Array.from(out)
}

export function dataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`
}

// ---------------------------------------------------------------------------
// analysis
// ---------------------------------------------------------------------------

function headerValue(headers: RequestHeader[] | undefined, name: string): string {
  if (!Array.isArray(headers)) return ''
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h && typeof h.key === 'string' && h.key.trim().toLowerCase() === lower) {
      return typeof h.value === 'string' ? h.value : ''
    }
  }
  return ''
}

function mimeOf(headers: RequestHeader[] | undefined): string {
  return headerValue(headers, 'content-type').split(';')[0].trim().toLowerCase()
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false
  return true
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = ''
  for (let i = start; i < Math.min(bytes.length, start + len); i++) s += String.fromCharCode(bytes[i])
  return s
}

/** Returns the mime type when the bytes carry a known binary signature. */
function sniffBinary(bytes: Uint8Array): { kind: 'image' | 'pdf'; mime: string } | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png' }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return { kind: 'image', mime: 'image/gif' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp' }
  if (startsWith(bytes, [0x42, 0x4d]) && bytes.length >= 26) return { kind: 'image', mime: 'image/bmp' }
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6) return { kind: 'image', mime: 'image/x-icon' }
  if (ascii(bytes, 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf' }
  return null
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function looksLikeJson(trimmed: string): boolean {
  const c = trimmed[0]
  if (c !== '{' && c !== '[') return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

function looksLikeSvg(trimmed: string): boolean {
  if (!trimmed.startsWith('<')) return false
  return /^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i.test(trimmed)
}

function looksLikeHtml(trimmed: string): boolean {
  return /^(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(trimmed)
}

function looksLikeXml(trimmed: string): boolean {
  if (/^<\?xml[\s?]/i.test(trimmed)) return true
  return /^<[A-Za-z_][\w:.-]*[\s>/]/.test(trimmed) && />\s*$/.test(trimmed)
}

function looksLikeCsv(text: string): boolean {
  const sample = text.length > 65536 ? text.slice(0, 65536) : text
  if (sample.indexOf('\n') === -1) return false
  const delimiter = detectDelimiter(sample)
  const rows = parseCsv(sample, delimiter)
  if (rows.length < 2) return false
  // Ignore a possibly truncated last row when sampling.
  const check = text.length > 65536 ? rows.slice(0, -1) : rows
  if (check.length < 2) return false
  const cols = check[0].length
  if (cols < 2) return false
  return check.every((r) => r.length === cols)
}

function languageFor(kind: BodyKind, mime: string): EditorLanguage {
  switch (kind) {
    case 'json':
      return 'json'
    case 'xml':
      return 'xml'
    case 'html':
      return 'html'
    default:
      if (mime === 'text/css') return 'css'
      if (mime === 'text/javascript' || mime === 'application/javascript' || mime === 'application/x-javascript') {
        return 'javascript'
      }
      return 'text'
  }
}

const JSON_MIME = /(^|\/|\+)json$/
const XML_MIME = /^(?:application|text)\/xml$|\+xml$/

export function analyzeResponse(res: HttpResponseData): ResponseBodyInfo {
  try {
    return analyzeUnsafe(res)
  } catch {
    return { kind: 'empty', mime: '', language: 'text', text: null, base64: null, byteLength: 0 }
  }
}

function analyzeUnsafe(res: HttpResponseData): ResponseBodyInfo {
  const headerMime = mimeOf(res?.headers)
  const b64 = typeof res?.bodyBase64 === 'string' && res.bodyBase64 ? res.bodyBase64 : null
  let text = typeof res?.bodyText === 'string' && res.bodyText ? res.bodyText : null

  const declared = Number.isFinite(res?.bodyByteLength) ? Math.max(0, res.bodyByteLength) : 0
  const bytes = b64 ? base64ToBytes(b64) : null

  if (!bytes && text === null) {
    return { kind: 'empty', mime: headerMime, language: 'text', text: null, base64: null, byteLength: declared }
  }
  if (bytes && bytes.length === 0 && text === null) {
    return { kind: 'empty', mime: headerMime, language: 'text', text: null, base64: null, byteLength: declared }
  }

  const byteLength = declared || (bytes ? bytes.length : new TextEncoder().encode(text ?? '').length)

  if (bytes) {
    const sig = sniffBinary(bytes)
    if (sig) {
      return {
        kind: sig.kind,
        mime: headerMime.startsWith('image/') && sig.kind === 'image' ? headerMime : sig.mime,
        language: 'text',
        text: null,
        base64: b64,
        byteLength,
      }
    }
    if (headerMime === 'application/pdf') {
      return { kind: 'pdf', mime: headerMime, language: 'text', text: null, base64: b64, byteLength }
    }
    if (headerMime.startsWith('image/') && headerMime !== 'image/svg+xml') {
      return { kind: 'image', mime: headerMime, language: 'text', text: null, base64: b64, byteLength }
    }
    // Bytes that are not valid UTF-8 but claim to be text: decode lossily.
    const textual =
      headerMime.startsWith('text/') || JSON_MIME.test(headerMime) || XML_MIME.test(headerMime) || headerMime === 'image/svg+xml'
    if (!textual) {
      return { kind: 'binary', mime: headerMime || 'application/octet-stream', language: 'text', text: null, base64: b64, byteLength }
    }
    text = new TextDecoder('utf-8').decode(bytes)
  }

  const body = text ?? ''
  const trimmed = stripBom(body).trim()

  if (body.startsWith('%PDF-')) {
    return { kind: 'pdf', mime: 'application/pdf', language: 'text', text: null, base64: textToBase64(body), byteLength }
  }

  // SVG is an image but its text is also useful.
  if (headerMime === 'image/svg+xml' || looksLikeSvg(trimmed)) {
    return {
      kind: 'image',
      mime: 'image/svg+xml',
      language: 'xml',
      text: body,
      base64: textToBase64(body),
      byteLength,
    }
  }

  let kind: BodyKind
  if (JSON_MIME.test(headerMime)) kind = 'json'
  else if (headerMime === 'text/html' || headerMime === 'application/xhtml+xml') kind = 'html'
  else if (XML_MIME.test(headerMime)) kind = 'xml'
  else if (headerMime === 'text/csv' || headerMime === 'application/csv') kind = 'csv'
  else if (looksLikeJson(trimmed)) kind = 'json'
  else if (looksLikeHtml(trimmed)) kind = 'html'
  else if (looksLikeXml(trimmed)) kind = 'xml'
  else if (
    (headerMime === '' || headerMime === 'text/plain' || headerMime === 'application/octet-stream') &&
    looksLikeCsv(trimmed)
  ) {
    kind = 'csv'
  } else kind = 'text'

  const mime =
    headerMime ||
    (kind === 'json' ? 'application/json' : kind === 'html' ? 'text/html' : kind === 'xml' ? 'application/xml' : kind === 'csv' ? 'text/csv' : 'text/plain')

  return { kind, mime, language: languageFor(kind, headerMime), text: body, base64: null, byteLength }
}

// ---------------------------------------------------------------------------
// pretty printing
// ---------------------------------------------------------------------------

export function prettyPrint(kind: BodyKind, text: string): { text: string; ok: boolean; error?: string } {
  try {
    if (kind === 'json') return prettyJson(text)
    if (kind === 'xml') return { text: prettyXml(text), ok: true }
    if (kind === 'html') return { text: text.trim(), ok: true }
  } catch (e) {
    return { text, ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return { text, ok: true }
}

function positionToLineCol(text: string, pos: number): { line: number; col: number } {
  let line = 1
  let col = 1
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
      col = 1
    } else col++
  }
  return { line, col }
}

/** Minimal JSON validator that reports where parsing first fails. */
function findJsonErrorOffset(src: string): { offset: number; message: string } | null {
  let i = 0
  const n = src.length
  class Fail extends Error {
    constructor(
      public offset: number,
      msg: string,
    ) {
      super(msg)
    }
  }
  const ws = () => {
    while (i < n && /[ \t\r\n]/.test(src[i])) i++
  }
  const unexpected = () =>
    i >= n ? new Fail(n, 'Unexpected end of JSON input') : new Fail(i, `Unexpected token '${src[i]}'`)
  const value = (depth: number): void => {
    if (depth > 512) throw new Fail(i, 'Nesting too deep')
    ws()
    const c = src[i]
    if (c === '{') {
      i++
      ws()
      if (src[i] === '}') return void i++
      for (;;) {
        ws()
        if (src[i] !== '"') throw unexpected()
        str()
        ws()
        if (src[i] !== ':') throw unexpected()
        i++
        value(depth + 1)
        ws()
        if (src[i] === ',') {
          i++
          continue
        }
        if (src[i] === '}') return void i++
        throw unexpected()
      }
    } else if (c === '[') {
      i++
      ws()
      if (src[i] === ']') return void i++
      for (;;) {
        value(depth + 1)
        ws()
        if (src[i] === ',') {
          i++
          continue
        }
        if (src[i] === ']') return void i++
        throw unexpected()
      }
    } else if (c === '"') str()
    else {
      const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(src.slice(i, i + 400))
      if (!m) throw unexpected()
      i += m[0].length
    }
  }
  const str = () => {
    i++
    while (i < n && src[i] !== '"') {
      if (src[i] === '\\') i++
      else if (src[i] < ' ') throw new Fail(i, 'Bad control character in string literal')
      i++
    }
    if (i >= n) throw new Fail(n, 'Unterminated string')
    i++
  }
  try {
    value(0)
    ws()
    if (i < n) throw new Fail(i, `Unexpected non-whitespace character '${src[i]}' after JSON`)
  } catch (e) {
    if (e instanceof Fail) return { offset: e.offset, message: e.message }
  }
  return null
}

function prettyJson(text: string): { text: string; ok: boolean; error?: string } {
  const source = stripBom(text)
  try {
    JSON.parse(source)
  } catch (e) {
    const fallback = e instanceof Error ? e.message : String(e)
    const at = findJsonErrorOffset(source)
    let msg = fallback
    if (at) {
      const { line, col } = positionToLineCol(source, at.offset)
      msg = `${at.message} at line ${line}, column ${col}`
    }
    return { text, ok: false, error: msg }
  }
  // Token-preserving formatter so big numbers / key order / duplicate keys survive.
  let out = ''
  let depth = 0
  const ind = (n: number) => '  '.repeat(n)
  const n = source.length
  let i = 0
  while (i < n) {
    const c = source[i]
    if (c === '"') {
      let j = i + 1
      while (j < n && source[j] !== '"') j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']'
      let j = i + 1
      while (j < n && /\s/.test(source[j])) j++
      if (source[j] === close) {
        out += c + close
        i = j + 1
      } else {
        depth++
        out += c + '\n' + ind(depth)
        i++
      }
    } else if (c === '}' || c === ']') {
      depth--
      out += '\n' + ind(depth) + c
      i++
    } else if (c === ',') {
      out += ',\n' + ind(depth)
      i++
    } else if (c === ':') {
      out += ': '
      i++
    } else if (/\s/.test(c)) {
      i++
    } else {
      let j = i
      while (j < n && !/[\s,:\]}]/.test(source[j])) j++
      out += source.slice(i, j)
      i = j
    }
  }
  return { text: out, ok: true }
}

type XmlToken =
  | { t: 'open'; s: string }
  | { t: 'close'; s: string }
  | { t: 'self'; s: string }
  | { t: 'text'; s: string }
  | { t: 'misc'; s: string }

function tokenizeXml(src: string): XmlToken[] {
  const tokens: XmlToken[] = []
  let i = 0
  const n = src.length
  const pushText = (s: string) => {
    const tr = s.trim()
    if (tr) tokens.push({ t: 'text', s: tr })
  }
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      pushText(src.slice(i))
      break
    }
    if (lt > i) pushText(src.slice(i, lt))
    i = lt
    let end: number
    let kind: XmlToken['t']
    if (src.startsWith('<!--', i)) {
      const e = src.indexOf('-->', i + 4)
      end = e === -1 ? n : e + 3
      kind = 'misc'
    } else if (src.startsWith('<![CDATA[', i)) {
      const e = src.indexOf(']]>', i + 9)
      end = e === -1 ? n : e + 3
      kind = 'text'
    } else if (src.startsWith('<?', i)) {
      const e = src.indexOf('?>', i + 2)
      end = e === -1 ? n : e + 2
      kind = 'misc'
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal subset in [...]
      let j = i + 2
      let bracket = 0
      let quote = ''
      while (j < n) {
        const ch = src[j]
        if (quote) {
          if (ch === quote) quote = ''
        } else if (ch === '"' || ch === "'") quote = ch
        else if (ch === '[') bracket++
        else if (ch === ']') bracket--
        else if (ch === '>' && bracket <= 0) break
        j++
      }
      end = Math.min(n, j + 1)
      kind = 'misc'
    } else {
      let j = i + 1
      let quote = ''
      while (j < n) {
        const ch = src[j]
        if (quote) {
          if (ch === quote) quote = ''
        } else if (ch === '"' || ch === "'") quote = ch
        else if (ch === '>') break
        j++
      }
      end = Math.min(n, j + 1)
      const s = src.slice(i, end)
      kind = s.startsWith('</') ? 'close' : s.endsWith('/>') ? 'self' : 'open'
    }
    tokens.push({ t: kind, s: src.slice(i, end) })
    i = end
  }
  return tokens
}

function prettyXml(src: string): string {
  const tokens = tokenizeXml(src.trim())
  const lines: string[] = []
  let depth = 0
  const pad = () => '  '.repeat(depth)
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]
    if (tk.t === 'open') {
      const next = tokens[i + 1]
      const after = tokens[i + 2]
      if (next && next.t === 'text' && after && after.t === 'close') {
        lines.push(pad() + tk.s + next.s + after.s)
        i += 2
      } else if (next && next.t === 'close') {
        lines.push(pad() + tk.s + next.s)
        i += 1
      } else {
        lines.push(pad() + tk.s)
        depth++
      }
    } else if (tk.t === 'close') {
      depth = Math.max(0, depth - 1)
      lines.push(pad() + tk.s)
    } else {
      lines.push(pad() + tk.s)
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_DELIMITERS = [',', ';', '\t', '|']

function detectDelimiter(text: string): string {
  const sample = text.length > 16384 ? text.slice(0, 16384) : text
  let best = ','
  let bestFraction = -1
  let bestCols = 0
  for (const d of CSV_DELIMITERS) {
    const rows = parseCsv(sample, d).slice(0, 20)
    if (rows.length === 0) continue
    const counts = new Map<number, number>()
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1)
    let modal = 0
    let modalN = 0
    for (const [c, k] of counts) {
      if (k > modalN || (k === modalN && c > modal)) {
        modal = c
        modalN = k
      }
    }
    if (modal < 2) continue
    const fraction = modalN / rows.length
    if (fraction > bestFraction || (fraction === bestFraction && modal > bestCols)) {
      best = d
      bestFraction = fraction
      bestCols = modal
    }
  }
  return best
}

export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = stripBom(text ?? '')
  const d = delimiter && delimiter.length > 0 ? delimiter : detectDelimiter(src)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let quotedField = false
  let i = 0
  const n = src.length
  const endField = () => {
    row.push(field)
    field = ''
    quotedField = false
  }
  const endRow = () => {
    endField()
    // skip completely blank lines
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }
  while (i < n) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === '"' && field === '' && !quotedField) {
      inQuotes = true
      quotedField = true
      i++
    } else if (src.startsWith(d, i)) {
      endField()
      i += d.length
    } else if (c === '\r') {
      endRow()
      i += src[i + 1] === '\n' ? 2 : 1
    } else if (c === '\n') {
      endRow()
      i++
    } else {
      field += c
      i++
    }
  }
  if (field !== '' || row.length > 0 || quotedField) endRow()
  return rows
}

// ---------------------------------------------------------------------------
// cookies
// ---------------------------------------------------------------------------

export interface CookieInfo {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: string
  maxAge?: string
  secure: boolean
  httpOnly: boolean
  sameSite?: string
}

function splitSetCookie(value: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== ',') continue
    const before = value.slice(start, i)
    const after = value.slice(i + 1)
    if (/expires\s*=\s*[A-Za-z]*$/i.test(before)) continue
    if (/^\s*[^=;,\s]+=/.test(after)) {
      parts.push(before)
      start = i + 1
    }
  }
  parts.push(value.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

function parseOneCookie(str: string): CookieInfo | null {
  const segments = str.split(';')
  const first = segments[0].trim()
  if (!first) return null
  const eq = first.indexOf('=')
  const cookie: CookieInfo = {
    name: eq === -1 ? '' : first.slice(0, eq).trim(),
    value: eq === -1 ? first : first.slice(eq + 1).trim(),
    secure: false,
    httpOnly: false,
  }
  for (const seg of segments.slice(1)) {
    const t = seg.trim()
    if (!t) continue
    const e = t.indexOf('=')
    const k = (e === -1 ? t : t.slice(0, e)).trim().toLowerCase()
    const v = e === -1 ? '' : t.slice(e + 1).trim()
    switch (k) {
      case 'domain':
        cookie.domain = v
        break
      case 'path':
        cookie.path = v
        break
      case 'expires':
        cookie.expires = v
        break
      case 'max-age':
        cookie.maxAge = v
        break
      case 'secure':
        cookie.secure = true
        break
      case 'httponly':
        cookie.httpOnly = true
        break
      case 'samesite':
        cookie.sameSite = v
        break
    }
  }
  return cookie
}

export function parseSetCookies(headers: RequestHeader[]): CookieInfo[] {
  const out: CookieInfo[] = []
  if (!Array.isArray(headers)) return out
  for (const h of headers) {
    if (!h || typeof h.key !== 'string' || h.key.trim().toLowerCase() !== 'set-cookie') continue
    if (typeof h.value !== 'string') continue
    for (const part of splitSetCookie(h.value)) {
      const c = parseOneCookie(part)
      if (c) out.push(c)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms'
  const r = Math.round(ms)
  if (r < 1000) return `${r} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`
  const totalSeconds = Math.round(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m} min ${s} s`
}

export function statusTone(status: number): 'success' | 'info' | 'warning' | 'danger' {
  if (status >= 200 && status < 300) return 'success'
  if (status >= 100 && status < 400) return 'info'
  if (status >= 400 && status < 500) return 'warning'
  return 'danger'
}

export function truncateForDisplay(
  text: string,
  limit = LARGE_BODY_BYTES,
): { text: string; truncated: boolean; totalChars: number } {
  const totalChars = text.length
  if (totalChars <= limit) return { text, truncated: false, totalChars }
  let end = Math.max(0, limit)
  const code = text.charCodeAt(end - 1)
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true, totalChars }
}

export function searchMatches(text: string, query: string, caseSensitive = false): number {
  if (!query) return 0
  const hay = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  let count = 0
  let idx = 0
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}
