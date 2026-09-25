<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { saveExport } from '../../lib/exportFile'
  import { errorInfo } from '../../lib/ipc'
  import { parseDocument } from '../../lib/request'
  import { formatDuration, statusTone } from '../../lib/response'
  import { slugify } from '../importexport/slugify'
  import { cancelRun, executeDraft, newScriptRun } from '../requests/execute'
  import { testCounts } from '../../lib/scripts'
  import { collectRunItems, CollectionRun, resultsToJson, summarize, type RowStatus, type RunItem, type RunRow, type RunState } from './runner'

  interface Props {
    collectionId: string
    folderId: string | null
    onclose: () => void
  }
  let { collectionId, folderId, onclose }: Props = $props()

  // The session is keyed on the target, so the props are read once.
  const { collection, folder, items } = untrack(() => ({
    collection: app.collections.find((c) => c.id === collectionId),
    folder: folderId ? app.folders.find((f) => f.id === folderId) : null,
    items: collectRunItems(app.foldersOf(collectionId), app.requestsOf(collectionId), folderId) as RunItem[],
  }))
  const workspaceId = app.workspaceId

  let selected = $state<Set<string>>(new Set(items.map((i) => i.id)))
  let delayText = $state('0')
  let stopOnFailure = $state(false)
  let treat3xxAsPass = $state(false)
  let run = $state.raw<CollectionRun | null>(null)
  let view = $state.raw<RunState | null>(null)
  let expanded = $state<Set<string>>(new Set())
  let confirmClose = $state(false)
  let exportError = $state<string | null>(null)

  const delayMs = $derived.by(() => {
    const n = Number(delayText)
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 60000) : 0
  })
  const delayInvalid = $derived(delayText.trim() !== '' && !(Number(delayText) >= 0))
  const running = $derived(view?.phase === 'running')
  const done = $derived(view?.phase === 'done')
  const summary = $derived(view ? summarize(view) : null)
  const title = $derived(`Run ${folder ? `folder "${folder.name}"` : collection ? `"${collection.name}"` : 'collection'}`)

  function start() {
    if (!workspaceId) return
    const chosen = items.filter((i) => selected.has(i.id))
    if (chosen.length === 0) return
    expanded = new Set()
    exportError = null
    // One script context for the whole run: pm.variables set by one request reach the next ones.
    const scriptRun = newScriptRun()
    const r = new CollectionRun(
      chosen,
      { delayMs, stopOnFailure, treat3xxAsPass },
      {
        execute: (item, hooks) =>
          executeDraft(parseDocument(item.request), {
            workspaceId,
            requestId: item.request.id,
            collectionId: item.request.collectionId,
            folderId: item.request.folderId,
            run: scriptRun,
            onRunId: hooks.onRunId,
            wasCancelled: hooks.wasCancelled,
          }),
        cancel: cancelRun,
        onUpdate: (s) => (view = s),
        onItemFinished: () => app.historyTick++,
      },
    )
    run = r
    view = r.state
    void r.start()
  }

  function reset() {
    run = null
    view = null
  }

  function requestClose() {
    if (running) confirmClose = true
    else onclose()
  }

  async function stopAndClose() {
    run?.stop()
    await run?.finished
    onclose()
  }

  // No orphan runs after unmount.
  onDestroy(() => run?.stop())

  function toggle(set: Set<string>, id: string): Set<string> {
    const next = new Set(set)
    if (!next.delete(id)) next.add(id)
    return next
  }

  async function exportResults() {
    if (!view) return
    exportError = null
    try {
      const path = await saveExport(`${slugify(collection?.name ?? 'collection')}.run-results.json`, resultsToJson(collection?.name ?? 'collection', view))
      toast.success('Results exported', path)
    } catch (e) {
      exportError = errorInfo(e).message
    }
  }

  const TONE: Record<string, string> = {
    success: 'bg-success-soft text-success',
    info: 'bg-accent-soft text-fg',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
  }
  const STATUS_LABEL: Record<RowStatus, string> = {
    pending: 'Waiting',
    running: 'Running',
    passed: 'Passed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
  }
  const methodColor = (m: string) => {
    const k = m.toLowerCase()
    return `var(--m-${['get', 'post', 'put', 'patch', 'delete'].includes(k) ? k : 'other'})`
  }
  const rowsToShow = $derived<RunRow[]>(view?.rows ?? [])
</script>

<Dialog {title} onclose={requestClose} size="lg">
  {#if !view}
    <div class="flex flex-col gap-3 text-sm">
      {#if items.length === 0}
        <p class="text-muted">There are no requests to run here.</p>
      {:else}
        <div class="flex items-center justify-between">
          <span class="text-xs text-muted">{selected.size} of {items.length} selected</span>
          <span class="flex gap-1">
            <Button size="sm" onclick={() => (selected = new Set(items.map((i) => i.id)))}>Select all</Button>
            <Button size="sm" onclick={() => (selected = new Set())}>Select none</Button>
          </span>
        </div>
        <ul class="max-h-64 overflow-auto rounded border border-border" aria-label="Requests to run">
          {#each items as item (item.id)}
            <li class="border-b border-border last:border-b-0">
              <label class="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-hover">
                <input type="checkbox" checked={selected.has(item.id)} onchange={() => (selected = toggle(selected, item.id))} />
                <span class="w-14 shrink-0 text-xs font-semibold" style="color: {methodColor(item.method)}">{item.method}</span>
                <span class="truncate">{item.name}</span>
              </label>
            </li>
          {/each}
        </ul>
        <div class="flex flex-wrap items-end gap-4">
          <div class="flex flex-col gap-1">
            <label for="rn-delay" class="text-xs font-medium">Delay between requests (ms)</label>
            <input
              id="rn-delay"
              type="number"
              min="0"
              max="60000"
              bind:value={delayText}
              aria-invalid={delayInvalid || undefined}
              class="h-8 w-32 rounded border bg-raised px-2 text-sm outline-none focus:ring-2 focus:ring-accent {delayInvalid ? 'border-danger' : 'border-border'}"
            />
          </div>
          <label class="flex items-center gap-2 pb-1.5 text-sm">
            <input type="checkbox" bind:checked={stopOnFailure} />
            Stop on first failure
          </label>
          <label class="flex items-center gap-2 pb-1.5 text-sm" title="By default only 2xx passes; a 3xx that redirect-following did not turn into a 2xx fails.">
            <input type="checkbox" bind:checked={treat3xxAsPass} />
            Treat 3xx as pass
          </label>
        </div>
        <p class="text-xs text-muted">A request passes on a 2xx status (redirects are followed first); 3xx, 4xx, 5xx and network errors fail.</p>
        <p class="text-xs text-muted">Requests run one after another exactly like Send: templates, secrets and auth of the active environment apply.</p>
        <p class="text-xs text-muted">Pre-request and test scripts run for every request (collection, folder, then request scripts); variables a script sets are available to the requests after it, and failed tests fail the request.</p>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-3 text-sm">
      <div class="flex items-center gap-3">
        <div class="h-2 flex-1 overflow-hidden rounded bg-raised" role="progressbar" aria-valuemin="0" aria-valuemax={view.rows.length} aria-valuenow={view.completed} aria-label="Run progress">
          <div class="h-full bg-accent transition-all" style="width: {view.rows.length ? (view.completed / view.rows.length) * 100 : 0}%"></div>
        </div>
        <span class="shrink-0 text-xs text-muted" data-testid="progress">{view.completed}/{view.rows.length}</span>
      </div>

      {#if done && summary}
        <div class="rounded border border-border bg-raised px-3 py-2 text-sm" role="status" data-testid="summary">
          <span class="text-success">{summary.passed} passed</span>,
          <span class={summary.failed ? 'text-danger' : 'text-muted'}>{summary.failed} failed</span>,
          <span class="text-muted">{summary.skipped} skipped</span>
          <span class="text-muted"> in {formatDuration(summary.totalMs)}{view.stopped ? ' (stopped)' : ''}</span>
          {#if summary.tests.total > 0}
            <span class="ml-2 border-l border-border pl-2" data-testid="summary-tests">
              Tests: <span class="text-success">{summary.tests.passed} passed</span>,
              <span class={summary.tests.failed ? 'text-danger' : 'text-muted'}>{summary.tests.failed} failed</span>{#if summary.tests.skipped},
                <span class="text-muted">{summary.tests.skipped} skipped</span>{/if}
            </span>
          {/if}
        </div>
      {/if}
      <InlineError message={exportError} />

      <ul class="rounded border border-border" aria-label="Run results">
        {#each rowsToShow as row (row.item.id)}
          {@const open = expanded.has(row.item.id)}
          {@const canOpen = row.status === 'passed' || row.status === 'failed'}
          <li class="border-b border-border last:border-b-0" data-status={row.status}>
            <div class="flex items-center gap-2 px-2 py-1.5">
              <span class="w-4 shrink-0" aria-label={STATUS_LABEL[row.status]} title={STATUS_LABEL[row.status]}>
                {#if row.status === 'running'}
                  <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-muted border-t-transparent"></span>
                {:else if row.status === 'passed'}
                  <span class="text-success"><Icon name="check" size={14} /></span>
                {:else if row.status === 'failed'}
                  <span class="text-danger"><Icon name="x" size={14} /></span>
                {:else}
                  <span class="text-faint"><Icon name="stop" size={12} /></span>
                {/if}
              </span>
              <span class="w-14 shrink-0 text-xs font-semibold" style="color: {methodColor(row.item.method)}">{row.item.method}</span>
              <span class="min-w-0 flex-1 truncate" title={row.item.url}>{row.item.name}</span>
              {#if row.tests.length || row.scriptErrors.length}
                {@const c = testCounts({ tests: row.tests, errors: row.scriptErrors })}
                <span class="rounded px-1.5 py-0.5 text-xs {c.failed ? 'bg-danger-soft text-danger' : 'bg-success-soft text-success'}" data-testid="row-tests" title="Tests passed / total">{c.passed}/{c.total}</span>
              {/if}
              {#if row.statusCode !== null}
                <span class="rounded px-1.5 py-0.5 text-xs font-medium {TONE[statusTone(row.statusCode)]}">{row.statusCode}</span>
              {/if}
              {#if row.durationMs !== null}
                <span class="w-16 shrink-0 text-right text-xs text-muted">{formatDuration(row.durationMs)}</span>
              {/if}
              {#if canOpen}
                <button
                  type="button"
                  class="rounded p-0.5 text-muted hover:bg-hover hover:text-fg"
                  aria-expanded={open}
                  aria-label="{open ? 'Hide' : 'Show'} details for {row.item.name}"
                  onclick={() => (expanded = toggle(expanded, row.item.id))}
                >
                  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                </button>
              {:else}
                <span class="w-5"></span>
              {/if}
            </div>
            {#if row.reason && row.status !== 'passed'}
              <p class="px-2 pb-1.5 pl-[3.25rem] text-xs {row.status === 'failed' ? 'text-danger' : 'text-muted'}">{row.reason}</p>
            {/if}
            {#if open && canOpen}
              <div class="border-t border-border bg-raised px-3 py-2 text-xs">
                {#if row.tests.length || row.scriptErrors.length}
                  <p class="mb-1 font-medium">Tests</p>
                  <ul class="mb-2" aria-label="Tests of {row.item.name}">
                    {#each row.scriptErrors as e, i (i)}<li class="text-danger">Script error ({e.source}): {e.message}</li>{/each}
                    {#each row.tests as t, i (i)}
                      <li class={t.status === 'passed' ? 'text-success' : t.status === 'failed' ? 'text-danger' : 'text-muted'}>
                        {t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '–'} {t.name}{t.error ? `: ${t.error}` : ''}
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if row.console.length}
                  <p class="mb-1 font-medium">Console</p>
                  <pre class="mb-2 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono">{row.console.map((c) => `[${c.level}] ${c.message}`).join('\n')}</pre>
                {/if}
                {#if row.headers.length > 0}
                  <p class="mb-1 font-medium">Response headers</p>
                  <dl class="mb-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 font-mono">
                    {#each row.headers as h, i (i)}
                      <dt class="text-muted">{h.key}</dt>
                      <dd class="break-all">{h.value}</dd>
                    {/each}
                  </dl>
                {/if}
                <p class="mb-1 font-medium">Body{row.bodyTruncated ? ' (first 2 KB)' : ''}</p>
                <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">{row.bodyPreview ?? '(empty)'}</pre>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  {#snippet footer()}
    {#if !view}
      <Button onclick={onclose}>Cancel</Button>
      <Button variant="primary" icon="play" onclick={start} disabled={selected.size === 0 || delayInvalid || !workspaceId} data-autofocus>
        Run {selected.size} request{selected.size === 1 ? '' : 's'}
      </Button>
    {:else if running}
      <Button variant="danger" icon="stop" onclick={() => run?.stop()}>Stop</Button>
    {:else}
      <Button icon="download" onclick={exportResults}>Export results as JSON</Button>
      <Button onclick={reset}>Configure</Button>
      <Button variant="primary" icon="refresh" onclick={start}>Run again</Button>
      <Button onclick={onclose}>Close</Button>
    {/if}
  {/snippet}
</Dialog>

{#if confirmClose}
  <ConfirmDialog
    title="Stop the run?"
    message="A run is in progress. Closing will cancel the request in flight and skip the rest."
    confirmLabel="Stop and close"
    danger
    onconfirm={stopAndClose}
    oncancel={() => (confirmClose = false)}
  />
{/if}
