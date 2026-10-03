<script lang="ts" module>
  import type { Node } from '@xyflow/svelte'
  import type { WorkflowNode } from '../../lib/workflow/graph'

  /** Svelte Flow node carrying a workflow node (the graph document is rebuilt from these). */
  export type FlowNode = Node<{ node: WorkflowNode }, 'wf'>

  export interface EditorContext {
    readonly workflowId: string
  }
  export const EDITOR_CONTEXT = Symbol('workflow-editor')
</script>

<script lang="ts">
  /** One node on the workflow canvas: header (icon, title, run status), a summary line, and its ports. */
  import { Handle, Position, type NodeProps } from '@xyflow/svelte'
  import { getContext } from 'svelte'
  import { app } from '../../app/state.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { NODE_DEFS, PORT_LABELS, nodeTitle, type NodeConfigs } from '../../lib/workflow/graph'
  import { preview } from '../../lib/workflow/values'
  import { workflowRuns } from './workflowRuns.svelte'

  let { id, data, selected }: NodeProps<FlowNode> = $props()
  const ctx = getContext<EditorContext>(EDITOR_CONTEXT)

  const node = $derived(data.node)
  const def = $derived(NODE_DEFS[node.type])
  const run = $derived(workflowRuns.forWorkflow(ctx?.workflowId)?.node(id) ?? null)
  const status = $derived(run?.status ?? 'idle')

  const summary = $derived.by((): string => {
    switch (node.type) {
      case 'start': {
        const v = (node.config as NodeConfigs['start']).value.trim()
        return v ? `sends ${v.length > 40 ? `${v.slice(0, 39)}…` : v}` : 'sends nothing (null)'
      }
      case 'request': {
        const r = app.requestById((node.config as NodeConfigs['request']).requestId)
        if (!(node.config as NodeConfigs['request']).requestId) return 'Choose a request'
        return r ? `${r.method} ${r.name}` : 'Request deleted: choose another'
      }
      case 'evaluate': {
        const line = (node.config as NodeConfigs['evaluate']).code.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//'))
        return line ?? 'empty'
      }
      case 'if':
        return (node.config as NodeConfigs['if']).condition.trim() || 'no condition'
      case 'forEach':
        return `of ${(node.config as NodeConfigs['forEach']).list.trim() || 'input'}`
      case 'delay':
        return `${(node.config as NodeConfigs['delay']).ms} ms`
      case 'setVariable': {
        const c = node.config as NodeConfigs['setVariable']
        const where = { run: 'this run', environment: 'environment', globals: 'globals' }[c.scope]
        return c.name.trim() ? `{{${c.name.trim()}}} in ${where}` : 'Name the variable'
      }
      case 'output':
        return run && run.runs > 0 ? '' : 'Shows what arrives here'
    }
    return ''
  })
  const problem = $derived(
    (node.type === 'request' && !app.requestById((node.config as NodeConfigs['request']).requestId)) ||
      (node.type === 'setVariable' && !(node.config as NodeConfigs['setVariable']).name.trim()),
  )
  const STATUS_RING: Record<string, string> = {
    idle: 'border-border',
    running: 'border-accent ring-2 ring-focus',
    done: 'border-success',
    error: 'border-danger',
  }
</script>

<div
  class="wf-node w-56 rounded-md border bg-raised text-fg shadow-pop {STATUS_RING[status]} {selected ? 'outline outline-2 outline-offset-2 outline-[var(--focus-ring)]' : ''}"
  data-node-type={node.type}
  data-status={status}
>
  {#if def.hasInput}
    <Handle type="target" position={Position.Left} id="in" class="wf-handle" />
  {/if}
  <div class="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
    <Icon name={def.icon} size={13} class="shrink-0 text-accent-text" />
    <span class="min-w-0 flex-1 truncate text-xs font-semibold">{nodeTitle(node)}</span>
    {#if status === 'running'}
      {#if run?.progress}<span class="text-[10px] text-muted">{run.progress.index + 1}/{run.progress.count}</span>{/if}
      <Spinner />
    {:else if status === 'error'}
      <span class="text-danger" title={run?.error}><Icon name="alert" size={13} /></span>
    {:else if status === 'done' && (run?.runs ?? 0) > 1}
      <span class="rounded bg-success-soft px-1 text-[10px] text-success" title="Ran {run?.runs} times">×{run?.runs}</span>
    {:else if status === 'done'}
      <span class="text-success" title="Done"><Icon name="check" size={13} /></span>
    {/if}
  </div>
  {#if summary}
    <div class="truncate px-2 pt-1.5 font-mono text-[11px] {problem ? 'text-warning' : 'text-muted'}" title={summary}>{summary}</div>
  {/if}
  {#if node.type === 'output' && run && run.runs > 0}
    <pre class="nodrag nowheel mx-2 mt-1.5 max-h-28 overflow-auto rounded bg-surface p-1.5 font-mono text-[11px] leading-snug text-fg">{preview(run.input, 600)}</pre>
  {/if}
  {#if status === 'error' && run?.error}
    <div class="mx-2 mt-1.5 line-clamp-2 text-[11px] text-danger" title={run.error}>{run.error}</div>
  {/if}
  <div class="flex flex-col gap-0.5 py-1.5">
    {#each def.outputs as port (port)}
      <div class="relative flex justify-end pr-3 text-[10px] text-muted {run?.ports.includes(port) ? 'font-semibold text-fg' : ''}" data-port={port}>
        {PORT_LABELS[port] ?? port}
        <Handle type="source" position={Position.Right} id={port} class="wf-handle {port === 'error' ? 'wf-handle-error' : ''}" />
      </div>
    {/each}
  </div>
</div>
