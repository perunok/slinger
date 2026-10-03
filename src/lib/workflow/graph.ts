/**
 * Workflow graph documents (stored as `workflows.graph_json`, opaque to the main process).
 *
 * Model (message passing, like Node-RED): every node except Start has one input; a value arriving there runs the node,
 * which sends values out of its named output ports; each edge carries a value from one output port to another node's
 * input. Values are plain JSON. See ./engine.ts for how a run walks the graph.
 */

export const GRAPH_VERSION = 1

export const NODE_TYPES = ['start', 'request', 'evaluate', 'if', 'forEach', 'delay', 'setVariable', 'output'] as const
export type NodeType = (typeof NODE_TYPES)[number]

export type VariableScope = 'run' | 'environment' | 'globals'

export interface NodeConfigs {
  /** `value`: JSON text sent out when the run starts (empty: null). */
  start: { value: string }
  request: { requestId: string | null }
  evaluate: { code: string }
  /** A JavaScript expression; `input` is the value that arrived. */
  if: { condition: string }
  /** An expression giving the list to walk (default `input`). */
  forEach: { list: string }
  delay: { ms: number }
  /** `value` is an expression (default `input`); strings are stored as is, anything else as JSON. */
  setVariable: { name: string; value: string; scope: VariableScope }
  output: { label: string }
}

export type NodeConfig = NodeConfigs[NodeType]

export interface WorkflowNode<T extends NodeType = NodeType> {
  id: string
  type: T
  position: { x: number; y: number }
  /** A name shown on the node instead of the type's label (empty: the default). */
  title?: string
  config: NodeConfigs[T]
}

export interface WorkflowEdge {
  id: string
  source: string
  /** The source node's output port. */
  sourcePort: string
  target: string
}

export interface WorkflowGraph {
  v: typeof GRAPH_VERSION
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  viewport?: { x: number; y: number; zoom: number }
}

export interface NodeDef<T extends NodeType = NodeType> {
  type: T
  label: string
  /** One line for the palette. */
  summary: string
  /** Icon name (components/ui/icons.ts). */
  icon: string
  hasInput: boolean
  outputs: readonly string[]
  defaults(): NodeConfigs[T]
}

export const NODE_DEFS: { [T in NodeType]: NodeDef<T> } = {
  start: { type: 'start', label: 'Start', summary: 'Where a run begins', icon: 'play', hasInput: false, outputs: ['out'], defaults: () => ({ value: '' }) },
  request: {
    type: 'request',
    label: 'Send request',
    summary: 'Sends a saved request',
    icon: 'send',
    hasInput: true,
    outputs: ['response', 'error'],
    defaults: () => ({ requestId: null }),
  },
  evaluate: {
    type: 'evaluate',
    label: 'Evaluate',
    summary: 'Runs JavaScript on the value',
    icon: 'code',
    hasInput: true,
    outputs: ['out', 'error'],
    defaults: () => ({ code: '// `input` is the value that arrived; return what to send on.\nreturn input\n' }),
  },
  if: { type: 'if', label: 'If', summary: 'Branches on a condition', icon: 'compare', hasInput: true, outputs: ['true', 'false'], defaults: () => ({ condition: 'input.status === 200' }) },
  forEach: { type: 'forEach', label: 'For each', summary: 'Repeats for every item of a list', icon: 'refresh', hasInput: true, outputs: ['item', 'done'], defaults: () => ({ list: 'input' }) },
  delay: { type: 'delay', label: 'Delay', summary: 'Waits, then passes the value on', icon: 'clock', hasInput: true, outputs: ['out'], defaults: () => ({ ms: 1000 }) },
  setVariable: {
    type: 'setVariable',
    label: 'Set variable',
    summary: 'Stores a value as a {{variable}}',
    icon: 'tag',
    hasInput: true,
    outputs: ['out'],
    defaults: () => ({ name: '', value: 'input', scope: 'run' }),
  },
  output: { type: 'output', label: 'Output', summary: 'Shows the value it receives', icon: 'eye', hasInput: true, outputs: [], defaults: () => ({ label: '' }) },
}

export const PORT_LABELS: Record<string, string> = {
  out: 'out',
  response: 'response',
  error: 'error',
  true: 'true',
  false: 'false',
  item: 'each item',
  done: 'done',
}

export const DELAY_MAX_MS = 10 * 60 * 1000

export function emptyGraph(): WorkflowGraph {
  return { v: GRAPH_VERSION, nodes: [], edges: [] }
}

/** A new workflow: one Start node, so there is something to connect to. */
export function starterGraph(newId: () => string): WorkflowGraph {
  return { v: GRAPH_VERSION, nodes: [newNode('start', { x: 80, y: 160 }, newId)], edges: [] }
}

export function newNode<T extends NodeType>(type: T, position: { x: number; y: number }, newId: () => string): WorkflowNode<T> {
  return { id: newId(), type, position: { x: Math.round(position.x), y: Math.round(position.y) }, config: NODE_DEFS[type].defaults() }
}

export const nodeTitle = (node: WorkflowNode): string => node.title?.trim() || NODE_DEFS[node.type].label

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback: string, max = 200_000) => (typeof v === 'string' ? v.slice(0, max) : fallback)
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Each config field checked on its own; anything missing or of the wrong type gets the default. */
function cleanConfig<T extends NodeType>(type: T, raw: unknown): NodeConfigs[T] {
  const d = NODE_DEFS[type].defaults() as unknown as Record<string, unknown>
  const o = isObj(raw) ? raw : {}
  switch (type) {
    case 'start':
      return { value: str(o.value, d.value as string) } as NodeConfigs[T]
    case 'request':
      return { requestId: typeof o.requestId === 'string' && o.requestId ? o.requestId : null } as NodeConfigs[T]
    case 'evaluate':
      return { code: str(o.code, d.code as string) } as NodeConfigs[T]
    case 'if':
      return { condition: str(o.condition, d.condition as string, 10_000) } as NodeConfigs[T]
    case 'forEach':
      return { list: str(o.list, d.list as string, 10_000) } as NodeConfigs[T]
    case 'delay':
      return { ms: Math.min(DELAY_MAX_MS, Math.max(0, Math.round(num(o.ms, d.ms as number)))) } as NodeConfigs[T]
    case 'setVariable':
      return {
        name: str(o.name, '', 500),
        value: str(o.value, d.value as string, 10_000),
        scope: o.scope === 'environment' || o.scope === 'globals' ? o.scope : 'run',
      } as NodeConfigs[T]
    case 'output':
      return { label: str(o.label, '', 200) } as NodeConfigs[T]
  }
  return d as NodeConfigs[T]
}

/**
 * Reads a stored graph: tolerant (unknown node types, duplicate ids and edges to missing nodes or ports are dropped;
 * a corrupt document becomes an empty graph), so a bad document can always be opened and fixed.
 */
export function parseGraph(json: string | null | undefined): WorkflowGraph {
  let raw: unknown
  try {
    raw = JSON.parse(json || '{}')
  } catch {
    return emptyGraph()
  }
  if (!isObj(raw)) return emptyGraph()
  const nodes: WorkflowNode[] = []
  const ids = new Set<string>()
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    if (!isObj(n) || typeof n.id !== 'string' || !n.id || ids.has(n.id)) continue
    if (!(NODE_TYPES as readonly string[]).includes(n.type as string)) continue
    const type = n.type as NodeType
    const pos = isObj(n.position) ? n.position : {}
    const node: WorkflowNode = { id: n.id, type, position: { x: num(pos.x, 0), y: num(pos.y, 0) }, config: cleanConfig(type, n.config) }
    if (typeof n.title === 'string' && n.title.trim()) node.title = n.title.slice(0, 200)
    ids.add(n.id)
    nodes.push(node)
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges: WorkflowEdge[] = []
  const edgeIds = new Set<string>()
  const seen = new Set<string>()
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    if (!isObj(e) || typeof e.id !== 'string' || edgeIds.has(e.id)) continue
    const edge = { id: e.id, source: String(e.source ?? ''), sourcePort: String(e.sourcePort ?? ''), target: String(e.target ?? '') }
    const problem = connectionProblem({ nodes, edges }, edge, byId)
    const key = `${edge.source}\u0000${edge.sourcePort}\u0000${edge.target}`
    if (problem || seen.has(key)) continue
    edgeIds.add(edge.id)
    seen.add(key)
    edges.push(edge)
  }
  const graph: WorkflowGraph = { v: GRAPH_VERSION, nodes, edges }
  if (isObj(raw.viewport)) {
    const vp = raw.viewport
    const zoom = num(vp.zoom, 1)
    graph.viewport = { x: num(vp.x, 0), y: num(vp.y, 0), zoom: zoom > 0 ? zoom : 1 }
  }
  return graph
}

export const serializeGraph = (graph: WorkflowGraph): string => JSON.stringify(graph)

/** Why an edge may not exist (null: it may). Self-loops are refused; cycles through other nodes are allowed (loops). */
export function connectionProblem(
  graph: Pick<WorkflowGraph, 'nodes' | 'edges'>,
  edge: Pick<WorkflowEdge, 'source' | 'sourcePort' | 'target'>,
  byId: Map<string, WorkflowNode> = new Map(graph.nodes.map((n) => [n.id, n])),
): string | null {
  const source = byId.get(edge.source)
  const target = byId.get(edge.target)
  if (!source || !target) return 'missing node'
  if (!NODE_DEFS[source.type].outputs.includes(edge.sourcePort)) return 'no such output'
  if (!NODE_DEFS[target.type].hasInput) return 'Start has no input'
  if (source.id === target.id) return 'a node cannot feed itself'
  return null
}

/** Problems that stop a run before it begins (shown in the run panel). */
export function graphProblems(graph: WorkflowGraph, requestExists: (id: string) => boolean): Array<{ nodeId: string | null; message: string }> {
  const out: Array<{ nodeId: string | null; message: string }> = []
  if (!graph.nodes.some((n) => n.type === 'start')) out.push({ nodeId: null, message: 'Add a Start node: a run begins there.' })
  for (const n of graph.nodes) {
    if (n.type === 'request') {
      const id = (n.config as NodeConfigs['request']).requestId
      if (!id) out.push({ nodeId: n.id, message: `${nodeTitle(n)}: choose a request.` })
      else if (!requestExists(id)) out.push({ nodeId: n.id, message: `${nodeTitle(n)}: its request was deleted; choose another.` })
    }
    if (n.type === 'setVariable' && !(n.config as NodeConfigs['setVariable']).name.trim()) {
      out.push({ nodeId: n.id, message: `${nodeTitle(n)}: give the variable a name.` })
    }
  }
  return out
}
