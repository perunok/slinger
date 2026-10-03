import { describe, expect, it } from 'vitest'
import { connectionProblem, emptyGraph, graphProblems, NODE_DEFS, NODE_TYPES, parseGraph, serializeGraph, starterGraph, type WorkflowGraph } from './graph'

const n = (id: string, type: string, config: unknown = {}, extra: Record<string, unknown> = {}) => ({ id, type, position: { x: 1, y: 2 }, config, ...extra })

describe('parseGraph', () => {
  it('round-trips a valid graph', () => {
    const g: WorkflowGraph = {
      v: 1,
      nodes: [
        { id: 's', type: 'start', position: { x: 0, y: 0 }, config: { value: '{}' } },
        { id: 'r', type: 'request', position: { x: 200, y: 0 }, title: 'Login', config: { requestId: 'abc' } },
      ],
      edges: [{ id: 'e', source: 's', sourcePort: 'out', target: 'r' }],
      viewport: { x: 10, y: 20, zoom: 1.5 },
    }
    expect(parseGraph(serializeGraph(g))).toEqual(g)
  })

  it('opens anything: corrupt documents become empty graphs', () => {
    for (const junk of [null, '', '{', '[]', '42', '"x"', '{"nodes":"x"}']) expect(parseGraph(junk), String(junk)).toEqual(emptyGraph())
  })

  it('drops unknown node types, duplicate ids and edges that do not fit; fills config defaults', () => {
    const g = parseGraph(
      JSON.stringify({
        nodes: [
          n('a', 'start'),
          n('a', 'output'),
          n('b', 'teleport'),
          n('c', 'delay', { ms: -5 }),
          n('d', 'setVariable', { scope: 'cloud', name: 5 }),
          n('e', 'output', null, { title: '   ' }),
          { id: 'f', type: 'if' },
        ],
        edges: [
          { id: 'e1', source: 'a', sourcePort: 'out', target: 'c' },
          { id: 'e1', source: 'a', sourcePort: 'out', target: 'e' },
          { id: 'e2', source: 'a', sourcePort: 'out', target: 'c' },
          { id: 'e3', source: 'a', sourcePort: 'nope', target: 'e' },
          { id: 'e4', source: 'c', sourcePort: 'out', target: 'a' },
          { id: 'e5', source: 'c', sourcePort: 'out', target: 'ghost' },
          { id: 'e6', source: 'c', sourcePort: 'out', target: 'c' },
          { id: 'e7', source: 'f', sourcePort: 'false', target: 'e' },
        ],
      }),
    )
    expect(g.nodes.map((x) => x.id)).toEqual(['a', 'c', 'd', 'e', 'f'])
    expect(g.nodes.find((x) => x.id === 'c')!.config).toEqual({ ms: 0 })
    expect(g.nodes.find((x) => x.id === 'd')!.config).toEqual({ name: '', value: 'input', scope: 'run' })
    expect(g.nodes.find((x) => x.id === 'e')!.title).toBeUndefined()
    expect(g.nodes.find((x) => x.id === 'f')).toMatchObject({ position: { x: 0, y: 0 }, config: NODE_DEFS.if.defaults() })
    expect(g.edges.map((x) => x.id)).toEqual(['e1', 'e7'])
  })

  it('keeps every node type it knows', () => {
    const g = parseGraph(JSON.stringify({ nodes: NODE_TYPES.map((t, i) => n(`n${i}`, t)) }))
    expect(g.nodes.map((x) => x.type)).toEqual([...NODE_TYPES])
  })
})

describe('connections and problems', () => {
  const g = parseGraph(JSON.stringify({ nodes: [n('s', 'start'), n('o', 'output'), n('r', 'request', { requestId: 'gone' }), n('v', 'setVariable')] }))

  it('refuses edges into Start, out of missing ports and onto the same node', () => {
    expect(connectionProblem(g, { source: 's', sourcePort: 'out', target: 'o' })).toBeNull()
    expect(connectionProblem(g, { source: 'o', sourcePort: 'out', target: 's' })).toBe('no such output')
    expect(connectionProblem(g, { source: 'r', sourcePort: 'error', target: 's' })).toBe('Start has no input')
    expect(connectionProblem(g, { source: 'r', sourcePort: 'response', target: 'r' })).toBe('a node cannot feed itself')
  })

  it('lists what stops a run', () => {
    expect(graphProblems(g, () => false).map((p) => p.message)).toEqual([
      'Send request: its request was deleted; choose another.',
      'Set variable: give the variable a name.',
    ])
    expect(graphProblems(emptyGraph(), () => true)).toEqual([{ nodeId: null, message: 'Add a Start node: a run begins there.' }])
  })

  it('a new workflow starts with one Start node', () => {
    let i = 0
    expect(starterGraph(() => `id${++i}`).nodes).toEqual([{ id: 'id1', type: 'start', position: { x: 80, y: 160 }, config: { value: '' } }])
  })
})
