<script lang="ts">
  /**
   * What sync is doing for the open workspace: the changes waiting to upload, and the latest syncs (since Slinger started)
   * with what each uploaded and downloaded. Live: runs update from `sync:event` `activity`, the waiting list when the
   * pending count changes. Opened from the sync chip's popover (and Ctrl+K).
   */
  import { onMount } from 'svelte'
  import type { SyncActivityItem, SyncRun } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import { tabsStore } from '../requests/tabs.svelte'
  import { CHANGE_LABEL, pendingSummary, runDuration, runSummary, runTime, TYPE_LABEL, triggerLabel } from './activity'
  import { sync } from './syncStore.svelte'

  const status = $derived(sync.current)
  const chip = $derived(sync.chip)
  const ws = $derived(app.workspace)
  /** Runs whose item lists are shown; the newest run with items starts open. */
  let expanded = $state<Record<number, boolean>>({})
  let seeded = false

  onMount(() => {
    void sync.loadActivity()
  })
  $effect(() => {
    if (seeded || sync.activity.length === 0) return
    seeded = true
    const first = sync.activity.find((r) => r.uploadedCount + r.downloadedCount > 0)
    if (first) expanded = { [first.id]: true }
  })

  function close() {
    ui.syncActivityOpen = false
  }

  /** Requests open in a tab; other items have no single place to show. */
  function openable(item: SyncActivityItem): boolean {
    return item.entityType === 'request' && item.change !== 'deleted' && app.requests.some((r) => r.id === item.entityId)
  }
  function open(item: SyncActivityItem) {
    const request = app.requests.find((r) => r.id === item.entityId)
    if (!request) return
    tabsStore.openRequest(request)
    close()
  }

  /** What the user is about to cancel: one waiting change, or all that are listed. */
  let discarding = $state<SyncActivityItem | 'all' | null>(null)
  function discardMessage(target: SyncActivityItem | 'all'): string {
    if (target === 'all') return `Cancel all ${sync.pending.length} waiting changes? Edits go back to the cloud's version, new items are removed and deleted items come back. Nothing is uploaded. This cannot be undone.`
    const name = `${TYPE_LABEL[target.entityType].toLowerCase()} "${target.path.at(-1)}"`
    const container = target.entityType === 'collection' || target.entityType === 'folder' || target.entityType === 'environment'
    if (target.change === 'created') return `Remove the new ${name}${container ? ' and everything created in it' : ''}? It has not been uploaded, so it will be gone. This cannot be undone.`
    if (target.change === 'deleted') return `Bring back the deleted ${name}${container ? ' with what was inside it' : ''}? The cloud keeps it.`
    return `Cancel the change to ${name}? It goes back to the cloud's version and your edit is lost. This cannot be undone.`
  }
  async function confirmDiscard() {
    const target = discarding
    if (!target || !ws) return
    await sync.discardItems(ws.id, target === 'all' ? sync.pending : [target])
  }

  const tone = { created: 'bg-success-soft text-success', updated: 'bg-accent-soft text-fg', deleted: 'bg-danger-soft text-danger' } as const
  const resultTone = (run: SyncRun) => (run.result === 'error' ? 'text-danger' : run.result === 'running' ? 'text-accent-text' : run.conflicts ? 'text-warning' : 'text-muted')
</script>

<Dialog title="Sync activity · {status?.remoteName ?? ws?.name ?? ''}" size="lg" onclose={close}>
  <div class="flex flex-col gap-4 text-sm" data-testid="sync-activity">
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class={chip.busy ? 'animate-spin' : ''}><Icon name={chip.busy ? 'refresh' : chip.icon} size={13} /></span>
      <span data-testid="sync-activity-status">{chip.label}<span class="text-muted">{` · ${chip.detail}`}</span></span>
      <span class="flex-1"></span>
      {#if status?.linked}
        <Button size="sm" icon="refresh" loading={chip.busy} disabled={status.state === 'signedOut' || status.state === 'accessRevoked' || status.state === 'serverUnsupported'} onclick={() => ws && sync.syncNow(ws.id)}>Sync now</Button>
      {/if}
      <InfoTip label="About sync activity">
        Waiting to upload: changes made on this device that the cloud does not have yet; they go up with the next sync. Cancel one (or all) to keep it from going up: an edit goes back to the cloud's version, a new item is removed, a deleted item comes back. Recent syncs: what each
        sync since Slinger started sent and received, item by item (the list is not kept after Slinger quits). Changes from other people or devices
        arrive as downloads; who made them is not shown yet. Secret values never sync.
      </InfoTip>
    </div>

    <section aria-labelledby="sync-pending-h" class="flex flex-col gap-1.5">
      <h3 id="sync-pending-h" class="text-xs font-semibold text-muted">
        Waiting to upload{sync.pending.length ? ` (${sync.pending.length}: ${pendingSummary(sync.pending)})` : ''}
        {#if sync.pending.length > 1}
          <button type="button" class="ml-2 font-normal text-danger hover:underline disabled:opacity-50" data-testid="sync-discard-all" disabled={!!sync.busy[ws?.id ?? '']} onclick={() => (discarding = 'all')}>Cancel all</button>
        {/if}
      </h3>
      {#if sync.pending.length === 0}
        <p class="text-xs text-muted" data-testid="sync-pending-empty">{sync.activityLoading ? 'Loading…' : 'Nothing: everything on this device is in the cloud.'}</p>
      {:else}
        <ul class="max-h-48 overflow-auto rounded border border-border" data-testid="sync-pending">
          {#each sync.pending as item (`${item.entityType}:${item.entityId}`)}
            <li class="border-b border-border last:border-b-0">{@render itemRow(item, true)}</li>
          {/each}
        </ul>
      {/if}
    </section>

    <section aria-labelledby="sync-runs-h" class="flex min-h-0 flex-col gap-1.5">
      <h3 id="sync-runs-h" class="text-xs font-semibold text-muted">Recent syncs</h3>
      {#if sync.activity.length === 0}
        <p class="text-xs text-muted" data-testid="sync-runs-empty">{sync.activityLoading ? 'Loading…' : 'No sync since Slinger started.'}</p>
      {:else}
        <ul class="max-h-96 overflow-auto rounded border border-border" data-testid="sync-runs">
          {#each sync.activity as run (run.id)}
            {@const items = run.uploadedCount + run.downloadedCount}
            <li class="border-b border-border last:border-b-0" data-testid="sync-run">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                aria-expanded={items > 0 ? !!expanded[run.id] : undefined}
                disabled={items === 0}
                onclick={() => (expanded = { ...expanded, [run.id]: !expanded[run.id] })}
              >
                <span class="w-3 shrink-0 text-muted">{#if items > 0}<Icon name={expanded[run.id] ? 'chevron-down' : 'chevron-right'} size={12} />{/if}</span>
                <span class="w-28 shrink-0 tabular-nums text-muted">{runTime(run.startedAt)}</span>
                <span class="w-24 shrink-0 text-muted">{triggerLabel(run)}</span>
                <span class="min-w-0 flex-1 truncate {resultTone(run)}" data-testid="sync-run-summary">{runSummary(run)}</span>
                {#if runDuration(run)}<span class="shrink-0 tabular-nums text-faint">{runDuration(run)}</span>{/if}
              </button>
              {#if run.error}<p class="px-7 pb-1.5 text-xs text-danger">{run.error}</p>{/if}
              {#if expanded[run.id] && items > 0}
                <div class="flex flex-col gap-2 px-7 pb-2" data-testid="sync-run-items">
                  {#if run.uploadedCount > 0}{@render itemList('Uploaded', 'upload', run.uploaded, run.uploadedCount)}{/if}
                  {#if run.downloadedCount > 0}{@render itemList('Downloaded', 'download', run.downloaded, run.downloadedCount)}{/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
  {#snippet footer()}
    <Button onclick={close}>Close</Button>
  {/snippet}
</Dialog>

{#if discarding}
  <ConfirmDialog
    title={discarding === 'all' ? 'Cancel all waiting changes' : discarding.change === 'deleted' ? 'Bring back deleted item' : 'Cancel change'}
    message={discardMessage(discarding)}
    confirmLabel={discarding !== 'all' && discarding.change === 'deleted' ? 'Bring back' : 'Cancel change'}
    danger={discarding === 'all' || discarding.change !== 'deleted'}
    onconfirm={confirmDiscard}
    oncancel={() => (discarding = null)}
  />
{/if}

{#snippet itemList(title: string, icon: 'upload' | 'download', list: SyncActivityItem[], count: number)}
  <div>
    <p class="mb-0.5 flex items-center gap-1 text-xs font-medium"><Icon name={icon} size={12} />{title} ({count})</p>
    <ul class="rounded border border-border">
      {#each list as item, i (i)}
        <li class="border-b border-border last:border-b-0">{@render itemRow(item)}</li>
      {/each}
    </ul>
    {#if count > list.length}<p class="mt-0.5 text-xs text-muted">… and {count - list.length} more</p>{/if}
  </div>
{/snippet}

{#snippet itemRow(item: SyncActivityItem, cancellable = false)}
  <div class="flex min-w-0 items-center gap-2 px-2 py-1 text-xs" data-testid="sync-item">
    <span class="w-14 shrink-0 rounded px-1 text-center text-[10px] font-medium {tone[item.change]}">{CHANGE_LABEL[item.change]}</span>
    <span class="w-24 shrink-0 truncate text-muted">{TYPE_LABEL[item.entityType]}</span>
    {#if openable(item)}
      <button type="button" class="min-w-0 truncate text-left text-accent-text hover:underline" title="Open {item.path.join(' / ')}" onclick={() => open(item)}>
        {@render pathText(item.path)}
      </button>
    {:else}
      <span class="min-w-0 truncate" title={item.path.join(' / ')}>{@render pathText(item.path)}</span>
    {/if}
    {#if cancellable}
      <span class="flex-1"></span>
      <button
        type="button"
        class="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-hover hover:text-danger disabled:opacity-50"
        title={item.change === 'deleted' ? 'Bring it back; the cloud keeps it' : item.change === 'created' ? 'Remove it; it was never uploaded' : 'Go back to the cloud version'}
        data-testid="sync-discard"
        disabled={!!sync.busy[ws?.id ?? '']}
        onclick={() => (discarding = item)}
      >{item.change === 'deleted' ? 'Restore' : 'Cancel'}</button>
    {/if}
  </div>
{/snippet}

{#snippet pathText(path: string[])}
  {#if path.length > 1}<span class="text-muted">{`${path.slice(0, -1).join(' / ')} / `}</span>{/if}<span class="font-medium">{path.at(-1)}</span>
{/snippet}
