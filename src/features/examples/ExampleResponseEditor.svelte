<script lang="ts">
  /**
   * The saved response of an example tab: status code/text and language on top, then the existing
   * response viewer (Pretty/Raw/Preview/Headers/Cookies) and editors for the body and headers.
   */
  import { settings } from '../../app/settings.svelte'
  import { toast } from '../../app/toast.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import KeyValueTable from '../../components/kv/KeyValueTable.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import { exampleResponseData, mimeForLanguage, PREVIEW_LANGUAGES, statusReason } from '../../lib/examples'
  import { beautifyJson } from '../../lib/jsonTemplate'
  import { dataRows } from '../../lib/kv'
  import { analyzeResponse, formatBytes } from '../../lib/response'
  import type { ExampleSection, RequestTab } from '../requests/tabs.svelte'
  import ResponseViewer from '../response/ResponseViewer.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const d = $derived(tab.exampleDraft!)
  const responseTime = $derived(tab.example?.responseTime ?? null)
  const data = $derived(exampleResponseData(d, responseTime))
  const mimeHint = $derived(mimeForLanguage(d.language))
  const known = $derived(PREVIEW_LANGUAGES.some((l) => l.id === d.language))

  const tabs = $derived([
    { id: 'response', label: 'Response' },
    { id: 'body', label: 'Edit body' },
    { id: 'headers', label: 'Edit headers', badge: String(dataRows(d.headers).length || '') || undefined },
  ])
  // Editor highlighting: the stored language, else what the body looks like.
  const editorLanguage = $derived.by(() => {
    if (d.language === 'json' || d.language === 'xml' || d.language === 'html' || d.language === 'javascript') return d.language
    if (d.language === 'text') return 'text'
    return analyzeResponse(data, mimeHint).language
  })

  function setCode(text: string) {
    const n = text.trim() === '' ? null : Number(text)
    if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999)) return
    // Keep the reason phrase in step unless the user wrote their own.
    if (d.status === '' || d.status === statusReason(d.code)) d.status = statusReason(n)
    d.code = n
  }

  function beautify() {
    const r = beautifyJson(d.body)
    if (r.ok) d.body = r.text
    else toast.error('Cannot beautify', r.error)
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-surface" role="region" aria-label="Example response">
  <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
    <span class="font-medium text-muted">Saved response</span>
    <label class="flex items-center gap-1 text-muted">
      Status
      <input type="number" min="0" max="999" class="h-7 w-20 !py-0" aria-label="Status code" value={d.code ?? ''} oninput={(e) => setCode(e.currentTarget.value)} />
    </label>
    <input type="text" class="h-7 w-44 !py-0" aria-label="Status text" placeholder="Status text" value={d.status} oninput={(e) => (d.status = e.currentTarget.value)} />
    <label class="ml-auto flex items-center gap-1 text-muted">
      Language
      <select class="h-7 !py-0" aria-label="Body language" value={d.language} onchange={(e) => (d.language = e.currentTarget.value)}>
        <option value="">Auto</option>
        {#each PREVIEW_LANGUAGES as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
        {#if d.language && !known}<option value={d.language}>{d.language}</option>{/if}
      </select>
    </label>
  </div>
  <Tabs {tabs} value={tab.exampleSection} onchange={(v) => (tab.exampleSection = v as ExampleSection)} label="Example response views" idPrefix="exresp" class="px-2" />
  <div class="min-h-0 flex-1" role="tabpanel" id="exresp-panel-{tab.exampleSection}" aria-labelledby="exresp-{tab.exampleSection}">
    {#if tab.exampleSection === 'response'}
      <ResponseViewer {data} {mimeHint} showTiming={responseTime !== null} view={tab.responseView} onviewchange={(v) => (tab.responseView = v)} />
    {:else if tab.exampleSection === 'body'}
      {#if d.bodyEncoding === 'base64'}
        <div class="p-4 text-sm">
          <p class="font-medium">Binary body</p>
          <p class="mt-1 text-muted">
            This example stores {formatBytes(data.bodyByteLength)} of binary data as base64 (shown under Response). It cannot be edited as text.
          </p>
          <Button class="mt-3" size="sm" onclick={() => ((d.body = ''), (d.bodyEncoding = null))}>Replace with an empty text body</Button>
        </div>
      {:else}
        <div class="flex h-full min-h-0 flex-col">
          {#if editorLanguage === 'json'}
            <div class="flex items-center justify-end border-b border-border px-2 py-1">
              <Button size="sm" onclick={beautify} disabled={!d.body.trim()}>Beautify</Button>
            </div>
          {/if}
          <div class="min-h-0 flex-1">
            <CodeEditor value={d.body} onchange={(v) => (d.body = v)} language={editorLanguage} wrap={settings.editorWrap} fold label="Example response body" />
          </div>
        </div>
      {/if}
    {:else}
      <div class="h-full overflow-auto p-3">
        <KeyValueTable rows={d.headers} onchange={(rows) => (d.headers = rows)} noun="Response header" keyPlaceholder="Header" suggestions="headers" />
      </div>
    {/if}
  </div>
</div>
