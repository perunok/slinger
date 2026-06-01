export type PayloadContentType = 'json' | 'xml' | 'html' | 'text' | 'binary'

export type PayloadTokenKind =
  | 'plain'
  | 'key'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'punctuation'

export type PayloadToken = {
  kind: PayloadTokenKind
  value: string
}

export type PayloadFormatResult = {
  value: string
  ok: boolean
  error?: string
}

type PayloadFormatter = {
  label: string
  format: (value: string) => PayloadFormatResult
}

export const PAYLOAD_CONTENT_TYPE_OPTIONS: Array<{
  value: PayloadContentType
  label: string
}> = [
  { value: 'json', label: 'JSON' },
  { value: 'xml', label: 'XML' },
  { value: 'html', label: 'HTML' },
  { value: 'text', label: 'Text' },
  { value: 'binary', label: 'Binary' },
]

function passthrough(value: string): PayloadFormatResult {
  return { value, ok: true }
}

function formatJson(value: string): PayloadFormatResult {
  if (!value.trim()) return { value: '', ok: true }

  // If the payload contains template placeholders like {{...}}, avoid
  // attempting to parse/format as strict JSON — treat as valid raw payload
  // so editors don't mark it as invalid.
  if (/\{\{[^}]+\}\}/.test(value)) {
    return { value, ok: true }
  }

  try {
    return {
      value: JSON.stringify(JSON.parse(value), null, 2),
      ok: true,
    }
  } catch (error) {
    return {
      value,
      ok: false,
      error: error instanceof Error ? error.message : 'Invalid JSON',
    }
  }
}

export const PAYLOAD_FORMATTERS: Record<PayloadContentType, PayloadFormatter> = {
  json: {
    label: 'JSON',
    format: formatJson,
  },
  xml: {
    label: 'XML',
    format: passthrough,
  },
  html: {
    label: 'HTML',
    format: passthrough,
  },
  text: {
    label: 'Text',
    format: passthrough,
  },
  binary: {
    label: 'Binary',
    format: passthrough,
  },
}

export function normalizePayloadContentType(value: string): PayloadContentType {
  const normalized = value.toLowerCase()

  if (normalized.includes('json')) return 'json'
  if (normalized.includes('xml')) return 'xml'
  if (normalized.includes('html')) return 'html'
  if (normalized.includes('octet-stream') || normalized.includes('binary')) return 'binary'
  if (normalized.startsWith('text/') || normalized.includes('text')) return 'text'

  if (Object.prototype.hasOwnProperty.call(PAYLOAD_FORMATTERS, normalized)) {
    return normalized as PayloadContentType
  }

  return 'text'
}

export function formatPayload(
  value: string,
  contentType: PayloadContentType | string,
): PayloadFormatResult {
  const formatter = PAYLOAD_FORMATTERS[normalizePayloadContentType(contentType)]
  return formatter.format(value)
}

const JSON_TOKEN_PATTERN =
  /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^"\\])*")(\s*:)?|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|[{}\[\],:]/g

export function tokenizeJsonLine(line: string): PayloadToken[] {
  const tokens: PayloadToken[] = []
  JSON_TOKEN_PATTERN.lastIndex = 0

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = JSON_TOKEN_PATTERN.exec(line)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'plain', value: line.slice(lastIndex, match.index) })
    }

    const [matched, quotedValue, keySuffix] = match

    if (quotedValue) {
      tokens.push({ kind: keySuffix ? 'key' : 'string', value: quotedValue })

      if (keySuffix) {
        const spacing = keySuffix.slice(0, -1)
        if (spacing) tokens.push({ kind: 'plain', value: spacing })
        tokens.push({ kind: 'punctuation', value: ':' })
      }
    } else if (matched === 'true' || matched === 'false') {
      tokens.push({ kind: 'boolean', value: matched })
    } else if (matched === 'null') {
      tokens.push({ kind: 'null', value: matched })
    } else if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(matched)) {
      tokens.push({ kind: 'number', value: matched })
    } else {
      tokens.push({ kind: 'punctuation', value: matched })
    }

    lastIndex = match.index + matched.length
  }

  if (lastIndex < line.length) {
    tokens.push({ kind: 'plain', value: line.slice(lastIndex) })
  }

  return tokens.length > 0 ? tokens : [{ kind: 'plain', value: line }]
}
