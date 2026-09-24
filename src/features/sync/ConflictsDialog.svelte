<script lang="ts">
  /**
   * Conflict center: conflicts grouped by kind on the left (arrow keys / Home / End move, Space selects for
   * bulk actions), the focused conflict on the right with a side-by-side diff and its resolutions.
   */
  import { onMount } from 'svelte'
  import type { SyncResolution } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { errorInfo } from '../../lib/ipc'
  import ConflictCard from './ConflictCard.svelte'
  import { bulkTargets, flatOrder, groupByKind, nextAfterRemoval, pathText, resolutionUi } from './conflictUi'
  import { sync } from './syncStore.svelte'

  let showResolved = $state(false)
  let focusId = $state<string | null>(null)
  let selected = $state<Set<string>>(new Set())
  let bulk = $state<{ resolution: SyncResolution; count: number; skipped: number } | null>(null)
  let listEl: HTMLElement | undefined = $state()

  const conflicts = $derived(sync.conflicts)
  const sections = $derived(groupByKind(conflicts))
  const order = $derived(flatOrder(conflicts))
  const current = $derived(conflicts.find((c) => c.id === focusId) ?? null)
  const openCount = $derived(conflicts.filter((c) => c.status === 'open').length)
  const status = $derived(sync.current)

  onMount(() => void sync.loadConflicts(showResolved))

  $effect(() => {
    // Keep the focused conflict valid as the list changes (resolved/removed).
    if (!order.some((c) => c.id === focusId)) focusId = order[0]?.id ?? null
    const ids = new Set(order.map((c) => c.id))
    if ([...selected].some((id) => !ids.has(id))) selected = new Set([...selected].filter((id) => ids.has(id)))
  })

  function focusItem(id: string | null) {
    focusId = id
    if (id) queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-cid="${CSS.escape(id)}"]`)?.focus())
  }

  function onkeydown(e: KeyboardEvent) {
    const i = order.findIndex((c) => c.id === focusId)
    if (e.key === 'ArrowDown') (e.preventDefault(), focusItem(order[Math.min(order.length - 1, i + 1)]?.id ?? null))
    else if (e.key === 'ArrowUp') (e.preventDefault(), focusItem(order[Math.max(0, i - 1)]?.id ?? null))
    else if (e.key === 'Home') (e.preventDefault(), focusItem(order[0]?.id ?? null))
    else if (e.key === 'End') (e.preventDefault(), focusItem(order[order.length - 1]?.id ?? null))
    else if (e.key === ' ' && focusId && current?.status === 'open') (e.preventDefault(), toggle(focusId))
  }

  function toggle(id: string) {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    selected = next
  }
  const allOpen = $derived(conflicts.filter((c) => c.status === 'open'))
  const allSelected = $derived(allOpen.length > 0 && allOpen.every((c) => selected.has(c.id)))
  function toggleAll() {
    selected = allSelected ? new Set() : new Set(allOpen.map((c) => c.id))
  }

  function afterResolved(id: string) {
    const next = nextAfterRemoval(order, id)
    focusItem(next)
  }

  function askBulk(resolution: SyncResolution) {
    const t = bulkTargets(conflicts, selected, resolution)
    if (t.apply.length === 0) {
      toast.info('Nothing to apply', 'None of the selected conflicts allows that choice.')
      return
    }
    bulk = { resolution, count: t.apply.length, skipped: t.skipped.length }
  }

  async function runBulk(resolution: SyncResolution) {
    const targets = bulkTargets(conflicts, selected, resolution).apply
    let done = 0
    for (const c of targets) {
      try {
        await sync.resolve({ conflictId: c.id, resolution })
        done++
      } catch (e) {
        toast.error(`Stopped after ${done} of ${targets.length}`, `${c.label}: ${errorInfo(e).message}`)
        break
      }
    }
    selected = new Set()
    if (done > 0) toast.success(`Resolved ${done} conflict${done === 1 ? '' : 's'}`)
    await sync.loadConflicts(showResolved)
  }

  const bulkMessage = (b: NonNullable<typeof bulk>) =>
    b.resolution === 'keep_local'
      ? `Keep MY version for ${b.count} conflict${b.count === 1 ? '' : 's'}? Cloud values (or cloud deletions) for these items will be overwritten.${b.skipped ? `\n${b.skipped} selected conflict${b.skipped === 1 ? '' : 's'} cannot be resolved this way and will be skipped.` : ''}`
      : `Use the CLOUD version for ${b.count} conflict${b.count === 1 ? '' : 's'}? Your local values for these items will be replaced or discarded.${b.skipped ? `\n${b.skipped} selected conflict${b.skipped === 1 ? '' : 's'} cannot be resolved this way and will be skipped.` : ''}`

  async function discardAll() {
    if (app.workspaceId) await sync.discardPending(app.workspaceId)
  }
</script>

<Dialog title="Sync conflicts" size="xl" onclose={() => (ui.conflictsOpen = false)}>
  <div class="flex min-h-[26rem] flex-col gap-3 md:flex-row">
    <section class="flex w-full shrink-0 flex-col gap-2 md:w-72" aria-label="Conflict list">
      <div class="flex items-center justify-between gap-2 text-xs text-muted">
        <span role="status">{openCount} open</span>
        <label class="flex items-center gap-1"><input type="checkbox" bind:checked={showResolved} onchange={() => sync.loadConflicts(showResolved)} /> Show resolved</label>
      </div>
      {#if allOpen.length > 1}
        <div class="flex flex-wrap items-center gap-1.5 rounded border border-border bg-raised p-1.5" role="group" aria-label="Bulk actions">
          <label class="flex items-center gap-1 text-xs"><input type="checkbox" checked={allSelected} onchange={toggleAll} /> All</label>
          <span class="text-xs text-muted" aria-live="polite">{selected.size} selected</span>
          <Button size="sm" disabled={selected.size === 0} onclick={() => askBulk('keep_local')}>Keep mine</Button>
          <Button size="sm" disabled={selected.size === 0} onclick={() => askBulk('keep_remote')}>Use cloud</Button>
        </div>
      {/if}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div bind:this={listEl} class="min-h-0 flex-1 overflow-auto rounded border border-border" {onkeydown} role="group" aria-label="Conflicts by kind">
        {#if sync.conflictsLoading && conflicts.length === 0}
          <div class="flex justify-center p-6"><Spinner /></div>
        {:else if conflicts.length === 0}
          <p class="p-4 text-sm text-muted" data-testid="no-conflicts">No conflicts. Everything that can sync is in sync.</p>
        {/if}
        {#each sections as sec (sec.kind)}
          <h4 class="sticky top-0 z-10 border-b border-border bg-raised px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{sec.title} ({sec.items.length})</h4>
          <ul>
            {#each sec.items as c (c.id)}
              <li class="flex items-start gap-1.5 border-b border-border px-1.5 py-1 {c.id === focusId ? 'bg-accent-soft' : ''}">
                {#if c.status === 'open'}
                  <input type="checkbox" class="mt-1" aria-label="Select {c.label}" checked={selected.has(c.id)} onchange={() => toggle(c.id)} tabindex="-1" />
                {:else}<span class="w-4"></span>{/if}
                <button
                  type="button"
                  data-cid={c.id}
                  tabindex={c.id === focusId ? 0 : -1}
                  aria-current={c.id === focusId ? 'true' : undefined}
                  class="min-w-0 flex-1 rounded px-1 py-0.5 text-left text-sm hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  onclick={() => (focusId = c.id)}
                  onfocus={() => (focusId = c.id)}
                >
                  <span class="block truncate font-medium">{c.label}</span>
                  <span class="block truncate text-[11px] text-muted">{pathText(c.path.slice(0, -1), '')}{c.status !== 'open' ? ' (resolved)' : ''}</span>
                </button>
              </li>
            {/each}
          </ul>
        {/each}
      </div>
      <p class="text-[11px] text-faint">Arrow keys move, Space selects, Tab goes to the details.</p>
    </section>

    <section class="min-w-0 flex-1 overflow-auto md:pl-2" aria-label="Conflict details" aria-live="polite">
      {#if current}
        {#key current.id}
          <ConflictCard conflict={current} onresolved={() => afterResolved(current.id)} />
        {/key}
      {:else if conflicts.length === 0 && !sync.conflictsLoading}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
          <p>Nothing to resolve.</p>
        </div>
      {/if}
    </section>
  </div>
  {#snippet footer()}
    {#if status && status.pendingChanges > 0}
      <span class="mr-auto text-xs text-muted">{status.pendingChanges} local change{status.pendingChanges === 1 ? '' : 's'} not uploaded yet.</span>
      <Button variant="danger" size="sm" onclick={discardAll} title="Reset every unsynced local change and conflict to the cloud version">Discard local changes</Button>
    {/if}
    <Button onclick={() => (ui.conflictsOpen = false)}>Close</Button>
  {/snippet}
</Dialog>

{#if bulk}
  {@const b = bulk}
  <ConfirmDialog
    title="Resolve {b.count} conflict{b.count === 1 ? '' : 's'}"
    message={bulkMessage(b)}
    confirmLabel={resolutionUi('edit_edit', b.resolution).label}
    danger
    onconfirm={() => runBulk(b.resolution)}
    oncancel={() => (bulk = null)}
  />
{/if}
