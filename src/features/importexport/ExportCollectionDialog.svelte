<script lang="ts">
  import { chooseExportFolder, saveExport } from '../../lib/exportFile'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { exportPostmanCollection } from '../../lib/postman'
  import { formatBytes } from '../../lib/response'
  import { slugify } from './slugify'

  const PREVIEW_LINES = 40

  const collection = $derived(app.collections.find((c) => c.id === ui.exportCollectionId) ?? null)
  const json = $derived(
    collection
      ? exportPostmanCollection({ collection, folders: app.foldersOf(collection.id), requests: app.requestsOf(collection.id) })
      : '',
  )
  const bytes = $derived(new TextEncoder().encode(json).length)
  const lines = $derived(json.split('\n'))
  const preview = $derived(lines.slice(0, PREVIEW_LINES).join('\n'))
  const counts = $derived(collection ? { f: app.foldersOf(collection.id).length, r: app.requestsOf(collection.id).length } : { f: 0, r: 0 })

  let busy = $state(false)
  let error = $state<string | null>(null)

  function close() {
    ui.exportCollectionId = null
    error = null
  }

  async function save() {
    if (!collection) return
    busy = true
    error = null
    try {
      const path = await saveExport(`${slugify(collection.name)}.postman_collection.json`, json)
      toast.success('Collection exported', path)
      close()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }

  let folder = $state<string | null>(null)
  async function chooseFolder() {
    error = null
    try {
      folder = (await chooseExportFolder()) ?? folder
    } catch (e) {
      error = errorInfo(e).message
    }
  }

  async function copy() {
    error = null
    try {
      await navigator.clipboard.writeText(json)
      toast.success('Copied to clipboard')
    } catch (e) {
      error = `Could not copy: ${errorInfo(e).message}`
    }
  }
</script>

{#if collection}
  <Dialog title="Export collection" onclose={close} {busy} size="lg">
    <div class="flex flex-col gap-3 text-sm">
      <p>
        <span class="font-medium">{collection.name}</span>
        <span class="text-muted"> as Postman Collection v2.1: {counts.f} folder{counts.f === 1 ? '' : 's'}, {counts.r} request{counts.r === 1 ? '' : 's'}, {formatBytes(bytes)}</span>
      </p>
      <p class="text-xs text-muted">Only saved requests are exported. Unsaved edits in open tabs are not included.</p>
      <InlineError message={error} />
      <pre class="max-h-72 overflow-auto rounded border border-border bg-raised p-2 font-mono text-xs" aria-label="Export preview">{preview}</pre>
      {#if lines.length > PREVIEW_LINES}
        <p class="text-xs text-faint">Showing the first {PREVIEW_LINES} of {lines.length} lines.</p>
      {/if}
    </div>
    {#snippet footer()}
      {#if folder}<span class="mr-auto truncate text-xs text-muted" title={folder}>Folder: {folder}</span>{/if}
      <Button onclick={close} disabled={busy}>Close</Button>
      <Button icon="folder" onclick={chooseFolder} disabled={busy}>Choose folder…</Button>
      <Button icon="copy" onclick={copy} disabled={busy}>Copy to clipboard</Button>
      <Button variant="primary" icon="download" loading={busy} onclick={save}>Save to file</Button>
    {/snippet}
  </Dialog>
{/if}
