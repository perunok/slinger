<script lang="ts">
  import {
    type PayloadContentType,
    type PayloadTokenKind,
    formatPayload,
    normalizePayloadContentType,
    tokenizeJsonLine,
  } from '../lib/payloadFormatters'

  export let value: string
  export let contentType: PayloadContentType | string
  export let emptyText = 'No body.'
  export let className = ''
  export let editable = false
  export let onChange: ((value: string) => void) | undefined = undefined

  const TOKEN_CLASS: Record<PayloadTokenKind, string> = {
    plain: '',
    key: 'payload-token-key',
    string: 'payload-token-string',
    number: 'payload-token-number',
    boolean: 'payload-token-boolean',
    null: 'payload-token-null',
    punctuation: 'payload-token-punctuation',
  }

  let editorRef: HTMLDivElement | undefined

  function linesFor(payload: string): string[] {
    return payload ? payload.split('\n') : ['']
  }

  function escapeHtml(payload: string): string {
    return payload
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function editorHtml(): string {
    return linesFor(body)
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
  }

  function extractTextFromEditor(): string {
    if (!editorRef) return ''
    const lines = Array.from(editorRef.querySelectorAll('.payload-line')) as HTMLElement[]

    if (lines.length > 0) {
      return lines.map((line) => line.querySelector('.payload-code')?.textContent ?? '').join('\n')
    }

    return editorRef.textContent ?? ''
  }

  function tokensFor(line: string) {
    return normalizedContentType === 'json' && formatted.ok
      ? tokenizeJsonLine(line)
      : [{ kind: 'plain' as const, value: line }]
  }

  function handleInput() {
    onChange?.(extractTextFromEditor())
  }

  function handleCopy(event: ClipboardEvent) {
    event.preventDefault()
    event.clipboardData?.setData('text/plain', extractTextFromEditor())
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault()
    const pasted = event.clipboardData?.getData('text/plain') ?? ''
    const cleaned = pasted
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\s*/, ''))
      .join('\n')
    onChange?.(cleaned)
  }

  $: normalizedContentType = normalizePayloadContentType(contentType)
  $: formatted = formatPayload(value, normalizedContentType)
  $: body = formatted.value
  $: isEditable = editable || typeof onChange === 'function'
  $: if (isEditable && editorRef && body.trim()) {
    const html = editorHtml()
    if (editorRef.innerHTML !== html) {
      editorRef.innerHTML = html
    }
  }
</script>

{#if !body.trim()}
  <div class={`payload-viewer payload-viewer-empty ${className}`}>
    <span>{emptyText}</span>
  </div>
{:else if isEditable}
  <div class={`payload-viewer ${className}`}>
    {#if !formatted.ok}
      <div class="payload-viewer-notice">Invalid JSON. Showing raw payload.</div>
    {/if}
    <div
      bind:this={editorRef}
      contenteditable="true"
      on:input={handleInput}
      on:copy={handleCopy}
      on:paste={handlePaste}
      class="payload-pre"
      role="textbox"
      aria-label={`${normalizedContentType.toUpperCase()} payload editor`}
    ></div>
  </div>
{:else}
  <div class={`payload-viewer ${className}`}>
    {#if !formatted.ok}
      <div class="payload-viewer-notice">Invalid JSON. Showing raw payload.</div>
    {/if}
    <div class="payload-pre" aria-label={`${normalizedContentType.toUpperCase()} payload`}>
      {#each linesFor(body) as line, lineIndex (`${lineIndex}-${line}`)}
        <div class="payload-line">
          <span class="payload-line-number">{lineIndex + 1}</span>
          <span class="payload-code">
            {#each tokensFor(line) as token, tokenIndex (`${lineIndex}-${tokenIndex}-${token.kind}`)}
              <span class={TOKEN_CLASS[token.kind]}>{token.value}</span>
            {/each}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}
