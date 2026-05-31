import {
  PayloadContentType,
  PayloadTokenKind,
  formatPayload,
  normalizePayloadContentType,
  tokenizeJsonLine,
} from '../lib/payloadFormatters'

type Props = {
  value: string
  contentType: PayloadContentType | string
  emptyText?: string
  className?: string
}

const TOKEN_CLASS: Record<PayloadTokenKind, string> = {
  plain: '',
  key: 'payload-token-key',
  string: 'payload-token-string',
  number: 'payload-token-number',
  boolean: 'payload-token-boolean',
  null: 'payload-token-null',
  punctuation: 'payload-token-punctuation',
}

function linesFor(value: string): string[] {
  return value ? value.split('\n') : ['']
}

export default function PayloadViewer({
  value,
  contentType,
  emptyText = 'No body.',
  className = '',
}: Props) {
  const normalizedContentType = normalizePayloadContentType(contentType)
  const formatted = formatPayload(value, normalizedContentType)
  const body = formatted.value

  if (!body.trim()) {
    return (
      <div className={`payload-viewer payload-viewer-empty ${className}`}>
        <span>{emptyText}</span>
      </div>
    )
  }

  return (
    <div className={`payload-viewer ${className}`}>
      {!formatted.ok ? (
        <div className="payload-viewer-notice">Invalid JSON. Showing raw payload.</div>
      ) : null}
      <div className="payload-pre" aria-label={`${normalizedContentType.toUpperCase()} payload`}>
        {linesFor(body).map((line, lineIndex) => {
          const tokens =
            normalizedContentType === 'json' && formatted.ok
              ? tokenizeJsonLine(line)
              : [{ kind: 'plain' as const, value: line }]

          return (
            <div className="payload-line" key={`${lineIndex}-${line}`}>
              <span className="payload-line-number">{lineIndex + 1}</span>
              <span className="payload-code">
                {tokens.map((token, tokenIndex) => (
                  <span
                    className={TOKEN_CLASS[token.kind]}
                    key={`${lineIndex}-${tokenIndex}-${token.kind}`}
                  >
                    {token.value}
                  </span>
                ))}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
