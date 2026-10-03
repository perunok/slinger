<script lang="ts">
  /**
   * The workflow editor: node palette | canvas (Svelte Flow) | settings of the selected node, a toolbar with Run, and
   * the run log below. The graph is saved as it is edited (debounced; local-only, so also in read-only workspaces).
   */
  import { Background, Controls, SvelteFlow, useSvelteFlow, type Connection, type Edge, type Viewport } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import { onDestroy, onMount, setContext, untrack } from 'svelte'
  import type { Workflow } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { uuid } from '../../lib/template'
  import { connectionProblem, graphProblems, newNode, NODE_DEFS, NODE_TYPES, parseGraph, serializeGraph, GRAPH_VERSION, type NodeType, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from '../../lib/workflow/graph'
  import { tabsStore } from '../requests/tabs.svelte'
  import { workflowEvents } from './actions'
  import { workflowCommands } from './commands'
  import WorkflowInspector from './WorkflowInspector.svelte'
  import WorkflowNodeCard, { EDITOR_CONTEXT, type FlowNode } from './WorkflowNodeCard.svelte'
  import WorkflowRunLog from './WorkflowRunLog.svelte'
  import { workflowRuns } from './workflowRuns.svelte'

  let { initial }: { initial: Workflow } = $props()

  // svelte-ignore state_referenced_locally
  const workflowId = initial.id
  setContext(EDITOR_CONTEXT, { workflowId })
  const flow = useSvelteFlow()
  const nodeTypes = { wf: WorkflowNodeCard }
  const DRAG_TYPE = 'application/x-slinger-workflow-node'

  const toFlowNode = (n: WorkflowNode, selected = false): FlowNode => ({ id: n.id, type: 'wf', position: { ...n.position }, data: { node: n }, selected })
  const toFlowEdge = (e: WorkflowEdge): Edge => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourcePort,
    target: e.target,
    targetHandle: 'in',
    class: e.sourcePort === 'error' ? 'wf-edge-error' : undefined,
  })

  // svelte-ignore state_referenced_locally
  const parsed = parseGraph(initial.graphJson)
  let nodes = $state.raw<FlowNode[]>(parsed.nodes.map((n) => toFlowNode(n)))
  let edges = $state.raw<Edge[]>(parsed.edges.map(toFlowEdge))
  let viewport = $state<Viewport | undefined>(parsed.viewport)
  // svelte-ignore state_referenced_locally
  let version = initial.version

  const graph = $derived<WorkflowGraph>({
    v: GRAPH_VERSION,
    nodes: nodes.map((n) => ({ ...n.data.node, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, sourcePort: e.sourceHandle ?? 'out', target: e.target })),
    ...(viewport ? { viewport: { x: Math.round(viewport.x), y: Math.round(viewport.y), zoom: Math.round(viewport.zoom * 1000) / 1000 } } : {}),
  })

  // ---- saving ------------------------------------------------------------

  let savedJson = untrack(() => serializeGraph(graph))
  let pendingJson: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let saving = $state(false)
  let saveError = $state<string | null>(null)

  $effect(() => {
    const json = serializeGraph(graph)
    if (json === savedJson) return
    pendingJson = json
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void flush(), 600)
  })

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = null
    const json = pendingJson
    if (json === null || json === savedJson) return
    pendingJson = null
    saving = true
    try {
      let saved: Workflow
      try {
        saved = await api().updateWorkflow({ workflowId, expectedVersion: version, graphJson: json })
      } catch (e) {
        if (errorInfo(e).code !== 'version_conflict') throw e
        // Changed elsewhere (a rename from the sidebar while a save was in flight): this editor's graph wins.
        const latest = await api().getWorkflow(workflowId)
        saved = await api().updateWorkflow({ workflowId, expectedVersion: latest.version, graphJson: json })
      }
      version = saved.version
      savedJson = json
      saveError = null
      app.upsertWorkflow(saved)
    } catch (e) {
      saveError = errorInfo(e).message
      if (pendingJson === null) pendingJson = json // retried with the next change or Ctrl+S
    } finally {
      saving = false
    }
    if (pendingJson !== null && pendingJson !== savedJson) void flush()
  }

  const onRenamed = (e: Event) => {
    const w = (e as CustomEvent<Workflow>).detail
    if (w.id === workflowId) version = w.version
  }

  onMount(() => {
    workflowEvents.addEventListener('changed', onRenamed)
    workflowCommands.run = (id) => id === workflowId && run()
    workflowCommands.saveNow = (id) => id === workflowId && void flush()
    window.addEventListener('pagehide', flushOnLeave)
  })
  const flushOnLeave = () => void flush()
  onDestroy(() => {
    workflowEvents.removeEventListener('changed', onRenamed)
    if (workflowCommands.saveNow && workflowCommands.run) {
      workflowCommands.run = null
      workflowCommands.saveNow = null
    }
    window.removeEventListener('pagehide', flushOnLeave)
    void flush()
  })

  // ---- editing -----------------------------------------------------------

  const selectedNodes = $derived(nodes.filter((n) => n.selected))
  const selected = $derived(selectedNodes.length === 1 ? selectedNodes[0]! : null)

  let canvas: HTMLDivElement | undefined = $state()
  let addCount = 0

  /** Room between a node and the one added after it. */
  const NEXT_DX = 290

  /**
   * Adds a node. Dropped: where it was dropped. Clicked with one node selected: to the right of it, connected from its
   * first output (so a chain builds itself click by click). Otherwise near the middle of the view.
   */
  function addNode(type: NodeType, at?: { x: number; y: number }) {
    let pos = at
    let from: { node: FlowNode; port: string } | null = null
    if (!pos && selected) {
      const port = NODE_DEFS[selected.data.node.type].outputs[0]
      if (port && NODE_DEFS[type].hasInput) from = { node: selected, port }
      const below = nodes.filter((n) => Math.abs(n.position.x - (selected.position.x + NEXT_DX)) < 40).length
      pos = { x: selected.position.x + NEXT_DX, y: selected.position.y + below * 120 }
    }
    if (!pos) {
      const r = canvas?.getBoundingClientRect()
      const step = (addCount++ % 6) * 24
      pos = r ? flow.screenToFlowPosition({ x: r.left + r.width / 2 - 112 + step, y: r.top + r.height / 2 - 50 + step }) : { x: 100 + step, y: 100 + step }
    }
    const node = newNode(type, freeSpot(pos), uuid)
    nodes = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), toFlowNode(node, true)]
    if (from) edges = [...edges, toFlowEdge({ id: uuid(), source: from.node.id, sourcePort: from.port, target: node.id })]
  }

  /** Moves a new node down until it does not cover another one. */
  function freeSpot(pos: { x: number; y: number }): { x: number; y: number } {
    const p = { ...pos }
    for (let i = 0; i < 50 && nodes.some((n) => Math.abs(n.position.x - p.x) < 200 && Math.abs(n.position.y - p.y) < 100); i++) p.y += 110
    return p
  }

  function updateNode(updated: WorkflowNode) {
    nodes = nodes.map((n) => (n.id === updated.id ? { ...n, data: { node: updated } } : n))
  }

  function deleteNode(id: string) {
    nodes = nodes.filter((n) => n.id !== id)
    edges = edges.filter((e) => e.source !== id && e.target !== id)
  }

  function onDrop(e: DragEvent) {
    const type = e.dataTransfer?.getData(DRAG_TYPE) as NodeType | undefined
    if (!type || !(NODE_TYPES as readonly string[]).includes(type)) return
    e.preventDefault()
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addNode(type, { x: p.x - 112, y: p.y - 20 })
  }

  const isValidConnection = (c: Connection | Edge): boolean => {
    if (connectionProblem(graph, { source: c.source, sourcePort: c.sourceHandle ?? '', target: c.target })) return false
    return !edges.some((e) => e.source === c.source && e.sourceHandle === c.sourceHandle && e.target === c.target)
  }
  const beforeConnect = (c: Connection): Edge => toFlowEdge({ id: uuid(), source: c.source, sourcePort: c.sourceHandle ?? 'out', target: c.target })

  function focusNode(id: string | null) {
    if (!id) return
    const n = nodes.find((x) => x.id === id)
    if (!n) return
    nodes = nodes.map((x) => (x.selected !== (x.id === id) ? { ...x, selected: x.id === id } : x))
    void flow.setCenter(n.position.x + 112, n.position.y + 50, { zoom: flow.getViewport().zoom, duration: 200 })
  }

  // ---- running -----------------------------------------------------------

  const session = $derived(workflowRuns.forWorkflow(workflowId))
  let problems = $state.raw<Array<{ nodeId: string | null; message: string }>>([])
  let showLog = $state(false)

  function run() {
    if (session?.running) return
    problems = graphProblems(graph, (id) => !!app.requestById(id))
    showLog = true
    if (problems.length > 0) {
      focusNode(problems.find((p) => p.nodeId)?.nodeId ?? null)
      return
    }
    void flush()
    workflowRuns.start(workflowId, graph)
  }

  const environmentName = $derived(session?.running ? (session.environment?.name ?? null) : (app.activeEnvironment?.name ?? null))
  const statusText = $derived.by(() => {
    if (!session) return null
    const s = session.summary
    if (session.running) return 'Running…'
    if (!s) return null
    return s.phase === 'done' ? `Done in ${s.steps} steps` : s.phase === 'stopped' ? 'Stopped' : 'Failed'
  })
</script>

<div class="flex min-h-0 flex-1 flex-col" data-workflow-id={workflowId}>
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
    {#if session?.running}
      <Button size="sm" variant="danger" icon="stop" onclick={() => workflowRuns.stop(workflowId)}>Stop</Button>
    {:else}
      <Button size="sm" variant="primary" icon="play" onclick={run} title="Run (Ctrl+Enter)">Run</Button>
    {/if}
    {#if statusText}
      <span class="text-xs {session?.summary?.phase === 'failed' ? 'text-danger' : 'text-muted'}" data-testid="wf-status" aria-live="polite">{statusText}</span>
    {/if}
    <span class="ml-2 truncate text-xs text-muted" title="Requests and scripts use this environment">
      <Icon name="globe" size={12} class="mr-0.5 inline align-[-2px]" />{environmentName ?? 'No environment'}
    </span>
    <span class="ml-auto text-xs {saveError ? 'text-danger' : 'text-faint'}" data-testid="wf-save-state" title={saveError ?? ''}>
      {saveError ? 'Not saved' : saving ? 'Saving…' : 'Saved'}
    </span>
    <Button size="sm" variant="ghost" icon="list" onclick={() => (showLog = !showLog)} aria-pressed={showLog}>Run log</Button>
    <InfoTip label="About the workflow editor">
      Drag a node from the left onto the canvas (or click it), then connect an output on a node's right edge to the input on
      another node's left edge. Select a node to change it; Delete or Backspace removes the selection. Run (Ctrl+Enter) starts at
      the Start node and follows the connections one step at a time; each node shows what it did, and the run log lists every
      step. Changes are saved as you make them.
    </InfoTip>
  </div>

  <div class="flex min-h-0 flex-1">
    <div class="flex w-44 shrink-0 flex-col gap-1 overflow-auto border-r border-border bg-surface p-2" role="group" aria-label="Nodes">
      {#each NODE_TYPES as type (type)}
        {@const def = NODE_DEFS[type]}
        <button
          type="button"
          draggable="true"
          class="flex cursor-grab items-start gap-2 rounded border border-border bg-raised px-2 py-1.5 text-left hover:bg-hover"
          title="{def.summary}. Drag onto the canvas, or click: with a node selected, it is added after it and connected."
          ondragstart={(e) => {
            e.dataTransfer?.setData(DRAG_TYPE, type)
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
          }}
          onclick={() => addNode(type)}
          aria-label="Add {def.label}"
        >
          <Icon name={def.icon} size={13} class="mt-0.5 shrink-0 text-accent-text" />
          <span class="min-w-0">
            <span class="block text-xs font-medium">{def.label}</span>
            <span class="block text-[10px] leading-tight text-muted">{def.summary}</span>
          </span>
        </button>
      {/each}
    </div>

    <div
      class="wf-canvas relative min-w-0 flex-1"
      bind:this={canvas}
      role="application"
      aria-label="Workflow canvas"
      ondragover={(e) => {
        if (e.dataTransfer?.types.includes(DRAG_TYPE)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
        }
      }}
      ondrop={onDrop}
    >
      <SvelteFlow
        bind:nodes
        bind:edges
        {nodeTypes}
        {isValidConnection}
        onbeforeconnect={beforeConnect}
        onmoveend={(_e, vp) => (viewport = vp)}
        initialViewport={parsed.viewport}
        fitView={!parsed.viewport}
        fitViewOptions={{ maxZoom: 1 }}
        deleteKey={['Backspace', 'Delete']}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: 'default' }}
      >
        <Background gap={20} />
        <Controls showLock={false} />
      </SvelteFlow>
      {#if nodes.length === 0}
        <p class="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-muted">Drag a node here from the left, starting with Start.</p>
      {/if}
    </div>

    {#if selected}
      <aside class="w-80 shrink-0 border-l border-border bg-surface">
        {#key selected.id}
          <WorkflowInspector
            node={selected.data.node}
            run={session?.node(selected.id) ?? null}
            onchange={updateNode}
            ondelete={() => deleteNode(selected.id)}
            onopenrequest={(id) => {
              const r = app.requestById(id)
              if (r) tabsStore.openRequest(r)
            }}
          />
        {/key}
      </aside>
    {/if}
  </div>

  {#if showLog}
    <WorkflowRunLog {session} {problems} onselect={focusNode} onclear={() => ((problems = []), workflowRuns.clear(workflowId))} />
  {/if}
</div>
