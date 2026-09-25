/**
 * Postman's built-in script libraries (require('crypto-js'), `_`, `CryptoJS`, xml2Json, ...), with Postman-style
 * snippets. Results that can be computed on the host (hashes, HMACs, ciphertexts) are compared with Node's crypto.
 */
import { createCipheriv, createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS } from '../../scripts/job'
import { RESPONSE, job, run, script } from './harness'
import { runScriptChain } from '../../scripts/sandbox'

const MODULES = ['ajv', 'atob', 'btoa', 'chai', 'cheerio', 'crypto-js', 'csv-parse/lib/sync', 'lodash', 'moment', 'tv4', 'uuid', 'xml2js']

/** Runs `code`; the script reports values with pm.variables.set. Fails the test on any script error or failed pm.test. */
async function values(code: string, over: Parameters<typeof run>[0] = {}) {
  const r = await run({ code, ...over })
  expect(r.errors).toEqual([])
  expect(r.tests.filter((t) => t.status !== 'passed')).toEqual([])
  return r.variables as Record<string, unknown>
}

describe('crypto-js', () => {
  it('signs a request like a real collection pre-request script (HMAC-SHA256, Base64, secret key)', async () => {
    const code = `
      // Typical API-gateway signing script (the failing case: require at the top of a collection script).
      const CryptoJS = require('crypto-js')
      const secret = pm.environment.get('apiSecret')
      const timestamp = '1727270000'
      const body = pm.request.body.raw || ''
      const payload = [pm.request.method, pm.request.url.toString(), timestamp, CryptoJS.SHA256(body).toString(CryptoJS.enc.Hex)].join('\\n')
      const signature = CryptoJS.HmacSHA256(payload, secret).toString(CryptoJS.enc.Base64)
      pm.request.headers.upsert({ key: 'X-Signature', value: signature })
      pm.variables.set('payload', payload)
      pm.variables.set('signature', signature)
    `
    const env = { name: 'uat', variables: [{ id: 'sec', key: 'apiSecret', value: null, secret: true }] }
    const r = await run(
      { environment: env, request: { method: 'POST', url: 'https://api.example.com/pay', headers: [], body: { mode: 'raw', raw: '{"amount":10}' } }, code },
      { readSecret: (id) => (id === 'sec' ? 's3cr3t-key' : null) },
    )
    expect(r.errors).toEqual([])
    const bodyHash = createHash('sha256').update('{"amount":10}').digest('hex')
    const payload = `POST\nhttps://api.example.com/pay\n1727270000\n${bodyHash}`
    expect(r.variables.payload).toBe(payload)
    const expected = createHmac('sha256', 's3cr3t-key').update(payload).digest('base64')
    expect(r.variables.signature).toBe(expected)
    expect(r.request?.headers).toContainEqual({ key: 'X-Signature', value: expected })
  })

  it('hashes, PBKDF2 and encodings match Node (MD5, SHA1, SHA256, SHA512, HmacSHA1/512, Hex, Base64, Utf8)', async () => {
    const v = await values(`
      const C = CryptoJS // the global, without require
      pm.variables.set('md5', C.MD5('héllo').toString())
      pm.variables.set('sha1', C.SHA1('héllo').toString())
      pm.variables.set('sha256', C.SHA256('héllo').toString(C.enc.Hex))
      pm.variables.set('sha512', C.SHA512('héllo').toString())
      pm.variables.set('hmac1', C.HmacSHA1('msg', 'k').toString(C.enc.Base64))
      pm.variables.set('hmac512', C.HmacSHA512('msg', 'k').toString())
      pm.variables.set('b64', C.enc.Base64.stringify(C.enc.Utf8.parse('héllo wörld')))
      pm.variables.set('utf8', C.enc.Base64.parse('aMOpbGxvIHfDtnJsZA==').toString(C.enc.Utf8))
      pm.variables.set('hex', C.enc.Hex.stringify(C.enc.Utf8.parse('ab')))
      pm.variables.set('same', require('crypto-js') === CryptoJS)
      pm.variables.set('pbkdf2Default', C.PBKDF2('pw', 'salt').toString())
      pm.variables.set('pbkdf2', C.PBKDF2('pw', 'salt', { keySize: 8, iterations: 100, hasher: C.algo.SHA256 }).toString())
      pm.variables.set('sha3', C.SHA3('a').toString().length)
      pm.variables.set('des', C.TripleDES.decrypt(C.TripleDES.encrypt('msg', 'k').toString(), 'k').toString(C.enc.Utf8))
    `)
    const h = (alg: string) => createHash(alg).update('héllo').digest('hex')
    expect(v).toMatchObject({
      md5: h('md5'),
      sha1: h('sha1'),
      sha256: h('sha256'),
      sha512: h('sha512'),
      hmac1: createHmac('sha1', 'k').update('msg').digest('base64'),
      hmac512: createHmac('sha512', 'k').update('msg').digest('hex'),
      b64: Buffer.from('héllo wörld').toString('base64'),
      utf8: 'héllo wörld',
      hex: '6162',
      same: true,
      // Postman's crypto-js 3.x defaults (SHA1, 1 iteration, 128-bit key), not 4.2's 250000 x SHA256.
      pbkdf2Default: pbkdf2Sync('pw', 'salt', 1, 16, 'sha1').toString('hex'),
      pbkdf2: pbkdf2Sync('pw', 'salt', 100, 32, 'sha256').toString('hex'),
      sha3: 128,
      des: 'msg',
    })
  })

  it('AES: passphrase round trip (random salt from the host) and CBC with key/iv equal to Node', async () => {
    const key = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'
    const iv = '0f0e0d0c0b0a09080706050403020100'
    const v = await values(`
      const CryptoJS = require('crypto-js')
      const a = CryptoJS.AES.encrypt('top secret', 'passphrase').toString()
      const b = CryptoJS.AES.encrypt('top secret', 'passphrase').toString()
      pm.variables.set('roundTrip', CryptoJS.AES.decrypt(a, 'passphrase').toString(CryptoJS.enc.Utf8))
      pm.variables.set('salted', a !== b)
      const key = CryptoJS.enc.Hex.parse('${key}')
      const iv = CryptoJS.enc.Hex.parse('${iv}')
      const enc = CryptoJS.AES.encrypt(CryptoJS.enc.Utf8.parse('hello aes'), key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 })
      pm.variables.set('cbc', enc.ciphertext.toString(CryptoJS.enc.Base64))
      pm.variables.set('cbcBack', CryptoJS.AES.decrypt(enc.toString(), key, { iv }).toString(CryptoJS.enc.Utf8))
      pm.variables.set('random', CryptoJS.lib.WordArray.random(16).toString().length)
    `)
    const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'))
    const expected = Buffer.concat([cipher.update('hello aes', 'utf8'), cipher.final()]).toString('base64')
    expect(v).toMatchObject({ roundTrip: 'top secret', salted: true, cbc: expected, cbcBack: 'hello aes', random: 32 })
  })
})

describe('lodash, moment, uuid, atob/btoa', () => {
  it('lodash as require() and as the global _', async () => {
    const v = await values(`
      const lodash = require('lodash')
      const users = [{ name: 'ada', role: 'admin' }, { name: 'bob', role: 'dev' }, { name: 'cy', role: 'dev' }]
      pm.variables.set('same', lodash === _)
      pm.variables.set('grouped', _.mapValues(_.groupBy(users, 'role'), (l) => l.map((u) => u.name)))
      pm.variables.set('get', _.get({ a: { b: [{ c: 3 }] } }, 'a.b[0].c'))
      pm.variables.set('uniq', _.uniq([1, 1, 2, 3, 3]))
      pm.variables.set('template', _.template('Hello <%= name %>!')({ name: 'Slinger' }))
      pm.variables.set('random', _.random(1, 6) >= 1)
      pm.variables.set('version', _.VERSION)
    `)
    expect(v).toMatchObject({ same: true, grouped: { admin: ['ada'], dev: ['bob', 'cy'] }, get: 3, uniq: [1, 2, 3], template: 'Hello Slinger!', random: true })
    expect(v.version).toMatch(/^4\./)
  })

  it('moment', async () => {
    const v = await values(`
      const moment = require('moment')
      pm.variables.set('leap', moment.utc('2024-02-29T10:00:00Z').add(1, 'year').format('YYYY-MM-DD'))
      pm.variables.set('diff', moment.utc('2024-03-01').diff(moment.utc('2024-02-01'), 'days'))
      pm.variables.set('unix', moment.unix(1700000000).utc().format())
      pm.variables.set('now', moment().toISOString())
      pm.variables.set('valid', moment('not a date', 'YYYY-MM-DD', true).isValid())
    `)
    expect(v).toMatchObject({ leap: '2025-02-28', diff: 29, unix: '2023-11-14T22:13:20Z', valid: false })
    expect(Math.abs(Date.parse(v.now as string) - Date.now())).toBeLessThan(60_000)
  })

  it('uuid: v4 from the host CSPRNG, callable module, other versions; crypto.randomUUID', async () => {
    const v = await values(`
      const uuid = require('uuid')
      const ids = []
      for (let i = 0; i < 200; i++) ids.push(uuid.v4())
      pm.variables.set('ids', ids)
      pm.variables.set('call', uuid())
      pm.variables.set('v7', uuid.v7())
      pm.variables.set('v5', uuid.v5('slinger', uuid.v5.URL))
      pm.variables.set('valid', uuid.validate(ids[0]) && uuid.version(ids[0]) === 4)
      pm.variables.set('native', crypto.randomUUID())
    `)
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    const ids = v.ids as string[]
    for (const id of [...ids, v.call, v.native]) expect(id).toMatch(V4)
    expect(new Set(ids).size).toBe(200)
    expect(v.v7).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(v.v5).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/)
    expect(v.valid).toBe(true)
  })

  it('crypto.getRandomValues fills integer arrays from the host and enforces the Web Crypto rules', async () => {
    const v = await values(`
      const a = crypto.getRandomValues(new Uint8Array(64))
      const b = crypto.getRandomValues(new Uint32Array(8))
      pm.variables.set('filled', a.some((x) => x !== 0) && b.some((x) => x !== 0))
      pm.variables.set('same', crypto.getRandomValues(a) === a)
      const err = (f) => { try { f(); return null } catch (e) { return e.message } }
      pm.variables.set('float', err(() => crypto.getRandomValues(new Float64Array(2))))
      pm.variables.set('big', err(() => crypto.getRandomValues(new Uint8Array(65537))))
    `)
    expect(v).toMatchObject({ filled: true, same: true })
    expect(v.float).toMatch(/integer typed array/)
    expect(v.big).toMatch(/65536 bytes/)
  })

  it("require('atob') / require('btoa') are the globals", async () => {
    const v = await values(`
      pm.variables.set('same', require('atob') === atob && require('btoa') === btoa)
      pm.variables.set('basic', 'Basic ' + btoa('user:pass'))
      pm.variables.set('back', require('atob')('dXNlcjpwYXNz'))
    `)
    expect(v).toEqual({ same: true, basic: `Basic ${Buffer.from('user:pass').toString('base64')}`, back: 'user:pass' })
  })
})

describe('chai, tv4, ajv', () => {
  it("require('chai') is a working chai (pm.expect stays Slinger's own)", async () => {
    const r = await run({
      event: 'test',
      response: RESPONSE,
      code: `
        const { expect, assert } = require('chai')
        const body = pm.response.json()
        pm.test('chai expect', () => { expect(body).to.have.nested.property('user.roles').that.includes('admin'); expect({ a: [1] }).to.deep.equal({ a: [1] }) })
        pm.test('chai assert', () => assert.strictEqual(body.token, 't-123'))
        pm.test('chai failure', () => expect(body.user.id).to.equal(8))
      `,
    })
    expect(r.errors).toEqual([])
    expect(r.tests.map((t) => [t.name, t.status])).toEqual([
      ['chai expect', 'passed'],
      ['chai assert', 'passed'],
      ['chai failure', 'failed'],
    ])
    expect(r.tests[2].error).toMatch(/expected 7 to equal 8/)
  })

  it('tv4 (global and require) and ajv validate response schemas', async () => {
    const r = await run({
      event: 'test',
      response: RESPONSE,
      code: `
        const schema = { type: 'object', required: ['token', 'user'], properties: { token: { type: 'string' }, user: { type: 'object', properties: { id: { type: 'integer' } } } } }
        const bad = { type: 'object', properties: { token: { type: 'number' } } }
        const body = pm.response.json()
        pm.test('tv4 valid', () => pm.expect(tv4.validate(body, schema)).to.be.true)
        pm.test('tv4 invalid', () => { pm.expect(require('tv4').validate(body, bad)).to.be.false; pm.expect(tv4.error.message).to.match(/Invalid type/) })
        const Ajv = require('ajv')
        const ajv = new Ajv({ allErrors: true, logger: console })
        pm.test('ajv valid', () => pm.expect(ajv.validate(schema, body)).to.be.true)
        const validate = ajv.compile(bad)
        pm.test('ajv invalid', () => { pm.expect(validate(body)).to.be.false; pm.expect(validate.errors[0].dataPath + ' ' + validate.errors[0].message).to.equal('.token should be number') })
      `,
    })
    expect(r.errors).toEqual([])
    expect(r.tests.filter((t) => t.status !== 'passed')).toEqual([])
    expect(r.tests).toHaveLength(4)
  })
})

describe('xml2Json, xml2js, csv-parse, cheerio', () => {
  const XML = `<?xml version="1.0"?>
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
      <soap:Body><GetUserResponse><User id="7"><Name> Ada </Name><Role>admin</Role><Role>dev</Role></User></GetUserResponse></soap:Body>
    </soap:Envelope>`

  it("xml2Json (Postman's global) parses a SOAP response", async () => {
    const r = await run({
      event: 'test',
      response: { ...RESPONSE, headers: [{ key: 'Content-Type', value: 'text/xml' }], body: XML },
      code: `
        const json = xml2Json(pm.response.text())
        const user = json['soap:Envelope']['soap:Body'].GetUserResponse.User
        pm.test('parsed', () => {
          pm.expect(user.$.id).to.equal('7')
          pm.expect(user.Name).to.equal('Ada')
          pm.expect(user.Role).to.eql(['admin', 'dev'])
        })
        pm.test('invalid xml gives an empty object', () => pm.expect(xml2Json('<a><b></a>')).to.eql({}))
      `,
    })
    expect(r.errors).toEqual([])
    expect(r.tests.map((t) => t.status)).toEqual(['passed', 'passed'])
  })

  it('xml2js: parseString (callback), parseStringPromise and Builder', async () => {
    const v = await values(`
      const xml2js = require('xml2js')
      xml2js.parseString('<r><i>1</i><i>2</i></r>', (err, out) => pm.variables.set('cb', err ? String(err) : out))
      xml2js.parseStringPromise('<r a="x"/>', { explicitArray: false }).then((out) => pm.variables.set('promise', out))
      pm.variables.set('built', new xml2js.Builder({ headless: true, renderOpts: { pretty: false } }).buildObject({ root: { item: ['a', 'b'] } }))
    `)
    expect(v).toEqual({ cb: { r: { i: ['1', '2'] } }, promise: { r: { $: { a: 'x' } } }, built: '<root><item>a</item><item>b</item></root>' })
  })

  it("require('csv-parse/lib/sync')", async () => {
    const v = await values(`
      const parse = require('csv-parse/lib/sync')
      pm.variables.set('rows', parse('id,name\\n1,"Ada, L."\\n2,Bob\\n', { columns: true, skip_empty_lines: true }))
    `)
    expect(v.rows).toEqual([
      { id: '1', name: 'Ada, L.' },
      { id: '2', name: 'Bob' },
    ])
  })

  it('cheerio (require and global)', async () => {
    const v = await values(`
      const $ = require('cheerio').load('<html><head><title>Hi</title></head><body><a class="n" href="/a">A</a><a class="n" href="/b">B</a></body></html>')
      pm.variables.set('title', $('title').text())
      pm.variables.set('links', $('a.n').map((i, el) => $(el).attr('href')).get())
      pm.variables.set('global', cheerio === require('cheerio'))
    `)
    expect(v).toEqual({ title: 'Hi', links: ['/a', '/b'], global: true })
  })
})

describe('require(): blocked modules, globals, isolation and limits', () => {
  it('Node built-ins and unknown modules throw an error that lists the available modules', async () => {
    for (const name of ['fs', 'http', 'https', 'child_process', 'net', 'crypto', 'path', 'os', 'node:fs', 'postman-collection', 'crypto-js/sha256', 'LODASH']) {
      const r = await run({ code: `require(${JSON.stringify(name)})` })
      expect(r.errors).toHaveLength(1)
      const msg = r.errors[0].message
      expect(msg).toContain(`require('${name}') is not supported in Slinger scripts. Available modules: ${MODULES.join(', ')}.`)
    }
    const typed = await run({ code: `require({ toString() { return 'lodash' } })` })
    expect(typed.errors[0].message).toMatch(/TypeError: require\(\) expects a module name/)
  })

  it('library globals can be replaced by script declarations', async () => {
    const v = await values(`
      var _ = 5
      const CryptoJS = require('crypto-js')
      pm.variables.set('underscore', _)
      pm.variables.set('crypto', typeof CryptoJS.HmacSHA256)
      tv4 = 'mine'
      pm.variables.set('tv4', tv4)
    `)
    expect(v).toEqual({ underscore: 5, crypto: 'function', tv4: 'mine' })
  })

  it('libraries run inside the sandbox only: no host objects appear, and changes do not reach the next script or the host', async () => {
    const all = MODULES.map((m) => `require(${JSON.stringify(m)})`).join('; ')
    const r = await run({
      scripts: [
        script(`${all}
          _.merge({}, JSON.parse('{"__proto__": {"polluted": "yes"}}'))
          _.hacked = true
          Object.prototype.viaLib = 1
          const names = ['process', 'Buffer', 'module', 'exports', 'global', '__slinger_call', '__slinger_lib', 'fetch', 'XMLHttpRequest']
          pm.variables.set('leaked', names.filter((n) => typeof globalThis[n] !== 'undefined'))
          pm.variables.set('fnThis', Function('return this')() === globalThis)
        `, 'collection', 'C'),
        script(`pm.variables.set('next', [typeof _.hacked, typeof ({}).viaLib])`, 'request', 'R'),
      ],
    })
    expect(r.errors).toEqual([])
    expect(r.variables).toMatchObject({ leaked: [], fnThis: true, next: ['undefined', 'undefined'] })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).viaLib).toBeUndefined()
  })

  it('the deadline still applies while a library loads and after libraries are loaded', async () => {
    const during = await run({ code: `require('cheerio'); require('lodash'); require('ajv')`, limits: { ...DEFAULT_LIMITS, timeoutMs: 5 } })
    expect(during.errors).toEqual([expect.objectContaining({ kind: 'timeout' })])
    const after = await run({ code: `require('lodash'); require('moment'); CryptoJS.SHA256('x'); while (true) {}`, limits: { ...DEFAULT_LIMITS, timeoutMs: 400 } })
    expect(after.errors).toEqual([expect.objectContaining({ kind: 'timeout', message: 'Script timed out after 400 ms' })])
    // The engine is healthy afterwards.
    expect((await values(`pm.variables.set('ok', _.sum([1, 2]))`)).ok).toBe(3)
  })

  it('the memory limit still applies with every library loaded, and all of them fit in the default limit', async () => {
    const all = MODULES.map((m) => `require(${JSON.stringify(m)})`).join('; ')
    const fits = await runScriptChain(job({ scripts: [script(`${all}; pm.variables.set('ok', true)`)], limits: DEFAULT_LIMITS }), { readSecret: () => null, isCancelled: () => false })
    expect(fits.errors).toEqual([])
    const r = await run({ code: `${all}; const parts = []; for (;;) parts.push(new Uint8Array(1 << 20))`, limits: { ...DEFAULT_LIMITS, memoryBytes: 32 * 1024 * 1024, timeoutMs: 10_000 } })
    expect(r.errors).toEqual([expect.objectContaining({ kind: 'memory', message: 'Script ran out of memory (limit 32 MB)' })])
  })
})
