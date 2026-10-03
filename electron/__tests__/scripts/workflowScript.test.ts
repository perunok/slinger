/**
 * Workflow JavaScript (Evaluate / If / For each / Set variable nodes) through the real QuickJS sandbox: the wrapper
 * from shared/workflowScript.ts must hand `input` in and the return value out, support `await`, and report sync and
 * async errors as script errors. The renderer's tests use a mock without a sandbox, so this is where it is proven.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunScriptsInput } from '../../../shared/types'
import { WORKFLOW_INPUT_KEY, WORKFLOW_OUTPUT_KEY, workflowScript } from '../../../shared/workflowScript'
import { expressionCode, setVariableCode } from '../../../src/lib/workflow/engine'
import { makeEnv, scaffold, type TestEnv } from '../helpers'

let env: TestEnv
let wsId: string
beforeEach(async () => {
  env = makeEnv()
  wsId = (await scaffold(env)).workspace.id
})
afterEach(() => env.cleanup())

let seq = 0
async function evaluate(code: string, input: unknown, variables: Record<string, unknown> = {}) {
  const job: RunScriptsInput = {
    runId: `wf-${++seq}`,
    sessionId: 'wf-session',
    workspaceId: wsId,
    environmentId: null,
    event: 'prerequest',
    scripts: [{ origin: 'request', name: 'Evaluate', code: workflowScript(code) }],
    request: { method: 'GET', url: 'http://workflow.invalid/', headers: [], body: { mode: 'none' } },
    response: null,
    variables,
    collectionId: null,
    collectionVariables: {},
    info: { requestName: 'Evaluate', requestId: null, iteration: 0, iterationCount: 1 },
    iterationData: input === undefined ? {} : { [WORKFLOW_INPUT_KEY]: input },
  }
  const r = await env.api.runScripts(job)
  return { output: r.variables[WORKFLOW_OUTPUT_KEY], errors: r.errors, variables: r.variables }
}

describe('workflow scripts in the sandbox', () => {
  it('gets the input and returns a value (objects intact)', async () => {
    const r = await evaluate('return { id: input.users[1].id, n: input.users.length }', { users: [{ id: 1 }, { id: 2 }] })
    expect(r.errors).toEqual([])
    expect(r.output).toEqual({ id: 2, n: 2 })
  })

  it('awaits, uses the built-in libraries, and gives null for no return value', async () => {
    expect((await evaluate("const _ = require('lodash'); return await Promise.resolve(_.sum(input))", [1, 2, 3])).output).toBe(6)
    expect((await evaluate('const x = 1', 'anything')).output).toBeNull()
    expect((await evaluate('return input', undefined)).output).toBeNull()
  })

  it('reports thrown errors, synchronous and asynchronous, with the user’s line numbers', async () => {
    const sync = await evaluate('return input.missing.deep', {})
    expect(sync.errors).toHaveLength(1)
    expect(sync.errors[0]!.message).toMatch(/TypeError/)
    expect(sync.output).toBeUndefined()
    const later = await evaluate("await null\nthrow new Error('boom')", null)
    expect(later.errors.map((e) => e.message)).toEqual([expect.stringContaining('boom')])
    expect(later.errors[0]!.message).toMatch(/line 2/)
  })

  it('If / For each expressions and Set variable code', async () => {
    expect((await evaluate(expressionCode('input.status === 200 // ok'), { status: 200 })).output).toBe(true)
    expect((await evaluate(expressionCode('input.body.items'), { body: { items: [1, 2] } })).output).toEqual([1, 2])
    const set = await evaluate(setVariableCode({ name: 'token', value: 'input.body.token', scope: 'run' }), { body: { token: 'abc' } }, { keep: 'me' })
    expect(set.errors).toEqual([])
    expect(set.variables).toMatchObject({ token: 'abc', keep: 'me' })
    expect(set.output).toEqual({ body: { token: 'abc' } })
  })
})
