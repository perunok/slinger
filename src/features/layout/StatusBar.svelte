<script lang="ts">
  /**
   * The thin bar at the bottom of the window. Left: cloud sync state of the open workspace (opens the conflict center
   * when there are conflicts, else the Cloud dialog), the active environment (opens the Environments dialog) and
   * background activity (collection runs, which it reopens, and sends). Right: the active request tab's last response,
   * then layout toggles.
   * Hidden with the "Show status bar" setting / View > Toggle Status Bar.
   */
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import ContextMenu, { type MenuItem } from '../../components/ui/ContextMenu.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { formatBytes, formatDuration, statusTone } from '../../lib/response'
  import { tabsStore } from '../requests/tabs.svelte'
  import { summarize } from '../runner/runner'
  import { runsStore, runSummaryText } from '../runner/runs.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import ResponsePositionButton from './ResponsePositionButton.svelte'
  import type { Snippet } from 'svelte'

  /** Extra controls at the right end (the right-panel toggle). */
  let { end }: { end?: Snippet } = $props()

  const chip = $derived(sync.chip)
  const syncTone = $derived(
    { neutral: 'text-muted', success: 'text-success', warning: 'text-warning', danger: 'text-danger', accent: 'text-accent-text' }[chip.tone],
  )
  function openSync() {
    if (chip.conflicts > 0) ui.conflictsOpen = true
    else ui.cloudOpen = true
  }

  const environment = $derived(app.environments.find((e) => e.id === app.activeEnvironmentId) ?? null)

  const sending = $derived(tabsStore.tabs.filter((t) => t.sending).length)
  const activityText = $derived(sending > 1 ? `Sending ${sending} requests…` : sending === 1 ? 'Sending…' : '')

  // Collection runs going on, and finished ones whose results were not opened yet (they ran in the background).
  const runs = $derived(runsStore.attention)
  const runningRuns = $derived(runs.filter((r) => r.running))
  const runText = $derived.by(() => {
    if (runningRuns.length === 1) {
      const r = runningRuns[0]!
      return `Running ${r.label}… ${r.state.completed}/${r.state.rows.length}`
    }
    if (runningRuns.length > 1) {
      const done = runningRuns.reduce((n, r) => n + r.state.completed, 0)
      const total = runningRuns.reduce((n, r) => n + r.state.rows.length, 0)
      return `${runningRuns.length} runs… ${done}/${total}`
    }
    if (runs.length === 1) return `Run finished: ${runs[0]!.label}`
    return runs.length > 1 ? `${runs.length} runs finished` : ''
  })
  const runsFailed = $derived(runningRuns.length === 0 && runs.some((r) => summarize(r.state).failed > 0))
  const runItems = $derived<MenuItem[]>(
    runs.map((r) => ({
      label: r.running ? `${r.label}: ${r.state.completed}/${r.state.rows.length}` : `${r.label}: ${runSummaryText(r.state)}`,
      icon: r.running ? 'refresh' : summarize(r.state).failed > 0 ? 'x' : 'check',
      action: () => runsStore.open(r),
    })),
  )
  let runMenu = $state<{ x: number; y: number } | null>(null)
  function openRuns(e: MouseEvent) {
    if (runs.length === 1) {
      runsStore.open(runs[0]!)
      return
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    runMenu = { x: rect.left, y: rect.top }
  }

  /** The last response of the active request tab (not overviews or examples, whose response is a saved one). */
  const tab = $derived(tabsStore.active && !tabsStore.active.overview && !tabsStore.active.example ? tabsStore.active : null)
  const response = $derived(tab && !tab.sending ? (tab.response?.data ?? null) : null)
  const failed = $derived(tab && !tab.sending && !tab.response && tab.error ? tab.error.message : null)
  const responseTone = $derived(
    response ? { success: 'text-success', info: 'text-fg', warning: 'text-warning', danger: 'text-danger' }[statusTone(response.status)] : '',
  )

  const item = 'flex h-5 min-w-0 items-center gap-1 rounded px-1.5 hover:bg-hover hover:text-fg'
</script>

<footer aria-label="Status bar" class="flex h-6 shrink-0 items-center gap-1 border-t border-border bg-surface px-1.5 text-[11px] leading-none text-muted" data-testid="status-bar">
  <div class="flex min-w-0 flex-1 items-center gap-1">
    <button
      type="button"
      class="{item} shrink-0 {syncTone}"
      title={chip.detail}
      aria-label="Cloud sync: {chip.label}. {chip.detail}"
      data-testid="status-sync"
      data-kind={chip.kind}
      onclick={openSync}
    >
      <span class={chip.busy ? 'motion-safe:animate-spin' : ''}><Icon name={chip.busy ? 'refresh' : chip.icon} size={12} /></span>
      <span class="truncate">{chip.label}</span>
    </button>
    <button
      type="button"
      class={item}
      title={environment ? `Active environment: ${environment.name} (click to edit environments)` : 'No active environment (click to edit environments)'}
      aria-label={environment ? `Active environment: ${environment.name}` : 'No active environment'}
      aria-haspopup="dialog"
      data-testid="status-env"
      onclick={() => (ui.envEditor = { open: true, environmentId: environment?.id })}
    >
      <Icon name="layers" size={12} />
      <span class="truncate">{environment?.name ?? 'No environment'}</span>
    </button>
    {#if runText}
      <button
        type="button"
        class="{item} {runsFailed ? 'text-danger' : runningRuns.length === 0 ? 'text-success' : ''}"
        title={runs.length > 1 ? 'Collection runs (click to choose one)' : 'Collection run (click to open it)'}
        aria-haspopup={runs.length > 1 ? 'menu' : 'dialog'}
        data-testid="status-runs"
        onclick={openRuns}
      >
        {#if runningRuns.length > 0}
          <span class="motion-safe:animate-spin"><Icon name="refresh" size={12} /></span>
        {:else}
          <Icon name={runsFailed ? 'x' : 'check'} size={12} />
        {/if}
        <span class="truncate">{runText}</span>
      </button>
    {/if}
    <span role="status" class="flex min-w-0 items-center gap-1 px-1.5" data-testid="status-activity">
      {#if activityText}
        <span class="motion-safe:animate-spin"><Icon name="refresh" size={12} /></span>
        <span class="truncate">{activityText}</span>
      {/if}
    </span>
  </div>

  <div class="flex shrink-0 items-center gap-1">
    {#if response}
      <span class="flex items-center gap-1.5 px-1.5" data-testid="status-response" title="Last response of this tab">
        <span class="font-semibold {responseTone}">{response.status} {response.statusText}</span>
        <span aria-hidden="true">·</span>
        <span>{formatDuration(response.durationMs)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatBytes(response.bodyByteLength)}</span>
      </span>
    {:else if failed}
      <span class="max-w-64 truncate px-1.5 text-danger" data-testid="status-response" title={failed}>Not sent</span>
    {/if}
    <ResponsePositionButton variant="bar" />
    {@render end?.()}
  </div>
</footer>

{#if runMenu}
  <ContextMenu x={runMenu.x} y={runMenu.y} items={runItems} onclose={() => (runMenu = null)} />
{/if}
