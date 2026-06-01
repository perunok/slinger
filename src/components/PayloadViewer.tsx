import React, { useEffect, useRef } from 'react'
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
  editable?: boolean
  onChange?: (v: string) => void
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
  editable = false,
  onChange,
}: Props) {
  const normalizedContentType = normalizePayloadContentType(contentType)
  const formatted = formatPayload(value, normalizedContentType)
  const body = formatted.value
  const editorRef = useRef<HTMLDivElement | null>(null)

  function escapeHtml(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  if (!body.trim()) {
    return (
      <div className={`payload-viewer payload-viewer-empty ${className}`}>
        <span>{emptyText}</span>
      </div>
    )
  }

  const isEditable = editable || typeof onChange === 'function'

  if (isEditable) {
    useEffect(() => {
      if (!editorRef.current) return

      const html = linesFor(body)
        .map((line, lineIndex) => {
          const tokens =
            normalizedContentType === 'json' && formatted.ok
              ? tokenizeJsonLine(line)
              : [{ kind: 'plain' as const, value: line }]

          const tokenHtml = tokens
            .map((token) => `<span class="${TOKEN_CLASS[token.kind]}">${escapeHtml(token.value)}</span>`)
            .join('')

          return `<div class="payload-line"><span class="payload-line-number" contenteditable="false">${lineIndex + 1}</span><span class="payload-code">${tokenHtml}</span></div>`
        })
        .join('')

      const el = editorRef.current
      el.innerHTML = html
    }, [body, contentType, formatted.ok])

    function extractTextFromEditor(): string {
      const root = editorRef.current
      if (!root) return ''
      const lines = Array.from(root.querySelectorAll('.payload-line')) as HTMLElement[]
      if (lines.length > 0) {
        return lines.map((line) => line.querySelector('.payload-code')?.textContent ?? '').join('\n')
      }
      return root.textContent ?? ''
    }

    function handleInput(e: React.FormEvent<HTMLDivElement>) {
      const text = extractTextFromEditor()
      onChange?.(text)
    }

    function handleCopy(e: React.ClipboardEvent<HTMLDivElement>) {
      e.preventDefault()
      const text = extractTextFromEditor()
      e.clipboardData.setData('text/plain', text)
    }

    function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
      e.preventDefault()
      const pasted = e.clipboardData.getData('text/plain')
      const cleaned = pasted
        .split('\n')
        .map((l) => l.replace(/^\s*\d+\s*/, ''))
        .join('\n')
      onChange?.(cleaned)
    }

    return (
      <div className={`payload-viewer ${className}`}>
        {!formatted.ok ? (
          <div className="payload-viewer-notice">Invalid JSON. Showing raw payload.</div>
        ) : null}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={handleInput}
          className="payload-pre"
          role="textbox"
          aria-label={`${normalizedContentType.toUpperCase()} payload editor`}
        />
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
