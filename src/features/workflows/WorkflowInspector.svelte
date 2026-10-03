<script lang="ts">
  /** Right side of the workflow editor: the selected node's settings and what it received / sent in the last run. */
  import { app } from '../../app/state.svelte'
  import { settings } from '../../app/settings.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import { pmCompletion } from '../../components/editor/cm/pmCompletion'
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import { DELAY_MAX_MS, NODE_DEFS, nodeTitle, type NodeConfigs, type VariableScope, type WorkflowNode } from '../../lib/workflow/graph'
  import { pretty } from '../../lib/workflow/values'
  import type { NodeRunState } from './workflowRuns.svelte'

  interface Props {
    node: WorkflowNode
    run: NodeRunState | null
    onchange: (node: WorkflowNode) => void
    ondelete: () => void
    onopenrequest: (requestId: string) => void
  }
  let { node, run, onchange, ondelete, onopenrequest }: Props = $props()

  const def = $derived(NODE_DEFS[node.type])
  const completion = [pmCompletion()]
  const set = <T extends WorkflowNode['type']>(patch: Partial<NodeConfigs[T]>) => onchange({ ...node, config: { ...node.config, ...patch } as NodeConfigs[T] })

  /** Requests grouped by collection, for the picker. */
  const groups = $derived(
    app.collections.map((c) => ({ id: c.id, name: c.name, requests: app.requestsOf(c.id).slice().sort((a, b) => a.name.localeCompare(b.name)) })).filter((g) => g.requests.length > 0),
  )
  const cfg = $derived(node.config as never as Record<string, unknown>)
  const requestId = $derived(node.type === 'request' ? (cfg.requestId as string | null) : null)
  const requestMissing = $derived(!!requestId && !app.requestById(requestId))
  const startJsonError = $derived.by(() => {
    if (node.type !== 'start') return null
    const v = (cfg.value as string).trim()
    if (!v) return null
    try {
      JSON.parse(v)
      return null
    } catch {
      return 'Not valid JSON: the run would stop here.'
    }
  })
  const HELP: Record<WorkflowNode['type'], string> = {
    start: 'A run begins at every Start node (top to bottom). It sends the JSON value below, or null when empty.',
    request:
      'Sends a saved request exactly like the Send button: its scripts, the active environment and history included. If the value arriving here is an object, its fields can be used as {{field}} in the request (for example {"id": 7} fills {{id}}). Sends the response ({ status, headers, body, durationMs }) on "response", or { message } on "error" when the request could not be sent; HTTP error statuses still go to "response".',
    evaluate:
      'JavaScript run in the same sandbox as request scripts (pm, require(\'lodash\') and friends, await). `input` is the value that arrived; what you return is sent on (up to 1 MB). A thrown error goes to "error".',
    if: 'A JavaScript expression with `input`. The value goes on unchanged, to "true" or to "false".',
    forEach:
      'An expression giving a list (`input`, or e.g. `input.body.items`). Each item goes to "each item" in turn, and its whole branch finishes before the next; then the list goes to "done".',
    delay: 'Waits, then passes the value on unchanged.',
    setVariable:
      'Stores a value as a variable, then passes the value on unchanged. "This run" (pm.variables) reaches every later request and script of the run; environment and globals are saved. Strings are stored as they are, anything else as JSON.',
    output: 'Shows every value that arrives here, on the node and in the run log.',
  }
</script>

<div class="flex h-full min-h-0 flex-col" aria-label="Node settings">
  <div class="flex items-center gap-2 border-b border-border px-3 py-2">
    <Icon name={def.icon} size={14} class="text-accent-text" />
    <h3 class="min-w-0 flex-1 truncate text-sm font-semibold">{nodeTitle(node)}</h3>
    <InfoTip label="About {def.label}">{HELP[node.type]}</InfoTip>
  </div>
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 text-sm">
    <label class="grid gap-1">
      <span class="text-xs text-muted">Name on the canvas</span>
      <input
        value={node.title ?? ''}
        placeholder={def.label}
        maxlength="200"
        class="h-7 rounded border border-border bg-raised px-2 text-sm outline-none focus:ring-2 focus:ring-focus"
        oninput={(e) => onchange({ ...node, title: e.currentTarget.value || undefined })}
      />
    </label>

    {#if node.type === 'start'}
      <div class="grid gap-1">
        <span class="text-xs text-muted" id="wf-start-value">Value (JSON)</span>
        <CodeEditor value={cfg.value as string} onchange={(v) => set<'start'>({ value: v })} language="json" label="Start value" lineNumbers={false} class="h-28 rounded border border-border" placeholder={'{ "userId": 7 }'} />
        {#if startJsonError}<p class="text-xs text-danger">{startJsonError}</p>{/if}
      </div>
    {:else if node.type === 'request'}
      <label class="grid gap-1">
        <span class="text-xs text-muted">Request</span>
        <select
          class="h-7 rounded border border-border bg-raised px-1 text-sm"
          value={requestMissing ? '' : (requestId ?? '')}
          onchange={(e) => set<'request'>({ requestId: e.currentTarget.value || null })}
        >
          <option value="">{requestMissing ? 'Deleted request: choose another' : 'Choose a request…'}</option>
          {#each groups as g (g.id)}
            <optgroup label={g.name}>
              {#each g.requests as r (r.id)}<option value={r.id}>{r.method} {r.name}</option>{/each}
            </optgroup>
          {/each}
        </select>
      </label>
      {#if groups.length === 0}<p class="text-xs text-muted">Save a request in a collection first; workflows send saved requests.</p>{/if}
      {#if requestId && !requestMissing}
        <Button size="sm" variant="ghost" icon="external" class="self-start" onclick={() => onopenrequest(requestId!)}>Open request</Button>
      {/if}
    {:else if node.type === 'evaluate'}
      <div class="grid min-h-0 gap-1">
        <span class="text-xs text-muted">JavaScript</span>
        <CodeEditor value={cfg.code as string} onchange={(v) => set<'evaluate'>({ code: v })} language="javascript" label="Evaluate code" wrap={settings.editorWrap} extensions={completion} class="h-56 rounded border border-border" />
      </div>
    {:else if node.type === 'if'}
      <label class="grid gap-1">
        <span class="text-xs text-muted">Condition</span>
        <input
          value={cfg.condition as string}
          spellcheck="false"
          class="h-7 rounded border border-border bg-raised px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-focus"
          oninput={(e) => set<'if'>({ condition: e.currentTarget.value })}
        />
      </label>
    {:else if node.type === 'forEach'}
      <label class="grid gap-1">
        <span class="text-xs text-muted">List</span>
        <input
          value={cfg.list as string}
          spellcheck="false"
          class="h-7 rounded border border-border bg-raised px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-focus"
          oninput={(e) => set<'forEach'>({ list: e.currentTarget.value })}
        />
      </label>
    {:else if node.type === 'delay'}
      <label class="flex items-center gap-2">
        <span class="text-xs text-muted">Wait</span>
        <input
          type="number"
          min="0"
          max={DELAY_MAX_MS}
          step="100"
          value={cfg.ms as number}
          class="h-7 w-28 rounded border border-border bg-raised px-2 text-sm"
          onchange={(e) => set<'delay'>({ ms: Math.min(DELAY_MAX_MS, Math.max(0, Math.round(Number(e.currentTarget.value) || 0))) })}
        />
        <span class="text-xs text-muted">ms</span>
      </label>
    {:else if node.type === 'setVariable'}
      <label class="grid gap-1">
        <span class="text-xs text-muted">Variable name</span>
        <input
          value={cfg.name as string}
          spellcheck="false"
          placeholder="token"
          class="h-7 rounded border border-border bg-raised px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-focus"
          oninput={(e) => set<'setVariable'>({ name: e.currentTarget.value })}
        />
      </label>
      <label class="grid gap-1">
        <span class="text-xs text-muted">Value (expression)</span>
        <input
          value={cfg.value as string}
          spellcheck="false"
          placeholder="input.body.token"
          class="h-7 rounded border border-border bg-raised px-2 font-mono text-xs outline-none focus:ring-2 focus:ring-focus"
          oninput={(e) => set<'setVariable'>({ value: e.currentTarget.value })}
        />
      </label>
      <label class="grid gap-1">
        <span class="text-xs text-muted">Where</span>
        <select class="h-7 rounded border border-border bg-raised px-1 text-sm" value={cfg.scope as string} onchange={(e) => set<'setVariable'>({ scope: e.currentTarget.value as VariableScope })}>
          <option value="run">This run</option>
          <option value="environment">Active environment</option>
          <option value="globals">Globals</option>
        </select>
      </label>
    {:else if node.type === 'output'}
      <label class="grid gap-1">
        <span class="text-xs text-muted">Label in the run log</span>
        <input
          value={cfg.label as string}
          placeholder={nodeTitle(node)}
          class="h-7 rounded border border-border bg-raised px-2 text-sm outline-none focus:ring-2 focus:ring-focus"
          oninput={(e) => set<'output'>({ label: e.currentTarget.value })}
        />
      </label>
    {/if}

    {#if run && run.runs > 0}
      <section class="grid gap-1.5 border-t border-border pt-3" aria-label="Last run of this node">
        <h4 class="text-xs font-semibold">
          Last run{run.runs > 1 ? ` (ran ${run.runs} times)` : ''}{run.durationMs !== undefined ? ` · ${run.durationMs} ms` : ''}
        </h4>
        {#if run.error}<p class="text-xs text-danger">{run.error}</p>{/if}
        {#if def.hasInput}
          <span class="text-xs text-muted">Received</span>
          <pre class="max-h-40 overflow-auto rounded border border-border bg-surface p-2 font-mono text-[11px]" data-testid="wf-node-input">{pretty(run.input) || 'null'}</pre>
        {/if}
        {#if run.status === 'done' && node.type !== 'output'}
          <span class="text-xs text-muted">Sent{run.ports.length ? ` on ${run.ports.join(', ')}` : ''}</span>
          <pre class="max-h-60 overflow-auto rounded border border-border bg-surface p-2 font-mono text-[11px]" data-testid="wf-node-output">{pretty(run.output) || 'null'}</pre>
        {/if}
      </section>
    {/if}
  </div>
  <div class="border-t border-border p-2">
    <Button size="sm" variant="ghost" icon="trash" onclick={ondelete}>Delete node</Button>
  </div>
</div>
