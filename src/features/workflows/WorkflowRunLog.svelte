<script lang="ts">
  /** The run log under the workflow canvas: problems that stop a run, then every step of the last run. */
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import type { WorkflowRunSession } from './workflowRuns.svelte'

  interface Props {
    session: WorkflowRunSession | null
    problems: Array<{ nodeId: string | null; message: string }>
    onselect: (nodeId: string | null) => void
    onclear: () => void
  }
  let { session, problems, onselect, onclear }: Props = $props()

  const TONE: Record<string, string> = {
    error: 'text-danger',
    output: 'text-fg font-medium',
    console: 'text-muted font-mono',
    info: 'text-muted',
    start: 'text-muted',
    end: 'text-fg',
  }
  const ICON: Record<string, string> = { error: 'alert', output: 'eye', console: 'code', info: 'info', start: 'play', end: 'check' }

  let list: HTMLElement | undefined = $state()
  // Follow the newest entry while running.
  $effect(() => {
    void session?.log.length
    if (session?.running && list) list.scrollTop = list.scrollHeight
  })
</script>

<section class="flex h-44 shrink-0 flex-col border-t border-border bg-surface" aria-label="Run log">
  <div class="flex items-center gap-2 border-b border-border px-3 py-1">
    <h3 class="text-xs font-semibold">Run log</h3>
    {#if session}<span class="text-[11px] text-faint">{new Date(session.startedAt).toLocaleTimeString()}</span>{/if}
    <Button size="sm" variant="ghost" icon="trash" class="ml-auto" disabled={(!session || session.running) && problems.length === 0} onclick={onclear}>Clear</Button>
  </div>
  <ol class="min-h-0 flex-1 overflow-auto py-1 text-xs" bind:this={list} data-testid="wf-run-log">
    {#each problems as p, i (i)}
      <li>
        <button type="button" class="flex w-full items-start gap-2 px-3 py-0.5 text-left text-warning hover:bg-hover" onclick={() => onselect(p.nodeId)}>
          <Icon name="alert" size={12} class="mt-0.5 shrink-0" />{p.message}
        </button>
      </li>
    {/each}
    {#if session}
      {#each session.log as entry (entry.seq)}
        <li>
          <button
            type="button"
            class="flex w-full items-start gap-2 px-3 py-0.5 text-left hover:bg-hover {TONE[entry.kind]}"
            disabled={!entry.nodeId}
            onclick={() => onselect(entry.nodeId)}
          >
            <Icon name={ICON[entry.kind] ?? 'info'} size={12} class="mt-0.5 shrink-0" />
            <span class="min-w-0 break-words">{entry.text}</span>
          </button>
        </li>
      {/each}
    {:else if problems.length === 0}
      <li class="px-3 py-2 text-muted">Run the workflow (Ctrl+Enter) to see each step here.</li>
    {/if}
  </ol>
</section>
