<script lang="ts">
  /**
   * Collection / folder overview tab: name, location, what it contains, and its documentation (Postman
   * `description`, Markdown) rendered by default with Edit / Split. Saving (button or Ctrl+S) stores the text
   * on the collection/folder; it is kept on this device and exported to Postman, but not synced in v1.
   */
  import type { ApiFolder } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import DocsEditor from '../../components/markdown/DocsEditor.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { formatOfType } from '../../lib/description'
  import { folderPath } from '../../lib/scripts'
  import { isDescendantFolder } from '../../lib/tree'
  import { methodColor } from '../requests/method'
  import { overviewEntity, tabsStore, type RequestTab } from '../requests/tabs.svelte'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'

  let { tab }: { tab: RequestTab } = $props()

  const target = $derived(tab.overview!)
  const entity = $derived(overviewEntity(target))
  const collectionId = $derived(target.kind === 'collection' ? target.id : ((entity as ApiFolder | undefined)?.collectionId ?? tab.collectionId))
  const collection = $derived(app.collections.find((c) => c.id === collectionId))
  const stored = $derived(entity?.description ?? '')
  const value = $derived(tab.overviewDraft ?? stored)

  /** Folders and requests inside (recursively for folders). */
  const contents = $derived.by(() => {
    if (!collectionId) return { folders: 0, requests: [] as typeof app.requests }
    const folders = app.foldersOf(collectionId)
    const inside = (folderId: string | null) =>
      target.kind === 'collection' || (folderId !== null && isDescendantFolder(folders, target.id, folderId))
    return {
      folders: folders.filter((f) => f.id !== target.id && inside(f.id)).length,
      requests: app.requestsOf(collectionId).filter((r) => inside(r.folderId)),
    }
  })
  const methods = $derived.by(() => {
    const counts = new Map<string, number>()
    for (const r of contents.requests) counts.set(r.method, (counts.get(r.method) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  })
  const parents = $derived(target.kind === 'folder' && entity ? folderPath(app.foldersOf(collectionId ?? ''), (entity as ApiFolder).parentFolderId) : [])

  function onchange(v: string) {
    tab.overviewDraft = v === stored ? null : v
  }
  function save() {
    if (!sync.blocked) void tabsStore.save(tab)
  }
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
</script>

<div id="request-panel" role="tabpanel" aria-labelledby="rtab-{tab.id}" class="flex min-h-0 flex-1 flex-col" data-testid="overview-view">
  {#if !entity}
    <div class="m-auto max-w-sm p-6 text-center text-sm text-muted" data-testid="overview-gone">
      <p>This {target.kind} no longer exists.</p>
      {#if tab.overviewDraft}<p class="mt-1">Your unsaved documentation is still in this tab; copy it before closing.</p>{/if}
      <Button class="mt-3" onclick={() => tabsStore.closeNow([tab.id])}>Close tab</Button>
    </div>
  {:else}
    <header class="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
      <span class="mt-0.5 rounded bg-accent-soft p-1.5 text-fg"><Icon name={target.kind === 'collection' ? 'layers' : 'folder'} size={18} /></span>
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center gap-1 text-xs text-muted">
          <span class="uppercase tracking-wide">{target.kind}</span>
          {#if target.kind === 'folder' && collection}
            <span aria-hidden="true">·</span>
            <button type="button" class="truncate rounded px-1 hover:bg-hover hover:text-fg" onclick={() => tabsStore.openOverview({ kind: 'collection', id: collection.id })}>{collection.name}</button>
            {#each parents as p (p.id)}
              <span aria-hidden="true">/</span>
              <button type="button" class="truncate rounded px-1 hover:bg-hover hover:text-fg" onclick={() => tabsStore.openOverview({ kind: 'folder', id: p.id })}>{p.name}</button>
            {/each}
          {/if}
        </div>
        <h2 class="truncate text-lg font-semibold" data-testid="overview-title">{entity.name}</h2>
        <p class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" data-testid="overview-stats">
          <span>{plural(contents.requests.length, 'request')}</span>
          {#if contents.folders > 0}<span>{plural(contents.folders, 'folder')}</span>{/if}
          {#each methods as [m, n] (m)}
            <span class="font-semibold" style="color:{methodColor(m)}">{m} <span class="font-normal text-faint">{n}</span></span>
          {/each}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-1.5">
        {#if collectionId}
          <Button size="sm" icon="play" onclick={() => (ui.runner = { collectionId: collectionId!, folderId: target.kind === 'folder' ? target.id : null })}>Run</Button>
        {/if}
        <Button size="sm" icon="code" onclick={() => (ui.scriptsFor = { kind: target.kind, id: target.id })}>Scripts</Button>
        {#if target.kind === 'collection'}
          <Button size="sm" icon="tag" onclick={() => (ui.versionsFor = target.id)}>Versions</Button>
        {/if}
        <Button
          size="sm"
          variant="primary"
          icon="save"
          loading={tab.saving}
          disabled={!tab.dirty || sync.blocked}
          title={sync.blocked ? sync.blockedMessage : 'Save documentation (Ctrl+S)'}
          onclick={save}
        >Save</Button>
      </div>
    </header>
    {#if sync.blocked}<ReadOnlyNote class="mx-3 mt-2" />{/if}
    <DocsEditor
      {value}
      {onchange}
      format={formatOfType(entity.descriptionType)}
      readOnly={sync.blocked}
      readOnlyReason={sync.blockedMessage}
      mode={tab.docsMode}
      onmodechange={(m) => (tab.docsMode = m)}
      label="{target.kind === 'collection' ? 'Collection' : 'Folder'} documentation"
      idPrefix="ov-{tab.id}"
      hint="Kept on this device and exported to Postman · not synced to the cloud yet"
      class="min-h-0 flex-1"
    />
  {/if}
</div>
