<script lang="ts">
  /** Top-bar sync status chip. Click opens a small popover: state, last synced, Sync now, auto sync, conflicts. */
  import { onMount } from 'svelte'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { formatAgo } from './status'
  import { sync } from './syncStore.svelte'

  let open = $state(false)
  let btn: HTMLButtonElement | undefined = $state()
  let pop: HTMLDivElement | undefined = $state()

  const chip = $derived(sync.chip)
  const status = $derived(sync.current)
  const ws = $derived(app.workspace)
  const tone = $derived(
    {
      neutral: 'border-border bg-raised text-muted',
      success: 'border-transparent bg-success-soft text-success',
      warning: 'border-transparent bg-warning-soft text-warning',
      danger: 'border-transparent bg-danger-soft text-danger',
      accent: 'border-transparent bg-accent-soft text-fg',
    }[chip.tone],
  )

  function close(refocus = true) {
    open = false
    if (refocus) btn?.focus()
  }
  onMount(() => {
    const down = (e: MouseEvent) => {
      if (open && !pop?.contains(e.target as Node) && !btn?.contains(e.target as Node)) close(false)
    }
    document.addEventListener('mousedown', down, true)
    return () => document.removeEventListener('mousedown', down, true)
  })
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      close()
    }
  }
  $effect(() => {
    if (open) queueMicrotask(() => pop?.querySelector<HTMLElement>('button, input')?.focus())
  })
  const canSync = $derived(!!status?.linked && status.state !== 'signedOut' && status.state !== 'serverUnsupported' && status.state !== 'accessRevoked')
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative" {onkeydown}>
  <button
    bind:this={btn}
    type="button"
    class="flex h-7 items-center gap-1.5 rounded border px-2 text-xs {tone} hover:brightness-95"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Sync status: {chip.label}. {chip.detail}"
    title={chip.detail}
    data-testid="sync-chip"
    data-kind={chip.kind}
    onclick={() => (open = !open)}
  >
    <span class={chip.busy ? 'animate-spin' : ''}><Icon name={chip.busy ? 'refresh' : chip.icon} size={13} /></span>
    <span>{chip.label}</span>
    {#if chip.readOnly && chip.kind !== 'readOnly'}<span title="Read-only" class="text-muted"><Icon name="lock" size={12} /></span>{/if}
    {#if chip.pending > 0 && chip.kind !== 'idle' && chip.kind !== 'offline'}<span class="rounded bg-surface px-1 text-[10px] text-muted" title="{chip.pending} change{chip.pending === 1 ? '' : 's'} waiting to upload">{chip.pending}</span>{/if}
  </button>
  {#if open}
    <div bind:this={pop} role="dialog" aria-label="Sync details" class="absolute left-0 top-full z-40 mt-1 w-80 space-y-2 rounded-md border border-strong bg-surface p-3 text-sm shadow-pop" data-testid="sync-popover">
      <div>
        <p class="font-medium">{status?.linked ? (status.remoteName ?? ws?.name) : ws?.name}</p>
        <p class="text-xs text-muted">{chip.detail}</p>
        {#if status?.linked}<p class="text-xs text-muted">Last synced: {formatAgo(status.lastSyncedAt, sync.now)}</p>{/if}
        {#if status?.lastError && chip.kind !== 'error'}<p class="text-xs text-danger">{status.lastError.message}</p>{/if}
      </div>
      {#if status?.linked}
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" icon="refresh" disabled={!canSync} loading={chip.busy} onclick={() => ws && sync.syncNow(ws.id)}>Sync now</Button>
          <label class="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={status.autoSync} disabled={status.state === 'accessRevoked'} onchange={(e) => ws && sync.setAutoSync(ws.id, e.currentTarget.checked)} />
            Auto sync
          </label>
        </div>
        {#if status.openConflicts > 0}
          <Button size="sm" variant="primary" onclick={() => (close(false), (ui.conflictsOpen = true))}>Review {status.openConflicts} conflict{status.openConflicts === 1 ? '' : 's'}</Button>
        {/if}
      {/if}
      <div class="border-t border-border pt-2">
        <Button size="sm" variant="ghost" icon="cloud" onclick={() => (close(false), (ui.cloudOpen = true))}>{status?.linked ? 'Cloud settings…' : 'Cloud…'}</Button>
      </div>
    </div>
  {/if}
</div>
