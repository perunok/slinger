/**
 * Shared by the versioned export tests: a feature-rich Postman collection (folders, nested folders, scripts at
 * every level, saved examples, descriptions, auth, query params, path variables) and a helper that exports a
 * collection exactly like the renderer's Export dialog does (src/features/importexport/ExportCollectionDialog).
 */
import { buildPostmanCollection, type PostmanCollectionV21 } from '../../src/lib/postman'
import { buildSlingerBlock, latestVersion } from '../../src/lib/slingerExport'
import type { TestEnv } from './helpers'

const script = (listen: 'prerequest' | 'test', ...exec: string[]) => ({ listen, script: { type: 'text/javascript', exec } })

export const RICH_COLLECTION = {
  info: {
    _postman_id: '6a3c0b0e-1111-4222-8333-944445555666',
    name: 'Rich API',
    description: '# Rich API\n\nEverything **Postman** can hold.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [script('prerequest', "pm.environment.set('ts', Date.now())"), script('test', "pm.test('ok', () => {})")],
  item: [
    {
      name: 'Users',
      description: 'User endpoints',
      event: [script('prerequest', "console.log('folder')")],
      item: [
        {
          name: 'Get user',
          event: [script('test', "pm.test('200', () => pm.response.to.have.status(200))")],
          request: {
            method: 'GET',
            header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Off', value: '1', disabled: true }],
            url: {
              raw: '{{baseUrl}}/users/:id?expand=roles&debug=1',
              host: ['{{baseUrl}}'],
              path: ['users', ':id'],
              query: [
                { key: 'expand', value: 'roles' },
                { key: 'debug', value: '1' },
              ],
              variable: [{ key: 'id', value: '42', description: 'User id' }],
            },
            auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
            description: 'Fetch one user',
          },
          response: [
            {
              name: 'OK',
              originalRequest: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/users/42', host: ['{{baseUrl}}'], path: ['users', '42'] } },
              status: 'OK',
              code: 200,
              _postman_previewlanguage: 'json',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              cookie: [],
              body: '{"id":42,"name":"Abebe"}',
            },
          ],
        },
        {
          name: 'Admin',
          item: [
            {
              name: 'Create user',
              request: {
                method: 'POST',
                header: [{ key: 'Content-Type', value: 'application/json' }],
                body: { mode: 'raw', raw: '{"name":"{{name}}"}', options: { raw: { language: 'json' } } },
                url: { raw: 'https://api.example.com:8443/admin/users', protocol: 'https', host: ['api', 'example', 'com'], port: '8443', path: ['admin', 'users'] },
                auth: { type: 'basic', basic: [{ key: 'username', value: 'admin', type: 'string' }, { key: 'password', value: '{{adminPass}}', type: 'string' }] },
              },
            },
          ],
        },
      ],
    },
    {
      name: 'Upload',
      request: {
        method: 'POST',
        header: [],
        body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: '/tmp/a.png' }, { key: 'note', value: 'hi', type: 'text' }] },
        url: { raw: 'https://api.example.com/upload', protocol: 'https', host: ['api', 'example', 'com'], path: ['upload'] },
      },
    },
    {
      name: 'Form login',
      request: {
        method: 'POST',
        header: [],
        body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'u' }, { key: 'pass', value: '{{pass}}' }] },
        url: 'https://api.example.com/login',
      },
    },
  ],
}

export interface ExportOptions {
  includeSnapshots?: boolean
  appVersion?: string
  now?: Date
}

/** Exports `collectionId` the way the Export dialog does (live content + version history block). */
export async function exportCollection(env: TestEnv, collectionId: string, opts: ExportOptions = {}): Promise<PostmanCollectionV21> {
  const includeSnapshots = opts.includeSnapshots ?? true
  const all = await Promise.all((await env.api.listWorkspaces()).map((w) => env.api.listCollections(w.id)))
  const collection = all.flat().find((c) => c.id === collectionId)!
  const summaries = await env.api.listCollectionVersions(collectionId)
  const versions = includeSnapshots ? await Promise.all(summaries.map((v) => env.api.getCollectionVersion(v.id))) : summaries
  return buildPostmanCollection({
    collection,
    folders: await env.api.listFolders(collectionId),
    requests: await env.api.listRequests(collectionId),
    version: latestVersion(summaries),
    slinger: buildSlingerBlock({ collectionId, versions, includeSnapshots, appVersion: opts.appVersion ?? '0.0.0-test', now: opts.now }),
  })
}
