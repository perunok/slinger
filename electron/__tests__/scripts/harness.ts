import type { ScriptSource } from '../../../shared/types'
import { DEFAULT_LIMITS, type ScriptJob, type ScriptJobResult, type ScriptRunnerDeps } from '../../scripts/job'
import { runScriptChain } from '../../scripts/sandbox'

export const REQ = { method: 'GET', url: 'https://api.example.com/users?page=1', headers: [{ key: 'Accept', value: 'application/json' }], body: { mode: 'none' as const } }

export function job(over: Partial<ScriptJob> = {}): ScriptJob {
  return {
    event: 'prerequest',
    scripts: [],
    request: structuredClone(REQ),
    response: null,
    variables: {},
    collectionVariables: {},
    globals: {},
    info: { requestName: 'Get users', requestId: null, iteration: 0, iterationCount: 1 },
    environment: null,
    readOnly: false,
    continueOnError: false,
    limits: { ...DEFAULT_LIMITS, timeoutMs: 1000 },
    ...over,
  }
}

export const script = (code: string, origin: ScriptSource['origin'] = 'request', name = 'R'): ScriptSource => ({ origin, name, code })

export function run(j: Partial<ScriptJob> & { code?: string }, deps: Partial<ScriptRunnerDeps> = {}): Promise<ScriptJobResult> {
  const { code, ...rest } = j
  const full = job({ ...rest, scripts: rest.scripts ?? (code !== undefined ? [script(code)] : []) })
  return runScriptChain(full, { readSecret: () => null, isCancelled: () => false, ...deps })
}

export const RESPONSE = {
  code: 200,
  status: 'OK',
  headers: [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'Set-Cookie', value: 'sid=abc; Path=/' },
  ],
  body: JSON.stringify({ token: 't-123', user: { id: 7, roles: ['admin', 'dev'] }, items: [1, 2, 3] }),
  responseTime: 42,
  size: 80,
}
