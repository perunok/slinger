<script lang="ts">
  /**
   * The thin bar at the bottom of the window. Left: cloud sync state of the open workspace (opens the conflict center
   * when there are conflicts, else the Cloud dialog), the active environment (opens the Environments dialog) and
   * background activity (sends, a collection run). Right: the active request tab's last response, then layout toggles.
   * Hidden with the "Show status bar" setting / View > Toggle Status Bar.
   */
  import { activity } from '../../app/activity.svelte'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { formatBytes, formatDuration, statusTone } from '../../lib/response'
  import { tabsStore } from '../requests/tabs.svelte'
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
  const activityText = $derived(
    activity.runner
      ? `Running ${activity.runner.label}… ${activity.runner.done}/${activity.runner.total}`
      : sending > 1
        ? `Sending ${sending} requests…`
        : sending === 1
          ? 'Sending…'
          : '',
  )

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
