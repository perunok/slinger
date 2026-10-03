import { describe, expect, it } from 'vitest'
import { WorkflowRun, expressionCode, setVariableCode, type EngineDeps, type Result, type RunEvent } from './engine'
import { NODE_DEFS, type NodeConfigs, type NodeType, type WorkflowGraph, type WorkflowNode } from './graph'

let ids = 0
function node<T extends NodeType>(type: T, config: Partial<NodeConfigs[T]> = {}, y = 0): WorkflowNode<T> {
  return { id: `${type}${++ids}`, type, position: { x: 0, y }, config: { ...NODE_DEFS[type].defaults(), ...config } }
}
const edge = (source: WorkflowNode, sourcePort: string, target: WorkflowNode) => ({ id: `e${++ids}`, source: source.id, sourcePort, target: target.id })
const graph = (nodes: WorkflowNode[], edges: ReturnType<typeof edge>[]): WorkflowGraph => ({ v: 1, nodes, edges })

/**
 * "JavaScript" for tests: a function body evaluated with real JS (the app uses the QuickJS sandbox). `pm` records
 * variable writes.
 */
function deps(overrides: Partial<EngineDeps> = {}) {
  const events: RunEvent[] = []
  const sent: Array<{ requestId: string | null; input: unknown }> = []
  const vars: Record<string, string> = {}
  const pm = { variables: { set: (k: string, v: string) => (vars[`run:${k}`] = v) }, environment: { set: (k: string, v: string) => (vars[`env:${k}`] = v) }, globals: { set: (k: string, v: string) => (vars[`glob:${k}`] = v) } }
  const d: EngineDeps = {
    async sendRequest(n, input): Promise<Result<unknown>> {
      sent.push({ requestId: n.config.requestId, input })
      return { ok: true, value: { status: 200, body: { items: [1, 2, 3], echo: input } } }
    },
    async evaluate(_n, code, input): Promise<Result<unknown>> {
      try {
        return { ok: true, value: new Function('input', 'pm', code)(input, pm) }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    },
    sleep: async () => {},
    onEvent: (e) => void events.push(e),
    ...overrides,
  }
  return { d, events, sent, vars }
}
const outputs = (events: RunEvent[]) => events.filter((e) => e.type === 'output').map((e) => (e as { value: unknown }).value)

describe('WorkflowRun', () => {
  it('chains Start -> request -> evaluate -> output, passing values along', async () => {
    const start = node('start', { value: '{"userId": 7}' })
    const req = node('request', { requestId: 'r1' })
    const evalN = node('evaluate', { code: 'return input.body.items.length' })
    const out = node('output', { label: 'Count' })
    const { d, events, sent } = deps()
    const summary = await new WorkflowRun(graph([start, req, evalN, out], [edge(start, 'out', req), edge(req, 'response', evalN), edge(evalN, 'out', out)]), d).run()
    expect(summary).toEqual({ phase: 'done', steps: 4, error: null })
    expect(sent).toEqual([{ requestId: 'r1', input: { userId: 7 } }])
    expect(events.filter((e) => e.type === 'output')).toEqual([{ type: 'output', nodeId: out.id, label: 'Count', value: 3, step: 4 }])
    expect(events.map((e) => `${e.type}:${e.nodeId}`)).toEqual([
      `node-start:${start.id}`, `node-end:${start.id}`,
      `node-start:${req.id}`, `node-end:${req.id}`,
      `node-start:${evalN.id}`, `node-end:${evalN.id}`,
      `node-start:${out.id}`, `output:${out.id}`, `node-end:${out.id}`,
    ])
  })

  it('If branches; every edge of a port runs, depth first, in order', async () => {
    const start = node('start', { value: '5' })
    const cond = node('if', { condition: 'input > 3' })
    const a = node('output', { label: 'A' })
    const b = node('output', { label: 'B' })
    const no = node('output', { label: 'no' })
    const { d, events } = deps()
    await new WorkflowRun(graph([start, cond, a, b, no], [edge(start, 'out', cond), edge(cond, 'true', a), edge(cond, 'true', b), edge(cond, 'false', no)]), d).run()
    expect(events.filter((e) => e.type === 'output').map((e) => (e as { label: string }).label)).toEqual(['A', 'B'])
    expect(events.find((e) => e.type === 'node-end' && e.nodeId === cond.id)).toMatchObject({ ports: ['true'], output: 5 })
  })

  it('For each sends every item down `item` (each branch finishing first), then the list down `done`', async () => {
    const start = node('start', { value: '{"list":[1,2,3]}' })
    const each = node('forEach', { list: 'input.list' })
    const double = node('evaluate', { code: 'return input * 2' })
    const item = node('output', { label: 'item' })
    const done = node('output', { label: 'done' })
    const { d, events } = deps()
    await new WorkflowRun(graph([start, each, double, item, done], [edge(start, 'out', each), edge(each, 'item', double), edge(double, 'out', item), edge(each, 'done', done)]), d).run()
    expect(outputs(events)).toEqual([2, 4, 6, [1, 2, 3]])
    expect(events.filter((e) => e.type === 'node-progress').map((e) => [(e as { index: number }).index, (e as { count: number }).count])).toEqual([[0, 3], [1, 3], [2, 3]])
    expect(events.filter((e) => e.type === 'node-end' && e.nodeId === each.id)).toMatchObject([{ ports: ['item', 'done'], output: [1, 2, 3] }])
  })

  it('For each refuses something that is not a list', async () => {
    const start = node('start', { value: '{"a":1}' })
    const each = node('forEach')
    const { d } = deps()
    const s = await new WorkflowRun(graph([start, each], [edge(start, 'out', each)]), d).run()
    expect(s).toMatchObject({ phase: 'failed', error: { nodeId: each.id, message: 'For each: the list is object, not an array' } })
  })

  it('a failure goes down `error` when connected, otherwise stops the run there', async () => {
    const start = node('start')
    const bad = node('evaluate', { code: 'throw new Error("boom")' })
    const handler = node('output', { label: 'handled' })
    const { d, events } = deps()
    const handledRun = await new WorkflowRun(graph([start, bad, handler], [edge(start, 'out', bad), edge(bad, 'error', handler)]), d).run()
    expect(handledRun.phase).toBe('done')
    expect(outputs(events)).toEqual([{ message: 'boom' }])
    expect(events.find((e) => e.type === 'node-error')).toMatchObject({ nodeId: bad.id, error: 'boom', handled: true })

    const failed = await new WorkflowRun(graph([start, bad], [edge(start, 'out', bad)]), deps().d).run()
    expect(failed).toMatchObject({ phase: 'failed', error: { nodeId: bad.id, message: 'Evaluate: boom' } })

    const req = node('request', { requestId: 'r' })
    const offline = deps({ sendRequest: async () => ({ ok: false, error: 'connection refused' }) })
    const s = await new WorkflowRun(graph([start, req], [edge(start, 'out', req)]), offline.d).run()
    expect(s.error?.message).toBe('Send request: connection refused')
  })

  it('stops runaway loops after maxSteps', async () => {
    const start = node('start', { value: '0' })
    const inc = node('evaluate', { code: 'return input + 1' })
    const again = node('if', { condition: 'true' })
    const { d } = deps({ maxSteps: 50 })
    const s = await new WorkflowRun(graph([start, inc, again], [edge(start, 'out', inc), edge(inc, 'out', again), edge(again, 'true', inc)]), d).run()
    expect(s).toMatchObject({ phase: 'failed', steps: 50, error: { message: 'Stopped after 50 steps: does a loop never end?' } })
  })

  it('a loop through If ends when the condition turns false', async () => {
    const start = node('start', { value: '0' })
    const inc = node('evaluate', { code: 'return input + 1' })
    const more = node('if', { condition: 'input < 3' })
    const out = node('output')
    const { d, events } = deps()
    const s = await new WorkflowRun(graph([start, inc, more, out], [edge(start, 'out', inc), edge(inc, 'out', more), edge(more, 'true', inc), edge(more, 'false', out)]), d).run()
    expect(s.phase).toBe('done')
    expect(outputs(events)).toEqual([3])
  })

  it('can be stopped while waiting', async () => {
    const start = node('start')
    const wait = node('delay', { ms: 10_000 })
    const out = node('output')
    let run!: WorkflowRun
    const { d, events } = deps({
      sleep: (_ms, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    })
    run = new WorkflowRun(graph([start, wait, out], [edge(start, 'out', wait), edge(wait, 'out', out)]), d)
    const done = run.run()
    await Promise.resolve()
    run.stop()
    expect(await done).toMatchObject({ phase: 'stopped' })
    expect(outputs(events)).toEqual([])
  })

  it('runs every Start node, top to bottom', async () => {
    const lower = node('start', { value: '"lower"' }, 300)
    const upper = node('start', { value: '"upper"' }, 10)
    const out = node('output')
    const { d, events } = deps()
    await new WorkflowRun(graph([lower, upper, out], [edge(lower, 'out', out), edge(upper, 'out', out)]), d).run()
    expect(outputs(events)).toEqual(['upper', 'lower'])
  })

  it('needs a Start node and valid JSON in it', async () => {
    expect(await new WorkflowRun(graph([node('output')], []), deps().d).run()).toMatchObject({ phase: 'failed', error: { nodeId: null } })
    const start = node('start', { value: '{oops' })
    expect((await new WorkflowRun(graph([start], []), deps().d).run()).error?.message).toBe('Start: the value is not valid JSON')
  })

  it('Set variable writes the chosen scope and passes its input on', async () => {
    const start = node('start', { value: '{"token":"abc","n":2}' })
    const a = node('setVariable', { name: 'token', value: 'input.token', scope: 'run' })
    const b = node('setVariable', { name: 'count', value: 'input.n', scope: 'environment' })
    const c = node('setVariable', { name: 'whole', value: '', scope: 'globals' })
    const out = node('output')
    const { d, vars, events } = deps()
    await new WorkflowRun(graph([start, a, b, c, out], [edge(start, 'out', a), edge(a, 'out', b), edge(b, 'out', c), edge(c, 'out', out)]), d).run()
    expect(vars).toEqual({ 'run:token': 'abc', 'env:count': '2', 'glob:whole': '{"token":"abc","n":2}' })
    expect(outputs(events)).toEqual([{ token: 'abc', n: 2 }])
  })
})

describe('generated code', () => {
  it('wraps expressions so a trailing comment cannot swallow the closing parenthesis', () => {
    expect(expressionCode('input.ok // check')).toBe('return (input.ok // check\n)')
    expect(new Function('input', expressionCode('input.ok // check'))({ ok: true })).toBe(true)
    expect(setVariableCode({ name: ' a"b ', value: 'input', scope: 'run' })).toContain('pm.variables.set("a\\"b"')
  })
})
