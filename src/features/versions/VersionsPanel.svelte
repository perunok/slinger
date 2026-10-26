<script lang="ts">
  import { onMount } from 'svelte'
  import type { CollectionVersion, CollectionVersionDetail, RestoreCollectionVersionMode } from '../../../shared/types'
  import { expandedStore } from '../../app/expanded.svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import ContextMenu, { type MenuItem } from '../../components/ui/ContextMenu.svelte'
  import { menuPoint } from '../../components/ui/contextMenu'
  import { copyText } from '../../app/clipboard'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { sortVersionsDesc } from '../../lib/semver'
  import { tabsStore } from '../requests/tabs.svelte'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import CreateVersionDialog from './CreateVersionDialog.svelte'
  import RestoreDialog from './RestoreDialog.svelte'
  import { mapRestored, remapExpandedKeys } from './restoreRemap'
  import VersionDetail from './VersionDetail.svelte'
  import VersionList from './VersionList.svelte'

  let { collectionId, onclose }: { collectionId: string; onclose: () => void } = $props()

  const collection = $derived(app.collections.find((c) => c.id === collectionId))
  const name = $derived(collection?.name ?? 'Collection')

  let versions = $state<CollectionVersion[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)
  let selectedId = $state<string | null>(null)
  let detail = $state<CollectionVersionDetail | null>(null)
  let detailLoading = $state(false)
  let detailError = $state<string | null>(null)
  let creating = $state(false)
  let restoring = $state(false)
  let deleting = $state(false)
  let detailSeq = 0

  const selected = $derived(versions.find((v) => v.id === selectedId) ?? null)

  let menu = $state<{ x: number; y: number; version: CollectionVersion } | null>(null)
  /** Right-click / Shift+F10 on a version selects it and offers the detail pane's buttons, plus copying the number. */
  function openMenu(id: string, e: MouseEvent | KeyboardEvent) {
    const version = versions.find((v) => v.id === id)
    if (!version) return
    e.preventDefault()
    selectedId = id
    menu = { ...menuPoint(e), version }
  }
  function menuItems(v: CollectionVersion): MenuItem[] {
    return [
      { label: 'Copy version number', icon: 'copy', action: () => void copyText(v.version, 'Version number copied') },
      { separator: true, label: '' },
      { label: 'Restore…', icon: 'history', disabled: sync.blocked, action: () => (restoring = true) },
      { label: 'Delete…', icon: 'trash', danger: true, disabled: sync.blocked, action: () => (deleting = true) },
    ]
  }

  async function reload(select?: string): Promise<void> {
    loading = true
    error = null
    try {
      versions = sortVersionsDesc(await api().listCollectionVersions(collectionId))
      const keep = select ?? selectedId
      selectedId = versions.some((v) => v.id === keep) ? keep : (versions[0]?.id ?? null)
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      loading = false
    }
  }

  async function loadDetail(id: string) {
    const mine = ++detailSeq
    detail = null
    detailError = null
    detailLoading = true
    try {
      const d = await api().getCollectionVersion(id)
      if (mine === detailSeq) detail = d
    } catch (e) {
      if (mine === detailSeq) detailError = errorInfo(e).message
    } finally {
      if (mine === detailSeq) detailLoading = false
    }
  }

  $effect(() => {
    const id = selectedId
    if (id) void loadDetail(id)
    else {
      detailSeq++
      detail = null
    }
  })

  onMount(() => {
    void reload()
  })

  async function create(version: string, notes: string | null) {
    const created = await api().createCollectionVersion({ collectionId, version, notes })
    toast.success(`Created v${created.version}`)
    await reload(created.id)
  }

  async function restore(mode: RestoreCollectionVersionMode) {
    if (!selected) return
    const v = selected
    // A replace keeps the ids of folders/requests that are in the version and gives the rest new ids. Remember the
    // layout and the clean open tabs (reloading closes tabs whose request id vanished) so both can be carried over.
    const before = { folders: app.foldersOf(collectionId).slice(), requests: app.requestsOf(collectionId).slice() }
    const cleanTabs = tabsStore.tabs.filter((t) => t.requestId && !t.example && !t.dirty && before.requests.some((r) => r.id === t.requestId))
    const wasActive = tabsStore.active?.example ? null : (tabsStore.active?.requestId ?? null)
    const openedNames = new Map(cleanTabs.map((t) => [t.requestId!, t.draft.name]))
    await api().restoreCollectionVersion(v.id, mode)
    await app.reloadCollections()
    if (mode === 'replace') carryOverUi(before, openedNames, wasActive)
    toast.success(mode === 'copy' ? `Restored v${v.version} as a new collection` : `Replaced "${name}" with v${v.version}`)
  }

  /** Keeps expanded folders open and offers to reopen tabs whose request came back under a new id. */
  function carryOverUi(
    before: { folders: typeof app.folders; requests: typeof app.requests },
    openedNames: Map<string, string>,
    wasActive: string | null,
  ) {
    const map = mapRestored(before, { folders: app.foldersOf(collectionId), requests: app.requestsOf(collectionId) })
    expandedStore.replace(remapExpandedKeys(expandedStore.keys, map.folders, new Set(before.folders.map((f) => f.id))))
    // Requests that kept their id stay open (the reconcile reloads them); only vanished ones are offered again.
    const reopen = [...openedNames.keys()].map((oldId) => ({ oldId, newId: map.requests.get(oldId) })).filter((x) => x.newId && x.newId !== x.oldId)
    if (reopen.length === 0) return
    const names = reopen.map((x) => openedNames.get(x.oldId)).join(', ')
    toast.offer(
      reopen.length === 1 ? 'Tab closed by the restore' : `${reopen.length} tabs closed by the restore`,
      `${names} ${reopen.length === 1 ? 'was' : 'were'} replaced by the restored ${reopen.length === 1 ? 'request' : 'requests'} of the same name.`,
      {
        label: reopen.length === 1 ? 'Reopen restored request' : 'Reopen restored requests',
        run: () => {
          for (const { oldId, newId } of reopen) {
            const req = app.requestById(newId!)
            if (req) tabsStore.openRequest(req)
          }
          const active = reopen.find((x) => x.oldId === wasActive)
          const activeReq = active ? app.requestById(active.newId!) : null
          if (activeReq) tabsStore.openRequest(activeReq)
        },
      },
    )
  }

  async function remove() {
    if (!selected) return
    const v = selected
    try {
      await api().deleteCollectionVersion(v.id)
    } catch (e) {
      toast.error('Delete version failed', errorInfo(e).message)
      throw e
    }
    toast.success(`Deleted v${v.version}`)
    await reload()
  }
</script>

<Dialog title="Versions: {name}" {onclose} size="xl">
  <div class="flex h-[70vh] min-h-[320px] flex-col gap-2">
    <div class="flex items-center justify-between gap-2">
      <p class="text-xs text-muted">Versions are immutable snapshots of this collection, labelled with a semantic version.</p>
      <Button variant="primary" icon="plus" onclick={() => (creating = true)} disabled={!collection || sync.blocked} title={sync.blocked ? sync.blockedMessage : undefined}>Create version</Button>
    </div>
    <ReadOnlyNote />
    {#if error}
      <div class="flex items-center gap-2"><InlineError message={error} class="flex-1" /><Button size="sm" onclick={() => reload()}>Retry</Button></div>
    {:else if loading && versions.length === 0}
      <div class="flex items-center gap-2 p-4 text-sm text-muted"><span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-muted border-t-transparent" role="status" aria-label="Loading"></span> Loading versions...</div>
    {:else if versions.length === 0}
      <div class="m-auto max-w-md rounded border border-border bg-raised p-4 text-center text-sm text-muted">
        <p class="font-medium text-fg">No versions yet</p>
        <p class="mt-1">
          A version freezes the collection's folders and requests under a semantic version like 1.0.0, so you can compare
          later changes against it or restore it. Create one to mark a known-good state.
        </p>
      </div>
    {:else}
      <!-- minmax(0,1fr) row + min-h-0 cell: keep the detail pane at the grid's height so its tab panel scrolls instead of being clipped -->
      <div class="grid min-h-0 flex-1 grid-cols-[minmax(220px,300px)_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden rounded border border-border">
        <div class="overflow-auto border-r border-border">
          <VersionList {versions} {selectedId} onselect={(id) => (selectedId = id)} onmenu={openMenu} />
        </div>
        <div class="min-h-0 min-w-0">
          {#if selected}
            <VersionDetail
              summary={selected}
              readOnly={sync.blocked}
              {detail}
              loading={detailLoading}
              error={detailError}
              {versions}
              onretry={() => selectedId && loadDetail(selectedId)}
              onrestore={() => (restoring = true)}
              ondelete={() => (deleting = true)}
            />
          {:else}
            <p class="p-4 text-sm text-muted">Select a version to see its details.</p>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</Dialog>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.version)} onclose={() => (menu = null)} />
{/if}

{#if creating}
  <CreateVersionDialog
    existing={versions.map((v) => v.version)}
    requestCount={app.requestsOf(collectionId).length}
    folderCount={app.foldersOf(collectionId).length}
    oncreate={create}
    onclose={() => (creating = false)}
  />
{/if}
{#if restoring && selected}
  <RestoreDialog
    version={selected}
    collectionName={name}
    onrestore={restore}
    oncreateFirst={() => (creating = true)}
    onclose={() => (restoring = false)}
  />
{/if}
{#if deleting && selected}
  <ConfirmDialog
    title="Delete version v{selected.version}?"
    message={`This permanently deletes v${selected.version} and its snapshot. The live collection is not affected.`}
    confirmLabel="Delete version"
    danger
    onconfirm={remove}
    oncancel={() => (deleting = false)}
  />
{/if}
