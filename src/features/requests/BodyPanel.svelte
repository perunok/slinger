<script lang="ts">
  import { settings } from '../../app/settings.svelte'
  import { toast } from '../../app/toast.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import KeyValueTable from '../../components/kv/KeyValueTable.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { beautifyJson, checkJson } from '../../lib/jsonTemplate'
  import { RAW_LANGUAGES, type BodyKind, type RawLanguage } from '../../lib/request'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const b = $derived(tab.draft.body)

  const MODES: { id: BodyKind; label: string }[] = [
    { id: 'none', label: 'none' },
    { id: 'formData', label: 'form-data' },
    { id: 'urlEncoded', label: 'x-www-form-urlencoded' },
    { id: 'raw', label: 'raw' },
    { id: 'binary', label: 'binary' },
  ]
  const editorLang = $derived(b.rawLanguage === 'text' ? 'text' : b.rawLanguage)
  const jsonCheck = $derived(b.kind === 'raw' && b.rawLanguage === 'json' ? checkJson(b.raw) : null)

  function beautify() {
    const r = beautifyJson(b.raw)
    if (r.ok) tab.draft.body.raw = r.text
    else toast.error('Cannot beautify', r.error)
  }

  async function pickBinary() {
    try {
      const p = await api().pickFile({ title: 'Choose a file to send as the request body' })
      if (p) tab.draft.body.binaryPath = p
    } catch (e) {
      toast.error('Could not open the file picker', errorInfo(e).message)
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col p-3">
  <div role="radiogroup" aria-label="Body type" class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
    {#each MODES as m (m.id)}
      <label class="flex cursor-pointer items-center gap-1.5 text-sm">
        <input type="radio" name="body-mode-{tab.id}" checked={b.kind === m.id} onchange={() => (tab.draft.body.kind = m.id)} />
        {m.label}
      </label>
    {/each}
    {#if b.kind === 'unsupported'}
      <span class="text-sm text-warning">unsupported type (kept as-is)</span>
    {/if}
    {#if b.kind === 'raw'}
      <select
        aria-label="Raw body language"
        class="ml-auto h-7 !py-0"
        value={b.rawLanguage}
        onchange={(e) => (tab.draft.body.rawLanguage = e.currentTarget.value as RawLanguage)}
      >
        {#each RAW_LANGUAGES as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
      </select>
      {#if b.rawLanguage === 'json'}
        <Button size="sm" onclick={beautify} disabled={!b.raw.trim()}>Beautify</Button>
      {/if}
    {/if}
  </div>

  {#if b.kind === 'none'}
    <p class="py-6 text-center text-sm text-muted">This request does not have a body.</p>
  {:else if b.kind === 'raw'}
    <div class="min-h-40 flex-1 overflow-hidden rounded border border-border">
      <CodeEditor
        value={b.raw}
        onchange={(v) => (tab.draft.body.raw = v)}
        language={editorLang}
        wrap={settings.editorWrap}
        templates
        fold
        label="Request body"
        placeholder={b.rawLanguage === 'json' ? '{ "key": "value" }' : ''}
      />
    </div>
    {#if jsonCheck}
      <p class="mt-1 text-xs {jsonCheck.ok ? 'text-success' : 'text-danger'}" role={jsonCheck.ok ? undefined : 'alert'}>
        {jsonCheck.ok ? (b.raw.trim() ? 'Valid JSON' : '') : `Invalid JSON: ${jsonCheck.error}`}
      </p>
    {/if}
  {:else if b.kind === 'formData'}
    <div class="overflow-auto">
      <KeyValueTable rows={b.formData} onchange={(rows) => (tab.draft.body.formData = rows)} noun="Field" fileFields keyPlaceholder="Key" />
    </div>
  {:else if b.kind === 'urlEncoded'}
    <div class="overflow-auto">
      <KeyValueTable rows={b.urlEncoded} onchange={(rows) => (tab.draft.body.urlEncoded = rows)} noun="Field" duplicates="exact" />
    </div>
  {:else if b.kind === 'binary'}
    <div class="flex items-center gap-3 py-2">
      <Button icon="upload" onclick={pickBinary}>{b.binaryPath ? 'Change file' : 'Choose file'}</Button>
      <span class="min-w-0 truncate text-sm {b.binaryPath ? '' : 'text-muted'}" title={b.binaryPath}>{b.binaryPath || 'No file selected'}</span>
      {#if b.binaryPath}<Button size="sm" variant="ghost" onclick={() => (tab.draft.body.binaryPath = '')}>Clear</Button>{/if}
    </div>
    <p class="text-xs text-faint">The selected file is sent as the raw request body when you send the request.</p>
  {:else}
    <p class="rounded border border-warning bg-warning-soft px-3 py-2 text-sm">
      This request has a body type Slinger cannot edit. It is preserved when saving; pick another type above to replace it.
    </p>
  {/if}
</div>
