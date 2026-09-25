/**
 * Autocomplete for script editors: members of the `pm` API (after `pm.`, `pm.environment.`, ...) and snippets
 * for the common Postman patterns (typed at the start of a word: "test", "status", "setenv", ...).
 */
import { autocompletion, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'

const fn = (label: string, detail: string, info?: string): Completion => ({ label, type: 'function', detail, info, apply: label })
const prop = (label: string, detail: string, info?: string): Completion => ({ label, type: 'property', detail, info })

const SCOPE_METHODS = (scope: string): Completion[] => [
  fn('get', '(name)', `Value of a ${scope} variable, or undefined`),
  fn('set', '(name, value)', `Sets a ${scope} variable`),
  fn('has', '(name)', `True when the ${scope} variable exists`),
  fn('unset', '(name)', `Removes a ${scope} variable`),
  fn('toObject', '()', `All ${scope} variables as an object`),
  fn('replaceIn', '(text)', 'Resolves {{variables}} in a string'),
  fn('clear', '()', `Removes every ${scope} variable`),
]

/** Members by the object path before the dot. */
export const PM_MEMBERS: Record<string, Completion[]> = {
  pm: [
    prop('environment', 'active environment', 'Persisted: writes are saved to the active environment'),
    prop('variables', 'local scope', 'pm.variables: this send / collection run; get() resolves local > environment > collection > globals'),
    prop('collectionVariables', 'session scope', 'Kept in memory until the app restarts'),
    prop('globals', 'session scope', 'Kept in memory until the app restarts'),
    prop('request', 'the request', 'Mutable in pre-request scripts (sent copy only)'),
    prop('response', 'the response', 'Available in test scripts'),
    prop('info', 'run info', 'eventName, requestName, requestId, iteration'),
    prop('cookies', 'response cookies', 'get(name), has(name), toObject()'),
    fn('test', '(name, fn)', 'Records a named test; it fails when fn throws'),
    fn('expect', '(value)', 'Chai-style assertion: pm.expect(x).to.equal(y)'),
    fn('sendRequest', '()', 'Not supported in Slinger (scripts cannot make network requests)'),
  ],
  'pm.environment': [prop('name', 'environment name'), ...SCOPE_METHODS('environment')],
  'pm.variables': SCOPE_METHODS('local'),
  'pm.collectionVariables': SCOPE_METHODS('collection'),
  'pm.globals': SCOPE_METHODS('global'),
  'pm.request': [
    prop('url', 'Url', 'toString(), update(), getHost(), getPath(), query'),
    prop('method', 'string'),
    prop('headers', 'PropertyList', 'get, has, add, upsert, remove, toObject'),
    prop('body', 'RequestBody', 'raw, mode, update(value)'),
  ],
  'pm.request.headers': [fn('get', '(name)'), fn('has', '(name)'), fn('add', '({ key, value })'), fn('upsert', '({ key, value })'), fn('remove', '(name)'), fn('toObject', '()'), fn('all', '()')],
  'pm.request.url': [fn('toString', '()'), fn('update', '(url)'), fn('getHost', '()'), fn('getPath', '()'), fn('getQueryString', '()'), prop('query', 'PropertyList')],
  'pm.request.body': [prop('raw', 'string'), prop('mode', 'string'), fn('update', '(value)')],
  'pm.response': [
    prop('code', 'number', 'HTTP status code'),
    prop('status', 'string', 'Reason phrase, e.g. "OK"'),
    prop('responseTime', 'number', 'Milliseconds'),
    prop('responseSize', 'number', 'Body bytes'),
    prop('headers', 'PropertyList', 'get(name) is case-insensitive'),
    fn('json', '()', 'Parses the body as JSON'),
    fn('text', '()', 'The body as text'),
    prop('to', 'assertion', 'pm.response.to.have.status(200)'),
  ],
  'pm.response.headers': [fn('get', '(name)'), fn('has', '(name)'), fn('toObject', '()'), fn('all', '()')],
  'pm.info': [prop('eventName', "'prerequest' | 'test'"), prop('requestName', 'string'), prop('requestId', 'string'), prop('iteration', 'number'), prop('iterationCount', 'number')],
  'pm.cookies': [fn('get', '(name)'), fn('has', '(name)'), fn('toObject', '()')],
  console: [fn('log', '(...values)'), fn('info', '(...values)'), fn('warn', '(...values)'), fn('error', '(...values)')],
}

export const PM_SNIPPETS: Completion[] = [
  snippetCompletion("pm.test('${name}', () => {\n\t${}\n})", { label: 'test', detail: 'pm.test(...)', type: 'keyword' }),
  snippetCompletion("pm.test('Status code is ${200}', () => {\n\tpm.response.to.have.status(${200})\n})", { label: 'status', detail: 'status code test', type: 'keyword' }),
  snippetCompletion("pm.test('Response time is below ${500} ms', () => {\n\tpm.expect(pm.response.responseTime).to.be.below(${500})\n})", { label: 'responsetime', detail: 'response time test', type: 'keyword' }),
  snippetCompletion("const json = pm.response.json()\npm.test('${Has id}', () => {\n\tpm.expect(json).to.have.property('${id}')\n})", { label: 'jsonprop', detail: 'JSON property test', type: 'keyword' }),
  snippetCompletion("pm.environment.set('${token}', pm.response.json().${token})", { label: 'setenv', detail: 'save a response value', type: 'keyword' }),
  snippetCompletion("pm.environment.get('${name}')", { label: 'getenv', detail: 'read an environment variable', type: 'keyword' }),
  snippetCompletion("pm.request.headers.upsert({ key: '${X-Header}', value: '${value}' })", { label: 'header', detail: 'add/replace a request header', type: 'keyword' }),
  snippetCompletion("pm.variables.set('${name}', ${value})", { label: 'setvar', detail: 'local variable', type: 'keyword' }),
]

/** Completion source: `pm.` members by path, snippets at the start of a bare word. */
export function pmCompletionSource(ctx: CompletionContext): CompletionResult | null {
  const member = ctx.matchBefore(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.[\w$]*$/)
  if (member) {
    const dot = member.text.lastIndexOf('.')
    const path = member.text.slice(0, dot)
    const options = PM_MEMBERS[path]
    if (!options) return null
    return { from: member.from + dot + 1, options, validFor: /^[\w$]*$/ }
  }
  const word = ctx.matchBefore(/[\w$]+$/)
  if (!word && !ctx.explicit) return null
  const before = word ? ctx.state.sliceDoc(Math.max(0, word.from - 1), word.from) : ''
  if (before === '.') return null
  return {
    from: word ? word.from : ctx.pos,
    options: [...PM_SNIPPETS, { label: 'pm', type: 'variable', detail: 'Postman API' }, { label: 'console', type: 'variable' }],
    validFor: /^[\w$]*$/,
  }
}

export function pmCompletion(): Extension {
  return autocompletion({ override: [pmCompletionSource], activateOnTyping: true, icons: true })
}
