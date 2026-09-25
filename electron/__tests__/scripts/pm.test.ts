/**
 * Postman-compatible semantics of the `pm` API, as a table: each case runs a script and checks what it
 * reported. Assertions inside the sandbox use pm.test, so a failing case shows the sandbox's own message.
 */
import { describe, expect, it } from 'vitest'
import { RESPONSE, run } from './harness'

const ENV = {
  name: 'Staging',
  variables: [
    { id: 'v-base', key: 'baseUrl', value: 'https://staging.example.com', secret: false },
    { id: 'v-user', key: 'user', value: 'ada', secret: false },
    { id: 'v-tok', key: 'apiKey', value: null, secret: true },
  ],
}
const secrets: Record<string, string> = { 'v-tok': 'sk-live-123' }
const readSecret = (id: string) => secrets[id] ?? null

/** Runs `code` as a test script against RESPONSE and returns failing test messages (empty = all passed). */
async function check(code: string, opts: { event?: 'prerequest' | 'test' } = {}) {
  const r = await run(
    {
      event: opts.event ?? 'test',
      response: opts.event === 'prerequest' ? null : RESPONSE,
      environment: ENV,
      collectionVariables: { cv: 'collection-value', shared: 'from-collection' },
      globals: { g: 'global-value', shared: 'from-globals' },
      variables: { local: 'local-value' },
      code,
    },
    { readSecret },
  )
  return { r, failures: r.tests.filter((t) => t.status !== 'passed').map((t) => `${t.name}: ${t.error}`), errors: r.errors }
}

// [description, script body that must pass]
const PASSING: Array<[string, string]> = [
  // environment
  ['environment.get reads a plain value', `pm.expect(pm.environment.get('user')).to.equal('ada')`],
  ['environment.get of a missing key is undefined', `pm.expect(pm.environment.get('nope')).to.be.undefined`],
  ['environment.has', `pm.expect(pm.environment.has('user')).to.be.true; pm.expect(pm.environment.has('x')).to.be.false`],
  ['environment.name', `pm.expect(pm.environment.name).to.equal('Staging')`],
  ['environment.get reads a secret by name', `pm.expect(pm.environment.get('apiKey')).to.equal('sk-live-123')`],
  ['environment.toObject leaves secrets out', `const o = pm.environment.toObject(); pm.expect(o).to.have.property('user', 'ada'); pm.expect(o).to.not.have.property('apiKey')`],
  ['environment.set then get (same run)', `pm.environment.set('n', 5); pm.expect(pm.environment.get('n')).to.equal('5')`],
  ['environment.set stores objects as JSON', `pm.environment.set('o', {a: 1}); pm.expect(pm.environment.get('o')).to.equal('{"a":1}')`],
  ['environment.unset', `pm.environment.unset('user'); pm.expect(pm.environment.has('user')).to.be.false`],
  // variables precedence: local > environment > collection > globals
  ['variables.get local', `pm.expect(pm.variables.get('local')).to.equal('local-value')`],
  ['variables.get falls back to environment', `pm.expect(pm.variables.get('user')).to.equal('ada')`],
  ['variables.get falls back to collection', `pm.expect(pm.variables.get('cv')).to.equal('collection-value')`],
  ['variables.get falls back to globals', `pm.expect(pm.variables.get('g')).to.equal('global-value')`],
  ['collection beats globals', `pm.expect(pm.variables.get('shared')).to.equal('from-collection')`],
  ['variables.set shadows environment', `pm.variables.set('user', 'local'); pm.expect(pm.variables.get('user')).to.equal('local'); pm.expect(pm.environment.get('user')).to.equal('ada')`],
  ['variables keep types', `pm.variables.set('count', 1); pm.expect(pm.variables.get('count') + 1).to.equal(2)`],
  ['variables.has', `pm.expect(pm.variables.has('cv')).to.be.true; pm.expect(pm.variables.has('none')).to.be.false`],
  ['replaceIn resolves nested and unknown stays', `pm.expect(pm.variables.replaceIn('{{baseUrl}}/u/{{user}}/{{unknown}}')).to.equal('https://staging.example.com/u/ada/{{unknown}}')`],
  ['replaceIn built-ins', `const v = pm.variables.replaceIn('{{$guid}}|{{$timestamp}}|{{$randomInt}}'); const [g, t, i] = v.split('|'); pm.expect(g).to.match(/^[0-9a-f-]{36}$/); pm.expect(Number(t)).to.be.above(1600000000); pm.expect(Number(i)).to.be.within(0, 999999)`],
  ['replaceIn: a built-in has one value per call', `const v = pm.variables.replaceIn('{{$guid}}={{$guid}}').split('='); pm.expect(v[0]).to.equal(v[1])`],
  ['collectionVariables get/set/unset', `pm.collectionVariables.set('a', 'b'); pm.expect(pm.collectionVariables.get('a')).to.equal('b'); pm.collectionVariables.unset('a'); pm.expect(pm.collectionVariables.has('a')).to.be.false`],
  ['globals get/set', `pm.globals.set('x', true); pm.expect(pm.globals.get('x')).to.equal(true)`],
  // response
  ['response code/status/time/size', `pm.expect(pm.response.code).to.equal(200); pm.expect(pm.response.status).to.equal('OK'); pm.expect(pm.response.responseTime).to.equal(42); pm.expect(pm.response.responseSize).to.equal(80)`],
  ['response.json()', `pm.expect(pm.response.json().user.roles).to.eql(['admin', 'dev'])`],
  ['response.text()', `pm.expect(pm.response.text()).to.include('t-123')`],
  ['response.headers.get is case-insensitive', `pm.expect(pm.response.headers.get('content-type')).to.equal('application/json')`],
  ['response.to.have.status', `pm.response.to.have.status(200); pm.response.to.have.status('OK')`],
  ['response.to.be.ok / success / not.error', `pm.response.to.be.ok; pm.response.to.be.success; pm.response.to.not.be.error`],
  ['response.to.have.header', `pm.response.to.have.header('Content-Type'); pm.response.to.have.header('content-type', 'application/json')`],
  ['response.to.have.jsonBody', `pm.response.to.have.jsonBody(); pm.response.to.have.jsonBody('user.id'); pm.response.to.have.jsonBody('user.id', 7); pm.response.to.be.json`],
  ['response.to.have.body', `pm.response.to.have.body(); pm.response.to.have.body(/t-123/)`],
  ['pm.expect(pm.response).to.have.status', `pm.expect(pm.response).to.have.status(200)`],
  ['cookies from Set-Cookie', `pm.expect(pm.cookies.get('sid')).to.equal('abc'); pm.expect(pm.cookies.has('x')).to.be.false`],
  // expect subset
  ['equal / eql / deep.equal', `pm.expect(1).to.equal(1); pm.expect({a: [1]}).to.eql({a: [1]}); pm.expect({a: 1}).to.deep.equal({a: 1}); pm.expect({}).to.not.equal({})`],
  ['a / an', `pm.expect('s').to.be.a('string'); pm.expect([]).to.be.an('array'); pm.expect(null).to.be.a('null'); pm.expect({}).to.be.an('object'); pm.expect(1).to.not.be.a('string')`],
  ['include (string, array, object)', `pm.expect('hello').to.include('ell'); pm.expect([1, 2]).to.include(2); pm.expect({a: 1, b: 2}).to.include({a: 1}); pm.expect([{a: 1}]).to.deep.include({a: 1})`],
  ['have.property / nested / chained value', `pm.expect({a: {b: 2}}).to.have.property('a').that.has.property('b', 2); pm.expect({a: {b: [5]}}).to.have.nested.property('a.b[0]', 5)`],
  ['oneOf', `pm.expect(201).to.be.oneOf([200, 201])`],
  ['above / below / least / most / within', `pm.expect(5).to.be.above(4).and.below(6); pm.expect(5).to.be.at.least(5); pm.expect(5).to.be.at.most(5); pm.expect(5).to.be.within(1, 9)`],
  ['length / lengthOf / lengthOf.above', `pm.expect([1, 2, 3]).to.have.length(3); pm.expect('ab').to.have.lengthOf(2); pm.expect([1, 2, 3]).to.have.lengthOf.above(2)`],
  ['exist / true / false / null / undefined / empty', `pm.expect(0).to.exist; pm.expect(true).to.be.true; pm.expect(false).to.be.false; pm.expect(null).to.be.null; pm.expect(undefined).to.be.undefined; pm.expect([]).to.be.empty; pm.expect(null).to.not.exist`],
  ['match / keys / members', `pm.expect('abc').to.match(/b/); pm.expect({a: 1, b: 2}).to.have.keys('a', 'b'); pm.expect({a: 1, b: 2}).to.have.any.keys('a', 'z'); pm.expect([1, 2]).to.have.members([2, 1]); pm.expect([1, 2, 3]).to.include.members([2])`],
  ['throw', `pm.expect(() => { throw new Error('boom') }).to.throw('boom'); pm.expect(() => 1).to.not.throw()`],
  // info
  ['pm.info', `pm.expect(pm.info.eventName).to.equal('test'); pm.expect(pm.info.requestName).to.equal('Get users'); pm.expect(pm.info.iteration).to.equal(0)`],
  // legacy API
  ['legacy responseBody / responseCode / responseHeaders', `pm.expect(JSON.parse(responseBody).token).to.equal('t-123'); pm.expect(responseCode.code).to.equal(200); pm.expect(responseHeaders['Content-Type']).to.equal('application/json')`],
  ['legacy postman.getEnvironmentVariable', `pm.expect(postman.getEnvironmentVariable('user')).to.equal('ada')`],
  ['btoa / atob', `pm.expect(btoa('user:pass')).to.equal('dXNlcjpwYXNz'); pm.expect(atob('dXNlcjpwYXNz')).to.equal('user:pass')`],
]

describe('pm API (Postman-compatible cases)', () => {
  it.each(PASSING)('%s', async (_name, body) => {
    const { failures, errors } = await check(`pm.test('case', function () { ${body} })`)
    expect(errors).toEqual([])
    expect(failures).toEqual([])
  })

  // [description, failing assertion, expected message]
  const FAILING: Array<[string, string, string]> = [
    ['status', `pm.response.to.have.status(404)`, 'AssertionError: expected response to have status code 404 but got 200'],
    ['equal', `pm.expect(1).to.equal(2)`, 'AssertionError: expected 1 to equal 2'],
    ['eql', `pm.expect({a: 1}).to.eql({a: 2})`, 'AssertionError: expected { a: 1 } to deeply equal { a: 2 }'],
    ['include', `pm.expect('abc').to.include('z')`, "AssertionError: expected 'abc' to include 'z'"],
    ['property', `pm.expect({}).to.have.property('id')`, "AssertionError: expected {} to have property 'id'"],
    ['a', `pm.expect(1).to.be.a('string')`, 'AssertionError: expected 1 to be a string'],
    ['header', `pm.response.to.have.header('X-Missing')`, "AssertionError: expected response to have header 'X-Missing'"],
    ['message prefix', `pm.expect(1, 'status check').to.equal(2)`, 'AssertionError: status check: expected 1 to equal 2'],
    ['json error', `pm.expect(JSON.parse('{')).to.exist`, 'SyntaxError'],
  ]
  it.each(FAILING)('failing %s reports a Postman-like message', async (_n, body, message) => {
    const { r } = await check(`pm.test('case', function () { ${body} })`)
    expect(r.tests).toHaveLength(1)
    expect(r.tests[0]).toMatchObject({ name: 'case', status: 'failed' })
    expect(r.tests[0].error).toContain(message)
  })

  it('records every test in order with pass/fail/skip, including legacy tests[] and async tests', async () => {
    const { r } = await check(`
      pm.test('one', () => {})
      pm.test('two', () => { throw new Error('nope') })
      pm.test.skip('three', () => {})
      pm.test('async', () => Promise.resolve().then(() => pm.expect(1).to.equal(1)))
      pm.test('async fail', async () => { await null; pm.expect(1).to.equal(3) })
      pm.test('done cb', (done) => { Promise.resolve().then(() => done()) })
      pm.test('done never called', (done) => {})
      tests['legacy pass'] = true
      tests['legacy fail'] = 0
    `)
    expect(r.errors).toEqual([])
    expect(r.tests.map((t) => [t.name, t.status])).toEqual([
      ['one', 'passed'],
      ['two', 'failed'],
      ['three', 'skipped'],
      // async results arrive in promise-settlement order
      ['done cb', 'passed'],
      ['async', 'passed'],
      ['async fail', 'failed'],
      ['legacy pass', 'passed'],
      ['legacy fail', 'failed'],
      ['done never called', 'failed'],
    ])
    expect(r.tests[1].error).toBe('Error: nope')
    expect(r.tests.every((t) => t.source === 'Tests · request “R”')).toBe(true)
  })

  it('pm.request is mutable in pre-request scripts (url, method, headers, query, body)', async () => {
    const { r, errors } = await check(
      `
      pm.request.headers.add({ key: 'X-Trace', value: '1' })
      pm.request.headers.upsert({ key: 'accept', value: 'text/plain' })
      pm.request.headers.remove('X-Nope')
      pm.request.url.query.upsert({ key: 'page', value: '2' })
      pm.request.url.query.add({ key: 'q', value: '{{user}}' })
      pm.request.method = 'post'
      pm.request.body.update({ hello: 'world' })
      pm.test('reads back', () => {
        pm.expect(pm.request.url.toString()).to.equal('https://api.example.com/users?page=2&q={{user}}')
        pm.expect(pm.request.url.getHost()).to.equal('api.example.com')
        pm.expect(pm.request.url.getPath()).to.equal('/users')
        pm.expect(pm.request.headers.get('Accept')).to.equal('text/plain')
        pm.expect(pm.request.body.raw).to.equal('{"hello":"world"}')
      })
    `,
      { event: 'prerequest' },
    )
    expect(errors).toEqual([])
    expect(r.tests[0].status).toBe('passed')
    expect(r.request).toEqual({
      method: 'POST',
      url: 'https://api.example.com/users?page=2&q={{user}}',
      headers: [
        { key: 'Accept', value: 'text/plain' },
        { key: 'X-Trace', value: '1' },
      ],
      body: { mode: 'raw', raw: '{"hello":"world"}', language: 'json' },
    })
  })

  it('assigning pm.request.url replaces the URL', async () => {
    const { r } = await check(`pm.request.url = '{{baseUrl}}/v2'`, { event: 'prerequest' })
    expect(r.request?.url).toBe('{{baseUrl}}/v2')
  })

  it('an untouched request is reported as unchanged (null)', async () => {
    const { r } = await check(`pm.variables.set('a', 1)`, { event: 'prerequest' })
    expect(r.request).toBeNull()
  })

  it('require of unknown modules and timers fail with a clear "not supported" error', async () => {
    for (const code of [`require('postman-collection')`, `setTimeout(() => {}, 1)`]) {
      const { errors } = await check(code)
      expect(errors).toHaveLength(1)
      expect(errors[0].kind).toBe('error')
      expect(errors[0].message).toMatch(/not supported/)
    }
  })

  it('console output is captured with levels and formatting', async () => {
    const { r } = await check(`console.log('a', 1, {b: [1, 'x']}); console.info('%s=%d', 'n', 5); console.warn(null, undefined); console.error(new Error('bad'))`)
    expect(r.console.map((c) => [c.level, c.message])).toEqual([
      ['log', "a 1 { b: [ 1, 'x' ] }"],
      ['info', 'n=5'],
      ['warn', 'null undefined'],
      ['error', 'Error: bad'],
    ])
  })

  it('reports the line of an uncaught error', async () => {
    const { errors } = await check(`const a = 1\nconst b = 2\nundefinedFunction()`)
    expect(errors[0].message).toBe("ReferenceError: 'undefinedFunction' is not defined (line 3)")
  })
})
