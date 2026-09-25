/**
 * The sandbox as a security boundary: what a script can reach, resource limits, and isolation between scripts
 * and from the host. Scripts come from imported (untrusted) collections.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS } from '../../scripts/job'
import { job, run, script } from './harness'
import { runScriptChain } from '../../scripts/sandbox'

describe('sandbox: nothing outside the pm API is reachable', () => {
  it('has no Node, browser or QuickJS host objects', async () => {
    const r = await run({
      code: `
        const names = ['process', 'Buffer', 'module', 'exports', '__dirname', 'global', 'std', 'os', 'fetch', 'XMLHttpRequest',
          'WebSocket', 'Worker', 'importScripts', 'navigator', 'window', 'document', 'Deno', 'Bun', '__slinger_call', 'scriptArgs', 'print']
        pm.test('globals', () => pm.expect(names.filter((n) => typeof globalThis[n] !== 'undefined')).to.eql([]))
      `,
    })
    expect(r.errors).toEqual([])
    expect(r.tests).toEqual([expect.objectContaining({ name: 'globals', status: 'passed' })])
  })

  it('cannot load modules (static import, dynamic import, require)', async () => {
    const staticImport = await run({ code: `import fs from 'fs'` })
    expect(staticImport.errors[0]).toMatchObject({ kind: 'error' })
    expect(staticImport.errors[0].message).toMatch(/SyntaxError/)

    const dynamic = await run({ code: `import('fs').then(() => console.log('LOADED'), (e) => console.log('refused: ' + e.message))` })
    expect(dynamic.console.map((c) => c.message).join()).not.toContain('LOADED')

    const req = await run({ code: `require('child_process').exec('id')` })
    expect(req.errors[0].message).toMatch(/require\('child_process'\) is not supported/)
  })

  it('cannot read files, the network or the environment through Function/eval tricks', async () => {
    const r = await run({
      code: `
        const g = (0, eval)('this')
        const viaFunction = Function('return typeof process')()
        const ctorEscape = (() => {}).constructor('return typeof require')()
        pm.test('no escape', () => {
          pm.expect(g).to.equal(globalThis)
          pm.expect(viaFunction).to.equal('undefined')
          pm.expect(ctorEscape).to.equal('function') // our own require stub, which only throws
        })
        try { ctorEscape === 'function' && require('fs') } catch (e) { console.log(e.message) }
      `,
    })
    expect(r.errors).toEqual([])
    expect(r.tests[0].status).toBe('passed')
    expect(r.console[0].message).toMatch(/not supported/)
  })

  it('the host bridge is deleted before user code runs', async () => {
    const r = await run({ code: `pm.test('hidden', () => pm.expect(typeof __slinger_call).to.equal('undefined'))` })
    expect(r.tests[0].status).toBe('passed')
  })
})

describe('sandbox: resource limits', () => {
  it('stops an infinite loop at the deadline and reports a timeout', async () => {
    const started = Date.now()
    const r = await run({ code: 'while (true) {}', limits: { ...DEFAULT_LIMITS, timeoutMs: 300 } })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(r.errors).toEqual([{ source: 'Pre-request · request “R”', kind: 'timeout', message: 'Script timed out after 300 ms' }])
  })

  it('stops a never-settling promise loop too', async () => {
    const r = await run({ code: 'const spin = () => Promise.resolve().then(spin); spin()', limits: { ...DEFAULT_LIMITS, timeoutMs: 300 } })
    expect(r.errors[0].kind).toBe('timeout')
  })

  it('still records tests that ran before a timeout', async () => {
    const r = await run({ event: 'test', code: `pm.test('early', () => {}); tests['legacy'] = true; while (true) {}`, limits: { ...DEFAULT_LIMITS, timeoutMs: 200 } })
    expect(r.errors[0].kind).toBe('timeout')
    expect(r.tests.map((t) => [t.name, t.status])).toEqual([
      ['early', 'passed'],
      ['legacy', 'passed'],
    ])
  })

  it('enforces the memory limit', async () => {
    for (const code of [`const parts = []; for (;;) parts.push(new Uint8Array(1 << 20))`, `const parts = []; for (;;) parts.push([parts.length, 'abc'])`]) {
      const r = await run({ code, limits: { ...DEFAULT_LIMITS, memoryBytes: 16 * 1024 * 1024, timeoutMs: 10_000 } })
      expect(r.errors).toEqual([{ source: 'Pre-request · request “R”', kind: 'memory', message: 'Script ran out of memory (limit 16 MB)' }])
    }
  })

  it('reports runaway recursion as a normal error', async () => {
    const r = await run({ code: 'function f() { return f() + 1 } f()' })
    expect(r.errors[0]).toMatchObject({ kind: 'error', message: expect.stringMatching(/^InternalError: stack overflow/) })
    // The engine is still healthy afterwards.
    expect((await run({ code: 'console.log(1 + 1)' })).console[0].message).toBe('2')
  })

  it('caps console output (entries and size) and says so', async () => {
    const r = await run({ code: `for (let i = 0; i < 100000; i++) console.log('line ' + i + ' ' + 'x'.repeat(100))` })
    expect(r.errors).toEqual([])
    expect(r.console.length).toBeLessThanOrEqual(DEFAULT_LIMITS.consoleEntries + 1)
    const total = r.console.reduce((n, c) => n + c.message.length, 0)
    expect(total).toBeLessThanOrEqual(DEFAULT_LIMITS.consoleBytes + 200)
    expect(r.console.at(-1)?.message).toMatch(/limit reached/)
  })

  it('truncates a single huge console message', async () => {
    const r = await run({ code: `console.log('y'.repeat(200000))` })
    expect(r.console[0].message.length).toBeLessThan(DEFAULT_LIMITS.messageChars + 100)
    expect(r.console[0].message).toMatch(/more characters\)$/)
  })

  it('refuses oversized variable values and caps the number of tests', async () => {
    const big = await run({ code: `pm.variables.set('big', 'z'.repeat(1_000_001))` })
    expect(big.errors[0].message).toMatch(/too large/)
    const many = await run({ code: `for (let i = 0; i < 1100; i++) pm.test('t' + i, () => {})` })
    expect(many.tests).toHaveLength(DEFAULT_LIMITS.tests)
    expect(many.console.at(-1)?.message).toMatch(/More than 1000 tests/)
  })

  it('stops when cancelled, and skips the rest of the chain', async () => {
    // In-thread the event loop is blocked by the script, so the cancel flag is time based here (worker.test.ts
    // covers a real cancel from another thread).
    const cancelAt = Date.now() + 150
    const r = await runScriptChain(
      job({ scripts: [script('while (true) {}', 'collection', 'C'), script('console.log("never")')], limits: { ...DEFAULT_LIMITS, timeoutMs: 10_000 } }),
      { readSecret: () => null, isCancelled: () => Date.now() > cancelAt },
    )
    expect(r.errors).toEqual([{ source: 'Pre-request · collection “C”', kind: 'cancelled', message: 'Cancelled' }])
    expect(r.console).toEqual([])
  })
})

describe('sandbox: isolation', () => {
  it('prototype pollution inside the sandbox never reaches host objects', async () => {
    const r = await run({
      code: `
        Object.prototype.polluted = 'yes'
        Array.prototype.push = function () { return 0 }
        JSON.parse = () => ({ v: 'forged' })
        pm.variables.set('__proto__', { polluted: 'host' })
        pm.globals.set('constructor', 'x')
        pm.collectionVariables.set('toString', 'y')
      `,
    })
    expect(r.errors).toEqual([])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(r.variables, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(r.variables)).toBe(Object.prototype)
    expect(typeof r.globals.constructor).toBe('string')
    expect(r.collectionVariables.toString).toBe('y')
    expect([1].push(2)).toBe(2)
  })

  it('each script of a chain gets a fresh context: globals and pollution do not carry over', async () => {
    const r = await run({
      scripts: [
        script(`globalThis.leak = 1; Object.prototype.tainted = true; pm.expect = () => { throw new Error('hijacked') }`, 'collection', 'C'),
        script(`pm.test('clean', () => { pm.expect(typeof leak).to.equal('undefined'); pm.expect(({}).tainted).to.be.undefined })`, 'request', 'R'),
      ],
    })
    expect(r.errors).toEqual([])
    expect(r.tests).toEqual([expect.objectContaining({ name: 'clean', status: 'passed', source: 'Pre-request · request “R”' })])
  })

  it('only shared state (variables, request) flows between scripts, in collection -> folder -> request order', async () => {
    const r = await run({
      scripts: [
        script(`pm.variables.set('order', ['collection']); console.log('c')`, 'collection', 'Col'),
        script(`pm.variables.set('order', pm.variables.get('order').concat('outer')); console.log('f1')`, 'folder', 'Outer'),
        script(`pm.variables.set('order', pm.variables.get('order').concat('inner')); console.log('f2')`, 'folder', 'Inner'),
        script(`pm.variables.set('order', pm.variables.get('order').concat('request')); console.log('r')`, 'request', 'Req'),
      ],
    })
    expect(r.variables.order).toEqual(['collection', 'outer', 'inner', 'request'])
    expect(r.console.map((c) => c.source)).toEqual([
      'Pre-request · collection “Col”',
      'Pre-request · folder “Outer”',
      'Pre-request · folder “Inner”',
      'Pre-request · request “Req”',
    ])
  })

  it('a failing pre-request script stops the chain unless continueOnError; test scripts always all run', async () => {
    const chain = [script(`throw new Error('first')`, 'collection', 'C'), script(`console.log('second ran')`)]
    const stopped = await run({ scripts: chain })
    expect(stopped.errors.map((e) => e.message)).toEqual(['Error: first (line 1)'])
    expect(stopped.console).toEqual([])

    const continued = await run({ scripts: chain, continueOnError: true })
    expect(continued.console.map((c) => c.message)).toEqual(['second ran'])

    const tests = await run({ event: 'test', scripts: chain })
    expect(tests.console.map((c) => c.message)).toEqual(['second ran'])
  })

  it('a thrown non-Error value is reported', async () => {
    const r = await run({ code: `throw 'plain string'` })
    expect(r.errors[0].message).toBe('Uncaught plain string')
  })
})
