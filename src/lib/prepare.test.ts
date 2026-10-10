/** prepareMcp: an MCP request resolved into its connect and call inputs (prepareRequest is covered in request.test.ts). */
import { describe, expect, it } from 'vitest'
import { newRow } from './kv'
import { newMcpDraft, newMcpRequestDraft, type McpDraft } from './mcpRequest'
import { prepareMcp, resolveJsonTemplates, withMcpOAuth2Token } from './prepare'
import { emptyOAuth2, type RequestDraft } from './request'
import { makeScope } from './template'

const scope = makeScope('Dev', [
  { key: 'host', value: 'mcp.test', secret: false },
  { key: 'tok', value: null, secret: true, id: 'v9' },
  { key: 'n', value: '42', secret: false },
  { key: 'flag', value: 'true', secret: false },
  { key: 'quote', value: 'say "hi"\nbye', secret: false },
  { key: 'city', value: 'Oslo', secret: false },
  { key: 'dir', value: '/srv/app', secret: false },
])
const ctx = { workspaceId: 'w', scope, secrets: new Map([['tok', 'S3']]) }

const mcpDraft = (mcp: Partial<McpDraft> = {}, http: Partial<RequestDraft> = {}): RequestDraft => {
  const d = newMcpRequestDraft('Weather')
  return { ...d, url: '{{host}}/mcp', ...http, mcp: newMcpDraft({ tool: 'get_weather', arguments: '{"city":"{{city}}"}', ...mcp }) }
}

describe('prepareMcp', () => {
  it('resolves an http request: url, headers, call and a history URL without secrets', () => {
    const d = mcpDraft({ timeoutMs: 5000 }, { url: '{{host}}/mcp?k={{tok}}' })
    d.headers = [newRow({ key: 'X-Host', value: '{{host}}' }), newRow({ key: 'Off', value: '1', enabled: false })]
    const res = prepareMcp(d, ctx)
    expect(res).toEqual({
      ok: true,
      connect: { transport: 'http', url: 'http://mcp.test/mcp?k=S3', headers: [{ key: 'X-Host', value: 'mcp.test' }] },
      call: {
        operation: 'tools/call',
        name: 'get_weather',
        arguments: { city: 'Oslo' },
        timeoutMs: 5000,
        historyUrl: 'http://mcp.test/mcp?k={{tok}}',
        historyDetail: 'tools/call get_weather',
      },
      historyUrl: 'http://mcp.test/mcp?k={{tok}}',
      target: 'get_weather',
      warnings: [],
    })
  })

  it('applies auth as headers exactly as main does for HTTP sends', () => {
    const d = mcpDraft({ transport: 'sse' })
    d.headers = [newRow({ key: 'authorization', value: 'replaced' })]
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token: ' {{tok}} ' } }
    const bearer = prepareMcp(d, ctx)
    expect(bearer.ok && bearer.connect).toEqual({ transport: 'sse', url: 'http://mcp.test/mcp', headers: [{ key: 'Authorization', value: 'Bearer S3' }] })

    d.auth = { ...d.auth, kind: 'basic', basic: { username: 'ü', password: '{{tok}}' } }
    const basic = prepareMcp(d, ctx)
    expect(basic.ok && basic.connect.headers).toEqual([{ key: 'Authorization', value: `Basic ${Buffer.from('ü:S3', 'utf8').toString('base64')}` }])

    d.auth = { ...d.auth, kind: 'apiKey', apiKey: { key: 'X-Api-Key', value: '{{tok}}', addTo: 'header' } }
    const header = prepareMcp(d, ctx)
    expect(header.ok && header.connect.headers).toEqual([
      { key: 'authorization', value: 'replaced' },
      { key: 'X-Api-Key', value: 'S3' },
    ])

    d.auth = { ...d.auth, kind: 'apiKey', apiKey: { key: 'key', value: '{{tok}}', addTo: 'query' } }
    const query = prepareMcp(d, ctx)
    expect(query.ok && query.connect.url).toBe('http://mcp.test/mcp?key=S3')
    expect(query.ok && query.historyUrl).toBe('http://mcp.test/mcp')

    d.auth = { ...d.auth, kind: 'unsupported', unsupportedType: 'hawk' }
    expect(prepareMcp(d, ctx)).toMatchObject({ ok: true, warnings: ['Auth type "hawk" is not supported; sent without authorization.'] })
  })

  it('returns the OAuth 2.0 settings for the caller to look the token up, then applies it', () => {
    const d = mcpDraft()
    d.auth = {
      ...d.auth,
      kind: 'oauth2',
      oauth2: { ...emptyOAuth2(), grantType: 'client_credentials', accessTokenUrl: 'https://idp/token', clientId: 'c', headerPrefix: 'Token' },
    }
    const res = prepareMcp(d, ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.oauth2).toMatchObject({ addTo: 'header', headerPrefix: 'Token', config: { workspaceId: 'w', grantType: 'client_credentials', clientId: 'c' } })
    expect(res.connect.headers).toEqual([])
    expect(withMcpOAuth2Token(res.connect, res.oauth2!, 'AT').headers).toEqual([{ key: 'Authorization', value: 'Token AT' }])
    expect(withMcpOAuth2Token(res.connect, { ...res.oauth2!, headerPrefix: '' }, 'AT').headers).toEqual([{ key: 'Authorization', value: 'AT' }])
    expect(withMcpOAuth2Token(res.connect, { ...res.oauth2!, addTo: 'query' }, 'A T').url).toBe('http://mcp.test/mcp?access_token=A%20T')

    d.auth.oauth2.grantType = 'implicit'
    expect(prepareMcp(d, ctx)).toMatchObject({ ok: false, unresolved: [] })
  })

  it('resolves a stdio request: command, args, enabled env, cwd; url, headers and auth are not used', () => {
    const d = mcpDraft(
      {
        transport: 'stdio',
        command: ' node ',
        args: ['server.js', '--token={{tok}}', '--host={{host}}'],
        env: [newRow({ key: ' API_KEY ', value: '{{tok}}' }), newRow({ key: 'OFF', value: '{{missing}}', enabled: false }), newRow()],
        cwd: '{{dir}}',
      },
      { url: '{{unused}}' },
    )
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token: '{{alsoUnused}}' } }
    const res = prepareMcp(d, ctx)
    expect(res).toMatchObject({
      ok: true,
      connect: { transport: 'stdio', command: 'node', args: ['server.js', '--token=S3', '--host=mcp.test'], env: [{ key: 'API_KEY', value: 'S3' }], cwd: '/srv/app' },
      historyUrl: 'node server.js --token={{tok}} --host=mcp.test',
    })
    expect(res.ok && res.connect).not.toHaveProperty('url')
    expect(res.ok && res.call.historyUrl).toBe('node server.js --token={{tok}} --host=mcp.test')
  })

  it('reports unresolved variables the way prepareRequest does, only for the fields in use', () => {
    const d = mcpDraft({ arguments: '{"a":"{{nope}}"}', uri: '{{unusedUri}}' })
    d.headers = [newRow({ key: 'A', value: '{{alsoNope}}' })]
    const res = prepareMcp(d, ctx)
    expect(res).toMatchObject({ ok: false, unresolved: ['alsoNope', 'nope'] })
    expect(!res.ok && res.error).toContain('Unresolved variables: {{alsoNope}}, {{nope}}.')

    const cyc = makeScope('Dev', [
      { key: 'a', value: '{{b}}', secret: false },
      { key: 'b', value: '{{a}}', secret: false },
    ])
    const left = prepareMcp(mcpDraft({ arguments: '{"x":"{{a}}"}' }, { url: 'http://h' }), { workspaceId: 'w', scope: cyc })
    expect(left).toMatchObject({ ok: false })
    expect(!left.ok && left.error).toContain('Could not fully resolve')
  })

  it('parses the tool arguments after resolving: bare tokens become values, string values stay valid JSON', () => {
    const res = prepareMcp(mcpDraft({ arguments: '{"n": {{n}}, "on": {{flag}}, "s": "{{quote}}", "lit": "a\\"b", "k{{n}}": [1, "{{n}}"]}' }), ctx)
    expect(res.ok && res.call.arguments).toEqual({ n: 42, on: true, s: 'say "hi"\nbye', lit: 'a"b', k42: [1, '42'] })
    // Empty arguments: an empty object.
    expect(prepareMcp(mcpDraft({ arguments: '  ' }), ctx)).toMatchObject({ ok: true, call: { arguments: {} } })
  })

  it('rejects invalid or non-object arguments and missing names', () => {
    const bad = prepareMcp(mcpDraft({ arguments: '{"a": }' }), ctx)
    expect(bad).toMatchObject({ ok: false, unresolved: [] })
    expect(!bad.ok && bad.error).toMatch(/^The tool arguments are not valid JSON: /)
    expect(prepareMcp(mcpDraft({ arguments: '[1]' }), ctx)).toEqual({ ok: false, unresolved: [], error: 'The tool arguments must be a JSON object.' })
    expect(prepareMcp(mcpDraft({ tool: ' ' }), ctx)).toEqual({ ok: false, unresolved: [], error: 'Choose a tool to call.' })
    expect(prepareMcp(mcpDraft({}, { url: ' ' }), ctx)).toEqual({ ok: false, unresolved: [], error: 'Enter the URL of the MCP server.' })
    expect(prepareMcp(mcpDraft({ transport: 'stdio', command: '' }), ctx)).toMatchObject({ ok: false, error: 'Enter the command that starts the MCP server.' })
    expect(prepareMcp(newMcpRequestDraft(), ctx)).toMatchObject({ ok: false, error: 'Enter the URL of the MCP server.' })
  })

  it('builds resources/read and prompts/get calls', () => {
    const read = prepareMcp(mcpDraft({ operation: 'resources/read', uri: ' demo://users/{{n}} ', arguments: 'not json' }), ctx)
    expect(read.ok && read.call).toEqual({
      operation: 'resources/read',
      uri: 'demo://users/42',
      historyUrl: 'http://mcp.test/mcp',
      historyDetail: 'resources/read demo://users/42',
    })
    expect(prepareMcp(mcpDraft({ operation: 'resources/read', uri: '' }), ctx)).toMatchObject({ ok: false, error: 'Enter the URI of the resource to read.' })

    const prompt = prepareMcp(
      mcpDraft({
        operation: 'prompts/get',
        prompt: 'greet',
        promptArguments: [newRow({ key: 'name', value: '{{city}}' }), newRow({ key: 'off', value: '{{missing}}', enabled: false }), newRow()],
      }),
      ctx,
    )
    expect(prompt.ok && prompt.call).toEqual({
      operation: 'prompts/get',
      name: 'greet',
      arguments: { name: 'Oslo' },
      historyUrl: 'http://mcp.test/mcp',
      historyDetail: 'prompts/get greet',
    })
    expect(prepareMcp(mcpDraft({ operation: 'prompts/get', prompt: '' }), ctx)).toMatchObject({ ok: false, error: 'Choose a prompt to get.' })
  })

  it('keeps a secret in a resource URI as {{name}} in what History and the result show', () => {
    const res = prepareMcp(mcpDraft({ operation: 'resources/read', uri: 'postgres://u:{{tok}}@{{host}}/db' }), ctx)
    expect(res).toMatchObject({
      ok: true,
      call: { uri: 'postgres://u:S3@mcp.test/db', historyDetail: 'resources/read postgres://u:{{tok}}@mcp.test/db' },
      target: 'postgres://u:{{tok}}@mcp.test/db',
    })
  })

  it('caps the call timeout at the 600 000 ms main accepts', () => {
    expect(prepareMcp(mcpDraft({ timeoutMs: 900_000 }), ctx)).toMatchObject({ ok: true, call: { timeoutMs: 600_000 } })
    expect(prepareMcp(mcpDraft({ timeoutMs: 600_000 }), ctx)).toMatchObject({ ok: true, call: { timeoutMs: 600_000 } })
    const none = prepareMcp(mcpDraft({ timeoutMs: null }), ctx)
    expect(none.ok && none.call).not.toHaveProperty('timeoutMs')
  })

  it('refuses an HTTP draft', () => {
    const d = mcpDraft()
    delete d.mcp
    expect(prepareMcp(d, ctx)).toMatchObject({ ok: false })
  })
})

describe('resolveJsonTemplates', () => {
  const r = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (_, n: string) => ({ a: '"x"', n: '7' })[n] ?? `{{${n}}}`)
  it('escapes values inside string literals only and leaves other text as it was', () => {
    expect(resolveJsonTemplates('{"s":"{{a}}","n":{{n}},"t":"\\u0041"}', r)).toBe('{"s":"\\"x\\"","n":7,"t":"\\u0041"}')
    expect(resolveJsonTemplates('{"open": "{{a}}', r)).toBe('{"open": ""x"')
  })
})
