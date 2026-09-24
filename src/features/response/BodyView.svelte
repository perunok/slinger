<script lang="ts">
  /** Renders a response body for one of the Pretty / Raw / Preview modes. */
  import { onDestroy } from 'svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import { base64ToBytes, dataUrl, formatBytes, LARGE_BODY_BYTES, prettyPrint, truncateForDisplay, type ResponseBodyInfo } from '../../lib/response'
  import { hexDump } from '../../lib/hex'
  import CsvTable from './CsvTable.svelte'
  import Button from '../../components/ui/Button.svelte'

  interface Props {
    info: ResponseBodyInfo
    mode: 'pretty' | 'raw' | 'preview'
    wrap: boolean
    showAll: boolean
    onshowall: () => void
    editor?: CodeEditor | undefined
  }
  let { info, mode, wrap, showAll, onshowall, editor = $bindable() }: Props = $props()

  const isTextual = $derived(info.text !== null && info.kind !== 'image' && info.kind !== 'pdf')
  const big = $derived(isTextual && (info.text?.length ?? 0) > LARGE_BODY_BYTES && !showAll)

  // Pretty-printing is skipped for oversized bodies until "show all" (keeps the UI responsive).
  const pretty = $derived.by(() => {
    if (mode !== 'pretty' || !isTextual || big) return null
    return prettyPrint(info.kind, info.text ?? '')
  })

  const shown = $derived.by(() => {
    if (!isTextual) return { text: '', truncated: false, totalChars: 0 }
    const source = mode === 'pretty' && pretty ? pretty.text : (info.text ?? '')
    return showAll ? { text: source, truncated: false, totalChars: source.length } : truncateForDisplay(source)
  })

  let pdfUrl = $state<string | null>(null)
  $effect(() => {
    const b64 = info.kind === 'pdf' ? info.base64 : null
    if (!b64) {
      pdfUrl = null
      return
    }
    const url = URL.createObjectURL(new Blob([base64ToBytes(b64) as BlobPart], { type: 'application/pdf' }))
    pdfUrl = url
    return () => URL.revokeObjectURL(url)
  })
  onDestroy(() => {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl)
  })

  const hex = $derived(!isTextual && info.base64 ? hexDump(base64ToBytes(info.base64)) : '')
  const useEditorForRaw = $derived(mode === 'raw' && (isTextual || hex !== ''))
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if info.kind === 'empty'}
    <p class="p-4 text-sm text-muted">This response has no body.</p>
  {:else if mode === 'preview' && info.kind === 'html' && info.text !== null}
    <iframe title="HTML preview" sandbox="" srcdoc={info.text} referrerpolicy="no-referrer" class="h-full w-full flex-1 border-0 bg-white"></iframe>
  {:else if mode !== 'raw' && info.kind === 'image' && info.base64}
    <div class="flex h-full items-center justify-center overflow-auto p-4">
      <img src={dataUrl(info.mime, info.base64)} alt="Response body" class="max-h-full max-w-full object-contain" style="background: repeating-conic-gradient(var(--surface-raised) 0% 25%, var(--surface) 0% 50%) 50% / 16px 16px" />
    </div>
  {:else if mode !== 'raw' && info.kind === 'pdf'}
    {#if pdfUrl}
      <iframe title="PDF preview" src={pdfUrl} class="h-full w-full flex-1 border-0"></iframe>
    {:else}
      <p class="p-4 text-sm text-muted">PDF data is unavailable.</p>
    {/if}
  {:else if mode === 'pretty' && info.kind === 'csv' && info.text !== null && !big}
    <CsvTable text={info.text} />
  {:else if mode !== 'raw' && !isTextual}
    <div class="p-6 text-sm">
      <p class="font-medium">Binary response</p>
      <p class="mt-1 text-muted">{info.mime || 'unknown type'} · {formatBytes(info.byteLength)}. Use “Save to file” to keep it, or switch to Raw for a hex preview.</p>
    </div>
  {:else}
    {#if pretty && !pretty.ok}
      <p role="alert" class="border-b border-border bg-warning-soft px-3 py-1 text-xs text-warning">
        Could not pretty-print this {info.kind.toUpperCase()} body: {pretty.error}. Showing it as received.
      </p>
    {/if}
    {#if big || shown.truncated}
      <div class="flex items-center gap-2 border-b border-border bg-warning-soft px-3 py-1 text-xs text-warning">
        <span>Large body ({formatBytes(info.byteLength)}). {big ? 'Formatting and highlighting are off; showing' : 'Showing'} the first {formatBytes(LARGE_BODY_BYTES)}.</span>
        <Button size="sm" onclick={onshowall}>Show all</Button>
      </div>
    {/if}
    <div class="min-h-0 flex-1">
      <CodeEditor
        bind:this={editor}
        value={useEditorForRaw && !isTextual ? hex : shown.text}
        readOnly
        {wrap}
        fold={mode === 'pretty' && (info.kind === 'json' || info.kind === 'xml' || info.kind === 'html') && !big}
        language={mode === 'pretty' && !big && isTextual ? info.language : 'text'}
        label="Response body"
      />
    </div>
  {/if}
</div>
