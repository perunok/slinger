<script lang="ts">
  import type { CollectionVersion, CollectionVersionDetail } from '../../../shared/types'
  import { chooseExportFolder, saveExport } from '../../lib/exportFile'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { exportPostmanCollection } from '../../lib/postman'
  import { formatBytes } from '../../lib/response'
  import { buildSlingerBlock, latestVersion } from '../../lib/slingerExport'
  import { collectionExportFileName } from './fileName'

  const PREVIEW_LINES = 40

  const collection = $derived(app.collections.find((c) => c.id === ui.exportCollectionId) ?? null)
  const folders = $derived(collection ? app.foldersOf(collection.id) : [])
  const requests = $derived(collection ? app.requestsOf(collection.id) : [])
  // A primitive, so reloading the collection list (new object, same id) does not reload the history.
  const collectionId = $derived(collection?.id ?? null)

  // The version history (with snapshots) is loaded when the dialog opens; saving waits for it.
  let versions = $state.raw<CollectionVersionDetail[] | null>(null)
  let loadError = $state<string | null>(null)
  let appVersion = $state('unknown')
  let includeSnapshots = $state(true)

  $effect(() => {
    const id = collectionId
    versions = null
    loadError = null
    includeSnapshots = true
    if (!id) return
    let stale = false
    void (async () => {
      try {
        const [list, version] = await Promise.all([api().listCollectionVersions(id), api().getAppVersion().catch(() => 'unknown')])
        const details = await Promise.all(list.map((v: CollectionVersion) => api().getCollectionVersion(v.id)))
        if (stale) return
        appVersion = version
        versions = details
      } catch (e) {
        if (!stale) loadError = `Could not load the version history: ${errorInfo(e).message}`
      }
    })()
    return () => {
      stale = true
    }
  })

  const latest = $derived(versions ? latestVersion(versions) : null)
  const fileName = $derived(collection ? collectionExportFileName(collection.name, latest) : '')

  function build(withSnapshots: boolean): string {
    if (!collection) return ''
    // While the history loads the preview shows the content without it (saving is disabled until it is loaded).
    const slinger = buildSlingerBlock({ collectionId: collection.id, versions: versions ?? [], includeSnapshots: withSnapshots, appVersion })
    return exportPostmanCollection({ collection, folders, requests, version: latest, slinger })
  }
  const metadataJson = $derived(build(false))
  const fullJson = $derived(build(true))
  const json = $derived(includeSnapshots ? fullJson : metadataJson)

  const size = (text: string) => new TextEncoder().encode(text).length
  const bytes = $derived(size(json))
  const snapshotBytes = $derived(size(fullJson) - size(metadataJson))
  // The preview never shows snapshots (they would fill it); the saved file has them when the box is ticked.
  const lines = $derived(metadataJson.split('\n'))
  const preview = $derived(lines.slice(0, PREVIEW_LINES).join('\n'))
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  let busy = $state(false)
  let error = $state<string | null>(null)

  function close() {
    ui.exportCollectionId = null
    error = null
  }

  async function save() {
    if (!collection || !versions) return
    busy = true
    error = null
    try {
      const path = await saveExport(fileName, json)
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
    if (!versions) return
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
        <span class="text-muted">
          as Postman Collection v2.1: {plural(folders.length, 'folder')}, {plural(requests.length, 'request')}{versions ? `, ${formatBytes(bytes)}` : ''}
        </span>
      </p>
      <p class="text-xs text-muted">Only saved requests are exported. Unsaved edits in open tabs are not included.</p>
      <InlineError message={loadError ?? error} />
      {#if !versions && !loadError}
        <p class="flex items-center gap-2 text-xs text-muted"><Spinner /> Loading version history…</p>
      {:else if versions}
        <div class="rounded border border-border p-2" data-testid="export-history">
          {#if versions.length === 0}
            <p class="text-xs text-muted">This collection has no versions yet, so the file name has no version number.</p>
          {:else}
            <p class="text-xs">
              Version history: {plural(versions.length, 'version')}, latest <span class="font-medium">v{latest}</span>. It travels inside the file
              (<code>info._slinger</code>, which Postman ignores) and is restored when the file is imported into Slinger.
            </p>
            <label class="mt-2 flex items-start gap-2">
              <input type="checkbox" bind:checked={includeSnapshots} class="mt-0.5" />
              <span>
                Include version history snapshots
                <span class="block text-xs text-muted" data-testid="export-snapshot-size">
                  {#if includeSnapshots}
                    Snapshots add about {formatBytes(snapshotBytes)}, so every version can be restored and compared after import.
                  {:else}
                    Only the version list (number, notes, date) is exported, about {formatBytes(snapshotBytes)} smaller. Slinger cannot
                    restore these versions on import.
                  {/if}
                </span>
              </span>
            </label>
          {/if}
        </div>
      {/if}
      <p class="text-xs text-muted">File: <span class="font-mono text-fg" data-testid="export-file-name">{fileName}</span></p>
      <pre class="max-h-72 overflow-auto rounded border border-border bg-raised p-2 font-mono text-xs" aria-label="Export preview">{preview}</pre>
      {#if lines.length > PREVIEW_LINES || (includeSnapshots && versions && versions.length > 0)}
        <p class="text-xs text-faint">
          {#if lines.length > PREVIEW_LINES}Showing the first {PREVIEW_LINES} of {lines.length} lines.{/if}
          {#if includeSnapshots && versions && versions.length > 0}Version snapshots are not shown in the preview.{/if}
        </p>
      {/if}
    </div>
    {#snippet footer()}
      {#if folder}<span class="mr-auto truncate text-xs text-muted" title={folder}>Folder: {folder}</span>{/if}
      <Button onclick={close} disabled={busy}>Close</Button>
      <Button icon="folder" onclick={chooseFolder} disabled={busy}>Choose folder…</Button>
      <Button icon="copy" onclick={copy} disabled={busy || !versions}>Copy to clipboard</Button>
      <Button variant="primary" icon="download" loading={busy} disabled={!versions} onclick={save}>Save to file</Button>
    {/snippet}
  </Dialog>
{/if}
