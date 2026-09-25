<script lang="ts">
  /** console.log/info/warn/error output of the last send's scripts. Kept in memory only; Clear empties it. */
  import IconButton from '../../components/ui/IconButton.svelte'
  import type { ScriptConsoleEntry, ScriptConsoleLevel } from '../../../shared/types'

  let { entries, onclear }: { entries: ScriptConsoleEntry[]; onclear?: () => void } = $props()

  let level = $state<'all' | ScriptConsoleLevel>('all')
  const shown = $derived(entries.filter((e) => level === 'all' || e.level === level))
  const TONE: Record<ScriptConsoleLevel, string> = {
    log: 'text-muted',
    info: 'text-accent',
    warn: 'text-warning',
    error: 'text-danger',
  }
  const time = (ms: number) => {
    const d = new Date(ms)
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="console-view">
  <div class="flex items-center gap-2 border-b border-border px-3 py-1 text-xs">
    <label for="console-level" class="text-muted">Level</label>
    <select id="console-level" class="h-6 py-0 text-xs" bind:value={level}>
      <option value="all">All</option>
      <option value="log">Log</option>
      <option value="info">Info</option>
      <option value="warn">Warn</option>
      <option value="error">Error</option>
    </select>
    <span class="text-muted">{entries.length} message{entries.length === 1 ? '' : 's'}</span>
    {#if onclear}<span class="ml-auto"><IconButton icon="trash" label="Clear console" disabled={entries.length === 0} onclick={onclear} /></span>{/if}
  </div>
  <div class="min-h-0 flex-1 overflow-auto font-mono text-xs">
    {#if shown.length === 0}
      <p class="p-4 font-sans text-sm text-muted">{entries.length ? 'No messages at this level.' : 'No console output. Use console.log() in a script.'}</p>
    {:else}
      <ol aria-label="Console output">
        {#each shown as e, i (i)}
          <li class="flex gap-2 border-b border-border px-3 py-1" data-level={e.level}>
            <span class="shrink-0 text-faint">{time(e.timestamp)}</span>
            <span class="w-10 shrink-0 uppercase {TONE[e.level]}">{e.level}</span>
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-words {e.level === 'error' ? 'text-danger' : e.level === 'warn' ? 'text-warning' : 'text-fg'}">{e.message}</span>
            <span class="hidden shrink-0 font-sans text-faint md:inline" title={e.source}>{e.source}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</div>
