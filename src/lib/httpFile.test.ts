import { describe, expect, it } from 'vitest'
import type { ApiFolder, ApiRequest } from '../../shared/types'
import { buildHttpClientEnv, exportHttpFile, unresolvedInput } from './httpFile'
import { newRow } from './kv'
import { emptyAuth, emptyBody, newDraft, serializeDraft, type RequestDraft } from './request'
import { HTTP_FILE_BOUNDARY } from './snippets'
import { layeredScope, makeScope } from './template'

let seq = 0
function folder(id: string, parent: string | null, sortOrder: number, name = id): ApiFolder {
  seq++
  return { id, workspaceId: 'w', collectionId: 'c1', parentFolderId: parent, name, sortOrder, createdAt: seq, updatedAt: seq, version: 1 }
}
function request(id: string, folderId: string | null, sortOrder: number, draft: Partial<RequestDraft>): ApiRequest {
  seq++
  const s = serializeDraft(newDraft({ name: id, ...draft }))
  return { id, workspaceId: 'w', collectionId: 'c1', folderId, sortOrder, createdAt: seq, updatedAt: seq, version: 1, ...s }
}
const rows = (...pairs: [string, string, boolean?][]) => pairs.map(([key, value, enabled = true]) => newRow({ key, value, enabled }))

describe('exportHttpFile', () => {
  const folders = [folder('f-users', null, 0, 'Users'), folder('f-admin', 'f-users', 0, 'Admin'), folder('f-empty', null, 1, 'Empty')]
  const requests = [
    request('Health', null, 0, { method: 'GET', url: '{{baseUrl}}/health' }),
    request('List users', 'f-users', 1, {
      method: 'GET',
      url: '{{baseUrl}}/users?page={{page}}&id={{$guid}}',
      headers: rows(['Accept', 'application/json'], ['X-Off', 'no', false]),
      auth: { ...emptyAuth(), kind: 'bearer', bearer: { token: '{{apiToken}}' } },
    }),
    request('Create user', 'f-users', 2, {
      method: 'POST',
      url: '{{baseUrl}}/users',
      body: { ...emptyBody(), kind: 'raw', raw: '{"name": "{{name}}"}', rawLanguage: 'json' },
    }),
    request('Ban', 'f-admin', 0, { method: 'DELETE', url: 'api.example.com/ban/{{userId}}' }),
  ]

  it('writes every request in sidebar order, each a ### block named after its folder path', () => {
    const { text, usesOAuth2 } = exportHttpFile({ collectionName: 'My API', folders, requests })
    expect(usesOAuth2).toBe(false)
    expect(text).toBe(
      [
        '# My API',
        '# Exported by Slinger. Variables stay as {{name}}: define them in http-client.env.json.',
        '',
        '### Users / Admin / Ban',
        'DELETE http://api.example.com/ban/{{userId}}',
        '',
        '### Users / List users',
        'GET {{baseUrl}}/users?page={{page}}&id={{$guid}}',
        'Accept: application/json',
        'Authorization: Bearer {{apiToken}}',
        '',
        '### Users / Create user',
        'POST {{baseUrl}}/users',
        'Content-Type: application/json',
        '',
        '{"name": "{{name}}"}',
        '',
        '### Health',
        'GET {{baseUrl}}/health',
        '',
      ].join('\n'),
    )
    expect(text).not.toContain('X-Off')
  })

  it('an empty collection is just the header; names are single lines', () => {
    expect(exportHttpFile({ collectionName: 'ኢትዮጵያ\nAPI ✓', folders: [], requests: [] }).text).toBe(
      '# ኢትዮጵያ API ✓\n# Exported by Slinger. Variables stay as {{name}}: define them in http-client.env.json.\n',
    )
    const { text } = exportHttpFile({ collectionName: ' ', folders: [], requests: [request('x', null, 0, { name: 'a\nb', url: 'https://x.test' })] })
    expect(text).toContain('# Collection\n')
    expect(text).toContain('\n### a b\nGET https://x.test\n')
  })

  it('flags OAuth 2.0 requests, which reference {{oauth2_access_token}} instead of a token', () => {
    const oauth = request('Me', null, 0, { url: 'https://x.test/me', auth: { ...emptyAuth(), kind: 'oauth2' } })
    const { text, usesOAuth2 } = exportHttpFile({ collectionName: 'C', folders: [], requests: [oauth] })
    expect(usesOAuth2).toBe(true)
    expect(text).toContain('Authorization: Bearer {{oauth2_access_token}}\n')
  })
})

describe('unresolvedInput', () => {
  const draft = (over: Partial<RequestDraft>) => newDraft({ name: 'R', url: 'https://x.test', ...over })

  it('keeps every template verbatim, including auth and API keys in the query', () => {
    const basic = unresolvedInput(draft({ auth: { ...emptyAuth(), kind: 'basic', basic: { username: '{{user}}', password: '{{password}}' } } }))
    expect(basic.auth).toEqual({ kind: 'basic', basic: { username: '{{user}}', password: '{{password}}' } })
    const apiKey = unresolvedInput(draft({ auth: { ...emptyAuth(), kind: 'apiKey', apiKey: { key: 'key', value: '{{apiKey}}', addTo: 'query' } } }))
    expect(apiKey.auth.apiKey).toEqual({ key: 'key', value: '{{apiKey}}', addTo: 'query' })
    expect(unresolvedInput(draft({ url: ' {{base}}/x ' })).url).toBe('{{base}}/x')
    expect(unresolvedInput(draft({}), 'Folder / R').requestName).toBe('Folder / R')
  })

  it('every body mode; leaves out what cannot be sent instead of failing', () => {
    const urlEncoded = unresolvedInput(draft({ body: { ...emptyBody(), kind: 'urlEncoded', urlEncoded: rows(['a', '{{a}}'], ['off', '1', false], ['', 'x']) } }))
    expect(urlEncoded.body).toEqual({ mode: 'urlEncoded', urlEncoded: [{ key: 'a', value: '{{a}}', enabled: true }] })
    const form = unresolvedInput(
      draft({
        body: {
          ...emptyBody(),
          kind: 'formData',
          formData: [newRow({ key: 't', value: '{{v}}' }), newRow({ key: 'f', kind: 'file', filePath: '/tmp/a.png' }), newRow({ key: 'nofile', kind: 'file' })],
        },
      }),
    )
    expect(form.body.formData).toEqual([
      { key: 't', value: '{{v}}', type: 'text', enabled: true },
      { key: 'f', value: '', type: 'file', filePath: '/tmp/a.png', enabled: true },
    ])
    expect(unresolvedInput(draft({ body: { ...emptyBody(), kind: 'binary', binaryPath: '/tmp/b.bin' } })).body).toEqual({ mode: 'binary', binaryFilePath: '/tmp/b.bin' })
    expect(unresolvedInput(draft({ body: { ...emptyBody(), kind: 'binary', binaryPath: '' } })).body).toEqual({ mode: 'none' })
    expect(unresolvedInput(draft({ body: { ...emptyBody(), kind: 'raw', raw: '<a/>', rawLanguage: 'xml' } })).body).toEqual({
      mode: 'raw',
      raw: { content: '<a/>', contentType: 'application/xml' },
    })
    expect(unresolvedInput(draft({ body: { ...emptyBody(), kind: 'unsupported' }, auth: { ...emptyAuth(), kind: 'unsupported' } }))).toMatchObject({
      body: { mode: 'none' },
      auth: { kind: 'none' },
    })
  })

  it('a form-data export uses multipart parts with file includes', () => {
    const r = request('Upload', null, 0, {
      method: 'POST',
      url: '{{base}}/upload',
      body: { ...emptyBody(), kind: 'formData', formData: [newRow({ key: 'doc', kind: 'file', filePath: '/home/me/doc.pdf' }), newRow({ key: 'who', value: '{{me}}' })] },
    })
    const { text } = exportHttpFile({ collectionName: 'C', folders: [], requests: [r] })
    expect(text).toContain(
      `Content-Disposition: form-data; name="doc"; filename="doc.pdf"\n\n< /home/me/doc.pdf\n--${HTTP_FILE_BOUNDARY}\nContent-Disposition: form-data; name="who"\n\n{{me}}\n--${HTTP_FILE_BOUNDARY}--\n`,
    )
  })
})

describe('buildHttpClientEnv', () => {
  it('non-secret values under the environment name; secrets by name only, with an empty value', () => {
    const scope = layeredScope({
      environmentName: 'Staging',
      globals: [{ key: 'tenant', value: 'global', secret: false }],
      collection: [
        { key: 'baseUrl', value: 'https://collection.test', secret: false },
        { key: 'page', value: '1', secret: false },
      ],
      environment: [
        { key: 'baseUrl', value: 'https://staging.test', secret: false },
        // The renderer never holds secret values; even if one slipped in, it must not be written.
        { key: 'apiToken', value: 's3cret-value', secret: true },
      ],
    })
    const out = buildHttpClientEnv(scope)
    expect(JSON.parse(out.env)).toEqual({ Staging: { tenant: 'global', baseUrl: 'https://staging.test', page: '1' } })
    expect(JSON.parse(out.privateEnv)).toEqual({ Staging: { apiToken: '' } })
    expect(out.env + out.privateEnv).not.toContain('s3cret-value')
    expect(out).toMatchObject({ variables: 3, secrets: 1 })
    expect(out.env.endsWith('}\n')).toBe(true)
  })

  it('uses "default" without an active environment and adds oauth2_access_token when needed', () => {
    const out = buildHttpClientEnv(makeScope(null, [{ key: '__proto__', value: 'x', secret: false }]), { oauth2: true })
    expect(JSON.parse(out.env)).toEqual({ default: JSON.parse('{"__proto__": "x"}') })
    expect(JSON.parse(out.privateEnv)).toEqual({ default: { oauth2_access_token: '' } })
    expect(out.secrets).toBe(0)
  })
})
