import { describe, expect, it } from 'vitest'
import { dataRows, newRow } from './kv'
import { makeScope } from './template'
import { prepareRequest, secretsNeeded } from './prepare'
import { draftFingerprint, newDraft, parseDocument, serializeDraft } from './request'

const base = { name: 'R', method: 'POST', url: 'http://x/y?a=1' }

describe('document round trip', () => {
  it('reads a Postman-style document and writes it back equivalently', () => {
    const documentJson = JSON.stringify({
      name: 'R',
      method: 'POST',
      url: 'http://x/y?a=1',
      description: 'hi',
      headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }],
      body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
      auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{t}}', type: 'string' }] },
      scripts: [{ listen: 'test' }],
      source: { anything: true },
    })
    const draft = parseDocument({ ...base, documentJson })
    expect(draft.headers.filter((h) => h.key).map((h) => [h.key, h.enabled])).toEqual([['Content-Type', true], ['X-Off', false]])
    expect(draft.body).toMatchObject({ kind: 'raw', rawLanguage: 'json', raw: '{"a":1}' })
    expect(draft.auth).toMatchObject({ kind: 'bearer', bearer: { token: '{{t}}' } })
    const out = JSON.parse(serializeDraft(draft).documentJson)
    expect(out.scripts).toEqual([{ listen: 'test' }])
    expect(out.source).toEqual({ anything: true })
    expect(out.headers[1]).toMatchObject({ key: 'X-Off', disabled: true })
    expect(out.body.raw).toBe('{"a":1}')
    expect(out.auth.bearer[0].value).toBe('{{t}}')
    // stable: parse(serialize(x)) fingerprints identically
    const again = parseDocument({ ...base, documentJson: serializeDraft(draft).documentJson })
    expect(draftFingerprint(again)).toBe(draftFingerprint(draft))
  })

  it('round-trips every body mode', () => {
    const d = newDraft({ ...base })
    d.body = {
      ...d.body,
      kind: 'formData',
      formData: [newRow({ key: 'f', value: 'v' }), newRow({ key: 'file', kind: 'file', filePath: '/tmp/a.png', enabled: false, description: 'img' }), newRow()],
    }
    const back = parseDocument({ ...base, documentJson: serializeDraft(d).documentJson })
    expect(dataRows(back.body.formData).map((r) => [r.key, r.kind, r.filePath, r.enabled, r.description])).toEqual([
      ['f', 'text', '', true, ''],
      ['file', 'file', '/tmp/a.png', false, 'img'],
    ])
    d.body = { ...d.body, kind: 'binary', binaryPath: '/tmp/x.bin' }
    expect(parseDocument({ ...base, documentJson: serializeDraft(d).documentJson }).body).toMatchObject({ kind: 'binary', binaryPath: '/tmp/x.bin' })
    d.body = { ...d.body, kind: 'urlEncoded', urlEncoded: [newRow({ key: 'a', value: '1' })] }
    expect(dataRows(parseDocument({ ...base, documentJson: serializeDraft(d).documentJson }).body.urlEncoded)).toHaveLength(1)
  })

  it('preserves unsupported auth and body instead of dropping them', () => {
    const documentJson = JSON.stringify({ auth: { type: 'oauth2', oauth2: [{ key: 'accessToken', value: 'abc' }] }, body: { mode: 'graphql', graphql: { query: '{a}' } } })
    const d = parseDocument({ ...base, documentJson })
    expect(d.auth.kind).toBe('unsupported')
    expect(d.body.kind).toBe('unsupported')
    const out = JSON.parse(serializeDraft(d).documentJson)
    expect(out.auth.type).toBe('oauth2')
    expect(out.body.mode).toBe('graphql')
  })

  it('survives corrupt JSON and seeds disabled params from Postman source', () => {
    expect(parseDocument({ ...base, documentJson: '{oops' }).url).toBe('http://x/y?a=1')
    const d = parseDocument({
      ...base,
      documentJson: JSON.stringify({ url: 'http://x/y?a=1', source: { request: { url: { query: [{ key: 'a', value: '1' }, { key: 'off', value: '2', disabled: true }] } } } }),
    })
    expect(dataRows(d.params).map((p) => [p.key, p.enabled])).toEqual([['a', true], ['off', false]])
  })

  it('does not flag trailing blank rows as changes', () => {
    const d = parseDocument({ ...base, documentJson: '{}' })
    const f = draftFingerprint(d)
    d.headers = [...d.headers, newRow()]
    expect(draftFingerprint(d)).toBe(f)
    d.headers = [newRow({ key: 'A', value: '1' }), ...d.headers]
    expect(draftFingerprint(d)).not.toBe(f)
  })
})

describe('document edge cases', () => {
  it('keeps unknown Postman settings and only owns timeoutMs', () => {
    const d = parseDocument({ ...base, documentJson: JSON.stringify({ settings: { followRedirects: false } }) })
    d.timeoutMs = 500
    expect(JSON.parse(serializeDraft(d).documentJson).settings).toEqual({ followRedirects: false, timeoutMs: 500 })
    d.timeoutMs = null
    expect(JSON.parse(serializeDraft(d).documentJson).settings).toEqual({ followRedirects: false })
  })

  it('does not resurrect deleted disabled params from the Postman source', () => {
    const documentJson = JSON.stringify({
      url: 'http://x/y',
      source: { request: { url: { query: [{ key: 'off', value: '1', disabled: true }] } } },
    })
    const d = parseDocument({ ...base, documentJson })
    expect(dataRows(d.params).map((p) => p.key)).toEqual(['off'])
    d.params = d.params.filter((p) => p.key !== 'off')
    const again = parseDocument({ ...base, documentJson: serializeDraft(d).documentJson })
    expect(dataRows(again.params)).toHaveLength(0)
  })
})

describe('prepareRequest', () => {
  const scope = makeScope('Dev', [
    { key: 'host', value: 'api.test', secret: false },
    { key: 'tok', value: null, secret: true, id: 'v9' },
  ])
  const ctx = { workspaceId: 'w', scope, secrets: new Map([['tok', 'S3']]) }

  it('applies templates consistently to url, headers, body and auth', () => {
    const d = newDraft({ method: 'post', url: '{{host}}/x?k={{host}}' })
    d.headers = [newRow({ key: 'X-{{host}}', value: '{{host}}' }), newRow({ key: 'Off', value: '1', enabled: false })]
    d.body = { ...d.body, kind: 'raw', raw: '{"h":"{{host}}","g":"{{$guid}}"}' }
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token: ' {{tok}} ' } }
    const res = prepareRequest(d, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.input.method).toBe('POST')
    expect(res.input.url).toBe('http://api.test/x?k=api.test')
    expect(res.input.headers).toEqual([{ key: 'X-api.test', value: 'api.test' }])
    expect(res.input.body.raw?.content).toMatch(/^\{"h":"api.test","g":"[0-9a-f-]{36}"\}$/)
    expect(res.input.body.raw?.contentType).toBe('application/json')
    expect(res.input.auth).toEqual({ kind: 'bearer', bearer: { token: 'S3' } })
  })

  it('fails with the list of unresolved variables', () => {
    const d = newDraft({ url: '{{nope}}/{{host}}' })
    d.headers = [newRow({ key: 'A', value: '{{alsoNope}}' })]
    const res = prepareRequest(d, ctx)
    expect(res).toMatchObject({ ok: false, unresolved: ['nope', 'alsoNope'] })
    expect((res as { error: string }).error).toContain('{{nope}}, {{alsoNope}}')
  })

  it('moves query-placed API keys onto the url and reports missing files', () => {
    const d = newDraft({ url: 'http://a/b#h' })
    d.auth = { ...d.auth, kind: 'apiKey', apiKey: { key: 'k', value: 'v w', addTo: 'query' } }
    const res = prepareRequest(d, ctx)
    expect(res.ok && res.input.url).toBe('http://a/b?k=v%20w#h')
    d.body = { ...d.body, kind: 'binary', binaryPath: '' }
    expect(prepareRequest(d, ctx).ok).toBe(false)
  })

  it('resolves variables that reference other variables, and rejects cycles', () => {
    const nested = makeScope('Dev', [
      { key: 'host', value: 'api.test', secret: false },
      { key: 'base', value: 'https://{{host}}/v1', secret: false },
      { key: 'a', value: '{{b}}', secret: false },
      { key: 'b', value: '{{a}}', secret: false },
    ])
    const ok = prepareRequest(newDraft({ url: '{{base}}/x' }), { workspaceId: 'w', scope: nested })
    expect(ok.ok && ok.input.url).toBe('https://api.test/v1/x')
    const cyc = prepareRequest(newDraft({ url: 'http://h/{{a}}' }), { workspaceId: 'w', scope: nested })
    expect(cyc.ok).toBe(false)
    expect(!cyc.ok && cyc.error).toContain('{{')
  })

  it('lists needed secrets and lets snippets keep unresolved tokens', () => {
    const d = newDraft({ url: 'http://a/{{missing}}' })
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token: '{{tok}}' } }
    expect(secretsNeeded(d, scope).map((s) => s.id)).toEqual(['v9'])
    const res = prepareRequest(d, { workspaceId: 'w', scope, allowUnresolved: true })
    expect(res.ok && res.input.url).toBe('http://a/{{missing}}')
  })
})
