<script lang="ts" module>
  export type ResponseTabId = 'pretty' | 'raw' | 'preview' | 'headers' | 'cookies'
</script>

<script lang="ts">
  /** Full response view for a received HttpResponseData: chips, toolbar and Pretty/Raw/Preview/Headers/Cookies. */
  import type { Snippet } from 'svelte'
  import type { HttpResponseData } from '../../../shared/types'
  import { settings } from '../../app/settings.svelte'
  import { toast } from '../../app/toast.svelte'
  import type CodeEditor from '../../components/editor/CodeEditor.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { saveExport } from '../../lib/exportFile'
  import { suggestFileName } from '../../lib/hex'
  import { analyzeResponse, formatBytes, formatDuration, parseSetCookies, statusTone, textToBase64 } from '../../lib/response'
  import BodyView from './BodyView.svelte'
  import CookiesTable from './CookiesTable.svelte'
  import HeadersTable from './HeadersTable.svelte'

  interface Props {
    data: HttpResponseData
    view?: ResponseTabId
    onviewchange?: (v: ResponseTabId) => void
    /** Body type to assume when there is no Content-Type header (saved examples' preview language). */
    mimeHint?: string
    /** Hide the time chip (saved examples usually have no timing). */
    showTiming?: boolean
    /** Extra toolbar content, before the icon buttons. */
    actions?: Snippet
  }
  let { data, view = 'pretty', onviewchange, mimeHint = '', showTiming = true, actions }: Props = $props()

  const info = $derived(analyzeResponse(data, mimeHint))
  const cookieCount = $derived(parseSetCookies(data.headers).length)
  const tone = $derived(statusTone(data.status))
  let wrap = $state(settings.editorWrap)
  let showAll = $state(false)
  let editor = $state<CodeEditor | undefined>()

  // A new response resets "show all" so a previous huge body does not force slow rendering.
  $effect(() => {
    void data
    showAll = false
  })

  const tabs = $derived([
    { id: 'pretty', label: 'Pretty' },
    { id: 'raw', label: 'Raw' },
    { id: 'preview', label: 'Preview' },
    { id: 'headers', label: 'Headers', badge: String(data.headers.length) },
    { id: 'cookies', label: 'Cookies', badge: cookieCount ? String(cookieCount) : undefined },
  ])
  const bodyMode = $derived(view === 'raw' || view === 'preview' ? view : 'pretty')
  const toneClass = $derived(
    { success: 'bg-success-soft text-success', info: 'bg-accent-soft text-fg', warning: 'bg-warning-soft text-warning', danger: 'bg-danger-soft text-danger' }[tone],
  )

  async function copyBody() {
    const text = info.text ?? ''
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Response body copied')
    } catch {
      toast.error('Could not copy', 'Clipboard access was denied.')
    }
  }

  async function saveBody() {
    const contentDisposition = data.headers.find((h) => h.key.toLowerCase() === 'content-disposition')?.value
    const name = suggestFileName(info.mime, contentDisposition)
    try {
      const path =
        info.text !== null && info.kind !== 'image' && info.kind !== 'pdf'
          ? await saveExport(name, info.text, 'utf8')
          : await saveExport(name, data.bodyBase64 ?? textToBase64(info.text ?? ''), 'base64')
      toast.success('Response saved', path)
    } catch (e) {
      toast.error('Could not save the response', errorInfo(e).message)
    }
  }

  const canEdit = $derived(view !== 'headers' && view !== 'cookies')
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="response-viewer">
  <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
    <span class="rounded px-2 py-0.5 text-xs font-semibold {toneClass}" data-testid="status-chip">{data.status} {data.statusText}</span>
    {#if showTiming}<span class="rounded bg-raised px-2 py-0.5 text-xs text-muted" data-testid="time-chip" title="Time to complete the request">{formatDuration(data.durationMs)}</span>{/if}
    <span class="rounded bg-raised px-2 py-0.5 text-xs text-muted" data-testid="size-chip" title="Body size">{formatBytes(data.bodyByteLength)}</span>
    {#if info.mime}<span class="hidden rounded bg-raised px-2 py-0.5 text-xs text-faint sm:inline">{info.mime}</span>{/if}
    <div class="ml-auto flex items-center gap-0.5">
      {@render actions?.()}
      <IconButton icon="search" label="Search in response" disabled={!canEdit || info.text === null} onclick={() => editor?.openSearch()} />
      <IconButton icon="wrap" label="Toggle word wrap" active={wrap} onclick={() => (wrap = !wrap)} />
      <IconButton icon="copy" label="Copy response body" disabled={info.text === null} onclick={copyBody} />
      <IconButton icon="download" label="Save response to file" disabled={info.kind === 'empty'} onclick={saveBody} />
    </div>
  </div>
  <Tabs {tabs} value={view} onchange={(v) => onviewchange?.(v as ResponseTabId)} label="Response views" idPrefix="resp" class="px-2" />
  <div class="min-h-0 flex-1" role="tabpanel" id="resp-panel-{view}" aria-labelledby="resp-{view}">
    {#if view === 'headers'}
      <HeadersTable headers={data.headers} />
    {:else if view === 'cookies'}
      <CookiesTable headers={data.headers} />
    {:else}
      <BodyView {info} mode={bodyMode} {wrap} {showAll} onshowall={() => (showAll = true)} bind:editor />
    {/if}
  </div>
</div>
