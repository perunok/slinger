/**
 * JSON validation / beautifying for bodies that contain `{{variables}}`.
 * Tokens are swapped for placeholders that keep the text valid JSON (string-safe inside
 * strings, quoted when they stand in for a value), the JSON is processed, then tokens are restored.
 */
import { parseTokens } from './template'
import { prettyPrint } from './response'

interface Substituted {
  text: string
  tokens: string[]
}

const MARK = '__SLINGER_TPL_'

export function substituteTokens(text: string): Substituted {
  const tokens: string[] = []
  let out = ''
  let last = 0
  // Track whether each token sits inside a JSON string.
  const toks = parseTokens(text)
  let ti = 0
  let inString = false
  for (let i = 0; i < text.length && ti <= toks.length; i++) {
    if (ti < toks.length && i === toks[ti].from) {
      const t = toks[ti]
      out += text.slice(last, t.from)
      const id = `${MARK}${tokens.length}__`
      tokens.push(t.raw)
      out += inString ? id : `"${id}"`
      last = t.to
      i = t.to - 1
      ti++
      continue
    }
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
  }
  out += text.slice(last)
  return { text: out, tokens }
}

function restore(text: string, tokens: string[]): string {
  return text
    .replace(new RegExp(`"${MARK}(\\d+)__"`, 'g'), (_m, n: string) => tokens[Number(n)])
    .replace(new RegExp(`${MARK}(\\d+)__`, 'g'), (_m, n: string) => tokens[Number(n)])
}

export type JsonCheck = { ok: true } | { ok: false; error: string }

/** Empty text is considered fine (nothing to validate). */
export function checkJson(text: string): JsonCheck {
  if (!text.trim()) return { ok: true }
  const sub = substituteTokens(text)
  const res = prettyPrint('json', sub.text)
  return res.ok ? { ok: true } : { ok: false, error: res.error ?? 'Invalid JSON' }
}

export function beautifyJson(text: string): { ok: true; text: string } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, text }
  const sub = substituteTokens(text)
  const res = prettyPrint('json', sub.text)
  if (!res.ok) return { ok: false, error: res.error ?? 'Invalid JSON' }
  return { ok: true, text: restore(res.text, sub.tokens) }
}
