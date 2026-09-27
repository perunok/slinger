<script lang="ts">
  import { onMount } from 'svelte'
  import type { ApiRequest, HistoryEntry } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { newDraft } from '../../lib/request'
  import { formatDuration, statusTone } from '../../lib/response'
  import { tabsStore } from '../requests/tabs.svelte'
  import { dayLabel, groupByDay } from './group'

  let entries = $state.raw<HistoryEntry[]>([])
  let loading = $state(true)
  let loadError = $state<string | null>(null)
  let filter = $state('')
  let confirmClear = $state(false)
  let focusId = $state<string | null>(null)
  let listEl: HTMLElement | undefined = $state()
  let seq = 0

  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return entries
    return entries.filter((e) => `${e.method} ${e.url} ${e.requestName ?? ''} ${e.statusCode ?? ''} ${e.errorMessage ?? ''}`.toLowerCase().includes(q))
  })
  const groups = $derived(groupByDay(shown, new Date()))
  const flat = $derived(groups.flatMap((g) => g.entries))

  async function load(silent = false) {
    const ws = app.workspaceId
    const mySeq = ++seq
    if (!ws) {
      entries = []
      loading = false
      return
    }
    if (!silent) loading = true
    try {
      const rows = await api().listHistory(ws, 200)
      if (mySeq !== seq) return
      entries = rows
      loadError = null
    } catch (e) {
      if (mySeq !== seq) return
      loadError = errorInfo(e).message
    } finally {
      if (mySeq === seq) loading = false
    }
  }

  let first = true
  $effect(() => {
    void app.workspaceId
    void app.historyTick
    // Background refreshes (after a send) should not flash the spinner.
    const silent = !first && entries.length > 0
    first = false
    void load(silent)
  })

  onMount(() => () => void seq++)

  function open(entry: HistoryEntry) {
    const req: ApiRequest | undefined = app.requestById(entry.requestId)
    if (req) tabsStore.openRequest(req)
    else tabsStore.newTab({ draft: newDraft({ method: entry.method, url: entry.url, name: entry.requestName ?? entry.url }) })
  }

  async function remove(entry: HistoryEntry) {
    const before = entries
    const idx = flat.findIndex((e) => e.id === entry.id)
    const next = flat[idx + 1] ?? flat[idx - 1]
    entries = entries.filter((e) => e.id !== entry.id)
    focusId = next?.id ?? null
    queueMicrotask(() => focusRow(focusId))
    try {
      await api().deleteHistoryEntry(entry.id)
    } catch (e) {
      // Roll back only if nothing newer replaced the list meanwhile.
      entries = before
      toast.error('Could not delete history entry', errorInfo(e).message)
    }
  }

  async function clearAll() {
    const ws = app.workspaceId
    if (!ws) return
    await api().clearHistory(ws)
    entries = []
    focusId = null
  }

  function focusRow(id: string | null) {
    if (!id || !listEl) return
    for (const el of listEl.querySelectorAll<HTMLElement>('[data-entry-id]')) {
      if (el.dataset.entryId === id) {
        el.focus()
        return
      }
    }
  }

  function onRowKey(e: KeyboardEvent, entry: HistoryEntry) {
    const i = flat.findIndex((x) => x.id === entry.id)
    const go = (j: number) => {
      const t = flat[Math.max(0, Math.min(flat.length - 1, j))]
      if (!t) return
      focusId = t.id
      focusRow(t.id)
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        go(i + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        go(i - 1)
        break
      case 'Home':
        e.preventDefault()
        go(0)
        break
      case 'End':
        e.preventDefault()
        go(flat.length - 1)
        break
      case 'Enter':
        e.preventDefault()
        open(entry)
        break
      case 'Delete':
        e.preventDefault()
        void remove(entry)
        break
    }
  }

  const rovingId = $derived(flat.some((e) => e.id === focusId) ? focusId : (flat[0]?.id ?? null))

  const TONE: Record<string, string> = {
    success: 'bg-success-soft text-success',
    info: 'bg-accent-soft text-fg',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  }
  const methodColor = (m: string) => {
    const k = m.toLowerCase()
    return `var(--m-${['get', 'post', 'put', 'patch', 'delete'].includes(k) ? k : 'other'})`
  }
  const time = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="History">
  <div class="flex items-center gap-1 border-b border-border p-2">
    <div class="relative min-w-0 flex-1">
      <span class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"><Icon name="search" size={13} /></span>
      <input
        type="search"
        bind:value={filter}
        aria-label="Filter history"
        placeholder="Filter history"
        class="h-7 w-full rounded border border-border bg-raised pl-7 pr-2 text-xs outline-none focus:ring-2 focus:ring-focus"
      />
    </div>
    <Button size="sm" variant="ghost" icon="trash" onclick={() => (confirmClear = true)} disabled={entries.length === 0}>Clear history</Button>
  </div>

  <div class="min-h-0 flex-1 overflow-auto" bind:this={listEl}>
    {#if loading}
      <div class="flex items-center justify-center gap-2 p-6 text-xs text-muted"><Spinner /> Loading history</div>
    {:else if loadError}
      <div class="flex flex-col items-start gap-2 p-3">
        <InlineError message={loadError} class="w-full" />
        <Button size="sm" icon="refresh" onclick={() => load()}>Retry</Button>
      </div>
    {:else if entries.length === 0}
      <p class="p-4 text-center text-xs text-muted">No history yet. Sent requests will appear here.</p>
    {:else if flat.length === 0}
      <p class="p-4 text-center text-xs text-muted">No history matches "{filter}".</p>
    {:else}
      {#each groups as group (group.key)}
        <div role="group" aria-label={dayLabel(group.key, new Date())}>
          <h3 class="sticky top-0 bg-surface px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{dayLabel(group.key, new Date())}</h3>
          <ul>
            {#each group.entries as entry (entry.id)}
              <li class="group relative">
                <div
                  role="button"
                  tabindex={rovingId === entry.id ? 0 : -1}
                  data-entry-id={entry.id}
                  title="{entry.method} {entry.url}"
                  class="flex cursor-pointer flex-col gap-0.5 px-3 py-1.5 pr-9 outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
                  onclick={() => open(entry)}
                  onfocus={() => (focusId = entry.id)}
                  onkeydown={(e) => e.target === e.currentTarget && onRowKey(e, entry)}
                >
                  <div class="flex items-center gap-2">
                    <span class="w-12 shrink-0 text-xs font-semibold" style="color: {methodColor(entry.method)}">{entry.method}</span>
                    <span class="min-w-0 flex-1 truncate text-xs">{entry.url}</span>
                  </div>
                  <div class="flex items-center gap-2 pl-14 text-[11px] text-muted">
                    {#if entry.statusCode !== null}
                      <span class="rounded px-1 font-medium {TONE[statusTone(entry.statusCode)]}">{entry.statusCode}</span>
                    {:else}
                      <span class="truncate rounded bg-danger-soft px-1 text-danger" title={entry.errorMessage ?? 'Failed'}>{entry.errorMessage ?? 'Failed'}</span>
                    {/if}
                    <span>{formatDuration(entry.durationMs)}</span>
                    <span class="ml-auto">{time(entry.createdAt)}</span>
                  </div>
                </div>
                <span class="absolute right-1 top-1.5 hidden group-focus-within:block group-hover:block">
                  <IconButton icon="trash" size={13} label="Delete history entry" tabindex={-1} onclick={() => remove(entry)} />
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
    {/if}
  </div>
</section>

{#if confirmClear}
  <ConfirmDialog
    title="Clear history"
    message="Delete all history entries of this workspace? This cannot be undone."
    confirmLabel="Clear history"
    danger
    onconfirm={clearAll}
    oncancel={() => (confirmClear = false)}
  />
{/if}
