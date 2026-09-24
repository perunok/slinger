<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import ContextMenu, { type MenuItem } from '../../components/ui/ContextMenu.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import NameDialog from '../../components/ui/NameDialog.svelte'
  import { planDrop, type DragItem, type DropPosition, type DropTarget } from '../../lib/tree'
  import { tabsStore } from '../requests/tabs.svelte'
  import * as actions from './actions'
  import { buildRows, rowKey, type TreeRowModel } from './rows'
  import TreeRow, { type DropHint } from './TreeRow.svelte'

  const LS_EXPANDED = 'slinger.expanded'
  function loadExpanded(): Set<string> {
    try {
      const raw = localStorage.getItem(LS_EXPANDED)
      if (raw) return new Set(JSON.parse(raw) as string[])
    } catch {
      /* ignore */
    }
    return new Set()
  }
  let expanded = $state(loadExpanded())
  let filter = $state('')
  let focusKey = $state<string | null>(null)
  let menu = $state<{ x: number; y: number; row: TreeRowModel } | null>(null)
  let treeEl: HTMLDivElement

  type Dlg =
    | { t: 'newCollection' }
    | { t: 'newFolder'; collectionId: string; parentId: string | null }
    | { t: 'newRequest'; collectionId: string; folderId: string | null }
    | { t: 'rename'; row: TreeRowModel }
    | { t: 'delete'; row: TreeRowModel }
  let dlg = $state<Dlg | null>(null)

  const rows = $derived(buildRows({ collections: app.collections, folders: app.folders, requests: app.requests, expanded, filter }))
  const activeRequestId = $derived(tabsStore.active?.requestId ?? null)

  function persist() {
    try {
      localStorage.setItem(LS_EXPANDED, JSON.stringify([...expanded]))
    } catch {
      /* ignore */
    }
  }
  function setExpanded(key: string, open: boolean) {
    const next = new Set(expanded)
    if (open) next.add(key)
    else next.delete(key)
    expanded = next
    persist()
  }
  // First run: open the first collection so the tree is not blank.
  let seeded = false
  $effect(() => {
    if (!seeded && app.collections.length > 0) {
      seeded = true
      if (expanded.size === 0) setExpanded(rowKey('collection', app.collections[0].id), true)
    }
  })
  $effect(() => {
    // Keep a valid roving-tabindex target.
    if (!rows.some((r) => r.key === focusKey)) focusKey = rows[0]?.key ?? null
  })

  function focusRow(key: string) {
    focusKey = key
    queueMicrotask(() => treeEl?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus())
  }

  // ---- activation --------------------------------------------------------
  function activate(row: TreeRowModel) {
    if (row.kind === 'request') {
      const r = app.requestById(row.id)
      if (r) tabsStore.openRequest(r)
    }
  }
  function toggle(row: TreeRowModel) {
    setExpanded(row.key, !row.expanded)
    focusKey = row.key
  }

  // ---- menus -------------------------------------------------------------
  function menuItems(row: TreeRowModel): MenuItem[] {
    if (row.kind === 'collection') {
      return [
        { label: 'New request', icon: 'plus', action: () => (dlg = { t: 'newRequest', collectionId: row.id, folderId: null }) },
        { label: 'New folder', icon: 'folder-plus', action: () => (dlg = { t: 'newFolder', collectionId: row.id, parentId: null }) },
        { separator: true, label: '' },
        { label: 'Run collection…', icon: 'play', action: () => (ui.runner = { collectionId: row.id, folderId: null }) },
        { label: 'Versions…', icon: 'tag', action: () => (ui.versionsFor = row.id) },
        { label: 'Export as Postman JSON…', icon: 'download', action: () => (ui.exportCollectionId = row.id) },
        { separator: true, label: '' },
        { label: 'Rename', icon: 'edit', hint: 'F2', action: () => (dlg = { t: 'rename', row }) },
        { label: 'Delete', icon: 'trash', danger: true, hint: 'Del', action: () => (dlg = { t: 'delete', row }) },
      ]
    }
    if (row.kind === 'folder') {
      return [
        { label: 'New request', icon: 'plus', action: () => (dlg = { t: 'newRequest', collectionId: row.collectionId, folderId: row.id }) },
        { label: 'New subfolder', icon: 'folder-plus', action: () => (dlg = { t: 'newFolder', collectionId: row.collectionId, parentId: row.id }) },
        { label: 'Run folder…', icon: 'play', action: () => (ui.runner = { collectionId: row.collectionId, folderId: row.id }) },
        { separator: true, label: '' },
        { label: 'Rename', icon: 'edit', hint: 'F2', action: () => (dlg = { t: 'rename', row }) },
        { label: 'Delete', icon: 'trash', danger: true, hint: 'Del', action: () => (dlg = { t: 'delete', row }) },
      ]
    }
    return [
      { label: 'Open', icon: 'file', hint: 'Enter', action: () => activate(row) },
      { label: 'Duplicate', icon: 'copy', action: () => void duplicate(row) },
      { separator: true, label: '' },
      { label: 'Rename', icon: 'edit', hint: 'F2', action: () => (dlg = { t: 'rename', row }) },
      { label: 'Delete', icon: 'trash', danger: true, hint: 'Del', action: () => (dlg = { t: 'delete', row }) },
    ]
  }

  async function duplicate(row: TreeRowModel) {
    const r = app.requestById(row.id)
    if (!r) return
    await actions.runAction('Duplicate request', async () => {
      const copy = await actions.duplicateRequest(r)
      tabsStore.openRequest(copy)
    })
  }

  // ---- dialogs -----------------------------------------------------------
  async function submitName(name: string) {
    const d = dlg
    if (!d) return
    if (d.t === 'newCollection') {
      const c = await actions.createCollection(name)
      setExpanded(rowKey('collection', c.id), true)
    } else if (d.t === 'newFolder') {
      const f = await actions.createFolder(d.collectionId, d.parentId, name)
      setExpanded(rowKey('collection', d.collectionId), true)
      if (d.parentId) setExpanded(rowKey('folder', d.parentId), true)
      setExpanded(rowKey('folder', f.id), true)
    } else if (d.t === 'newRequest') {
      const r = await actions.createRequest(d.collectionId, d.folderId, name)
      setExpanded(rowKey('collection', d.collectionId), true)
      if (d.folderId) setExpanded(rowKey('folder', d.folderId), true)
      tabsStore.openRequest(r)
    } else if (d.t === 'rename') {
      const { row } = d
      if (row.kind === 'collection') await actions.renameCollection(row.id, name)
      else if (row.kind === 'folder') await actions.renameFolder(row.id, row.collectionId, name)
      else {
        const r = app.requestById(row.id)
        if (r) await actions.renameRequest(r, name)
      }
    }
  }

  function deleteMessage(row: TreeRowModel): string {
    if (row.kind === 'request') return `Delete the request “${row.label}”? This cannot be undone.`
    const n = row.count ?? 0
    return `Delete the ${row.kind} “${row.label}” and everything in it (${n} request${n === 1 ? '' : 's'})? This cannot be undone.`
  }
  async function confirmDelete(row: TreeRowModel) {
    if (row.kind === 'collection') await actions.deleteCollection(row.id)
    else if (row.kind === 'folder') await actions.deleteFolder(row.id, row.collectionId)
    else {
      const r = app.requestById(row.id)
      if (r) await actions.deleteRequest(r)
    }
  }

  // ---- keyboard ----------------------------------------------------------
  function onkeydown(e: KeyboardEvent) {
    const idx = rows.findIndex((r) => r.key === focusKey)
    const row = rows[idx]
    if (!row) return
    const go = (i: number) => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, i))]
      if (t) focusRow(t.key)
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        return go(idx + 1)
      case 'ArrowUp':
        e.preventDefault()
        return go(idx - 1)
      case 'Home':
        e.preventDefault()
        return go(0)
      case 'End':
        e.preventDefault()
        return go(rows.length - 1)
      case 'ArrowRight':
        e.preventDefault()
        if (row.expandable && !row.expanded) setExpanded(row.key, true)
        else go(idx + 1)
        return
      case 'ArrowLeft':
        e.preventDefault()
        if (row.expandable && row.expanded && !filter) setExpanded(row.key, false)
        else if (row.parentKey) focusRow(row.parentKey)
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (row.expandable) toggle(row)
        else activate(row)
        return
      case 'F2':
        e.preventDefault()
        dlg = { t: 'rename', row }
        return
      case 'Delete':
        e.preventDefault()
        dlg = { t: 'delete', row }
        return
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return
        e.preventDefault()
        const el = treeEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(row.key)}"]`)
        const r = el?.getBoundingClientRect()
        menu = { x: (r?.left ?? 0) + 24, y: (r?.bottom ?? 0), row }
      }
    }
  }

  // ---- drag & drop ---------------------------------------------------------
  let drag = $state<DragItem | null>(null)
  let hint = $state<DropHint | null>(null)
  let expandTimer: ReturnType<typeof setTimeout> | null = null

  function dropContext() {
    const foldersByCollection = new Map(app.collections.map((c) => [c.id, app.foldersOf(c.id)]))
    const requestsByCollection = new Map(app.collections.map((c) => [c.id, app.requestsOf(c.id)]))
    return { collections: app.collections.map((c) => c.id), foldersByCollection, requestsByCollection }
  }
  function positionFor(e: DragEvent, row: TreeRowModel): DropPosition {
    if (row.kind === 'collection') return 'inside'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = (e.clientY - rect.top) / Math.max(1, rect.height)
    if (row.kind === 'folder') return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside'
    return y < 0.5 ? 'before' : 'after'
  }
  const targetOf = (row: TreeRowModel): DropTarget => (row.kind === 'collection' ? { kind: 'collection', collectionId: row.id } : { kind: row.kind, id: row.id })

  function clearExpandTimer() {
    if (expandTimer) clearTimeout(expandTimer)
    expandTimer = null
  }
  function onDragStart(e: DragEvent, row: TreeRowModel) {
    if (row.kind === 'collection') return e.preventDefault()
    drag = { kind: row.kind, id: row.id }
    e.dataTransfer?.setData('text/plain', row.label)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  }
  function onDragOver(e: DragEvent, row: TreeRowModel) {
    if (!drag) return
    const position = positionFor(e, row)
    const plan = planDrop(dropContext(), drag, targetOf(row), position)
    if (plan && 'blocked' in plan) {
      hint = { key: row.key, position, blocked: plan.blocked }
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    hint = { key: row.key, position, noop: plan === null }
    if (position === 'inside' && row.expandable && !row.expanded) {
      if (!expandTimer) expandTimer = setTimeout(() => setExpanded(row.key, true), 700)
    } else clearExpandTimer()
  }
  async function onDrop(e: DragEvent, row: TreeRowModel) {
    e.preventDefault()
    const item = drag
    const position = positionFor(e, row)
    endDrag()
    if (!item) return
    const plan = planDrop(dropContext(), item, targetOf(row), position)
    if (plan === null) return
    if ('blocked' in plan) return void toast.error('Cannot move here', plan.blocked)
    const source = item.kind === 'request' ? app.requestById(item.id)?.collectionId : app.folders.find((f) => f.id === item.id)?.collectionId
    const target = plan.kind === 'request' ? plan.input.targetCollectionId : source
    await actions.runAction('Move', () => actions.applyDrop(plan, [source, target].filter((x): x is string => !!x)))
  }
  function endDrag() {
    drag = null
    hint = null
    clearExpandTimer()
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex items-center gap-1 border-b border-border p-2">
    <div class="relative min-w-0 flex-1">
      <label for="tree-filter" class="sr-only">Filter collections</label>
      <input id="tree-filter" type="search" class="w-full" placeholder="Filter…" bind:value={filter} onkeydown={(e) => e.key === 'Escape' && (filter = '')} />
    </div>
    <IconButton icon="plus" label="New collection" onclick={() => (dlg = { t: 'newCollection' })} />
    <IconButton icon="upload" label="Import Postman collection" onclick={() => (ui.importOpen = true)} />
  </div>

  <div
    bind:this={treeEl}
    role="tree"
    aria-label="Collections"
    tabindex="-1"
    class="min-h-0 flex-1 overflow-auto py-1"
    {onkeydown}
    ondragleave={(e) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) hint = null
    }}
  >
    {#each rows as row (row.key)}
      <TreeRow
        {row}
        active={row.kind === 'request' && row.id === activeRequestId}
        focused={row.key === focusKey}
        hint={hint?.key === row.key ? hint : null}
        dragging={drag?.id === row.id && drag?.kind === row.kind}
        ontoggle={() => toggle(row)}
        onactivate={() => activate(row)}
        onfocusrow={() => (focusKey = row.key)}
        oncontextmenu={(e) => {
          e.preventDefault()
          focusKey = row.key
          menu = { x: e.clientX, y: e.clientY, row }
        }}
        ondragstart={(e) => onDragStart(e, row)}
        ondragover={(e) => onDragOver(e, row)}
        ondrop={(e) => onDrop(e, row)}
        ondragend={endDrag}
        ondragleave={clearExpandTimer}
      />
    {/each}
    {#if app.collections.length === 0 && !app.loading}
      <div class="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted">
        <p>No collections yet.</p>
        <Button variant="primary" icon="plus" onclick={() => (dlg = { t: 'newCollection' })}>New collection</Button>
        <Button icon="upload" onclick={() => (ui.importOpen = true)}>Import from Postman</Button>
      </div>
    {:else if rows.length === 0 && filter}
      <p class="px-4 py-6 text-center text-sm text-muted">Nothing matches “{filter}”.</p>
    {/if}
  </div>
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.row)} onclose={() => (menu = null)} />
{/if}

{#if dlg}
  {#if dlg.t === 'newCollection'}
    <NameDialog title="New collection" label="Collection name" submitLabel="Create" onsubmit={submitName} oncancel={() => (dlg = null)} />
  {:else if dlg.t === 'newFolder'}
    <NameDialog title="New folder" label="Folder name" submitLabel="Create" onsubmit={submitName} oncancel={() => (dlg = null)} />
  {:else if dlg.t === 'newRequest'}
    <NameDialog title="New request" label="Request name" initial="New Request" submitLabel="Create" onsubmit={submitName} oncancel={() => (dlg = null)} />
  {:else if dlg.t === 'rename'}
    <NameDialog title="Rename {dlg.row.kind}" label="Name" initial={dlg.row.label} submitLabel="Rename" onsubmit={submitName} oncancel={() => (dlg = null)} />
  {:else if dlg.t === 'delete'}
    {@const row = dlg.row}
    <ConfirmDialog title="Delete {row.kind}" message={deleteMessage(row)} confirmLabel="Delete" danger onconfirm={() => confirmDelete(row)} oncancel={() => (dlg = null)} />
  {/if}
{/if}
