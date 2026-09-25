<script lang="ts">
  /** Test results of the last send: counts, a pass/fail filter and one row per pm.test (plus script errors). */
  import Icon from '../../components/ui/Icon.svelte'
  import { testCounts, type ScriptOutput } from '../../lib/scripts'

  let { output }: { output: ScriptOutput } = $props()

  type Filter = 'all' | 'passed' | 'failed' | 'skipped'
  let filter = $state<Filter>('all')
  const counts = $derived(testCounts(output))
  const rows = $derived(output.tests.filter((t) => filter === 'all' || t.status === filter))
  const scriptErrors = $derived(filter === 'passed' || filter === 'skipped' ? [] : output.errors)
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="tests-view">
  <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
    <span data-testid="tests-summary">
      <span class="font-medium text-success">{counts.passed} passed</span>,
      <span class="font-medium {counts.failed ? 'text-danger' : 'text-muted'}">{counts.failed} failed</span>{#if counts.skipped},
        <span class="text-muted">{counts.skipped} skipped</span>{/if}
    </span>
    <div class="ml-auto flex gap-0.5" role="radiogroup" aria-label="Show tests">
      {#each ['all', 'passed', 'failed', 'skipped'] as f (f)}
        <label class="cursor-pointer rounded px-2 py-0.5 has-[:checked]:bg-accent-soft has-[:checked]:text-fg has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent text-muted hover:text-fg">
          <input type="radio" class="sr-only" name="tests-filter" value={f} checked={filter === f} onchange={() => (filter = f as Filter)} />
          {f[0].toUpperCase() + f.slice(1)}
        </label>
      {/each}
    </div>
  </div>
  <div class="min-h-0 flex-1 overflow-auto">
    {#if output.tests.length === 0 && output.errors.length === 0}
      <p class="p-4 text-sm text-muted">
        {output.scriptCount > 0 ? 'The scripts ran but recorded no tests.' : 'No tests. Add them in the request’s Scripts tab with pm.test().'}
      </p>
    {:else}
      <ul aria-label="Test results" class="text-sm">
        {#each scriptErrors as e, i (i)}
          <li class="flex gap-2 border-b border-border px-3 py-1.5" data-status="error">
            <span class="mt-0.5 text-danger"><Icon name="alert" size={14} /></span>
            <div class="min-w-0">
              <p class="font-medium text-danger">Script error{e.kind === 'timeout' ? ' (timed out)' : e.kind === 'cancelled' ? ' (cancelled)' : ''}</p>
              <p class="break-words font-mono text-xs">{e.message}</p>
              <p class="text-xs text-faint">{e.source}</p>
            </div>
          </li>
        {/each}
        {#each rows as t, i (i)}
          <li class="flex gap-2 border-b border-border px-3 py-1.5" data-status={t.status}>
            <span class="mt-0.5 {t.status === 'passed' ? 'text-success' : t.status === 'failed' ? 'text-danger' : 'text-faint'}" aria-label={t.status}>
              <Icon name={t.status === 'passed' ? 'check' : t.status === 'failed' ? 'x' : 'stop'} size={14} />
            </span>
            <div class="min-w-0">
              <p class="break-words">{t.name}</p>
              {#if t.error}<p class="break-words font-mono text-xs text-danger">{t.error}</p>{/if}
              <p class="text-xs text-faint">{t.source}</p>
            </div>
            <span class="ml-auto shrink-0 text-xs uppercase {t.status === 'passed' ? 'text-success' : t.status === 'failed' ? 'text-danger' : 'text-muted'}">{t.status}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
