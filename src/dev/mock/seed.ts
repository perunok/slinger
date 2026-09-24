import type { ApiFolder } from '../../../shared/types'
import {
  addCollection,
  addEnvironment,
  addFolder,
  addRequest,
  addVariable,
  type MockState,
} from './store'
import { addVersion } from './versions'
import { importPostman } from './postmanImport'
import {
  apiKeyAuth,
  basicAuth,
  bearerAuth,
  fileBody,
  formdataBody,
  makeDoc,
  rawBody,
  urlencodedBody,
  type DocOptions,
} from './docs'
import { nowSec, uuid } from './util'

const M = 'https://mock.slinger.local'

interface Ctx {
  s: MockState
  workspaceId: string
  collectionId: string
}

function req(c: Ctx, folder: ApiFolder | null, name: string, method: string, url: string, opts?: DocOptions): void {
  addRequest(c.s, {
    workspaceId: c.workspaceId,
    collectionId: c.collectionId,
    folderId: folder?.id ?? null,
    name,
    method,
    url,
    documentJson: makeDoc(name, method, url, opts),
  })
}

function folder(c: Ctx, name: string, parent: ApiFolder | null = null): ApiFolder {
  return addFolder(c.s, { workspaceId: c.workspaceId, collectionId: c.collectionId, parentFolderId: parent?.id ?? null, name })
}

function seedDemoApi(s: MockState, workspaceId: string): string {
  const collection = addCollection(s, workspaceId, 'Demo API')
  const c: Ctx = { s, workspaceId, collectionId: collection.id }
  const json = [{ key: 'Accept', value: 'application/json' }]

  const users = folder(c, 'Users')
  const admin = folder(c, 'Admin', users)
  const auth = folder(c, 'Auth')
  const files = folder(c, 'Files')

  req(c, users, 'Get user', 'GET', '{{baseUrl}}/json?userId={{userId}}&verbose=true', {
    description: 'Fetches a user by id. `userId` comes from the active environment.',
    headers: [...json, { key: 'X-Debug', value: '1', disabled: true }],
  })
  req(c, users, 'Create user', 'POST', '{{baseUrl}}/echo', {
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    body: rawBody('{\n  "name": "Ada Lovelace",\n  "email": "ada@example.test",\n  "roles": ["admin"]\n}'),
  })
  req(c, admin, 'List admin users (bearer)', 'GET', '{{baseUrl}}/echo?role=admin', { auth: bearerAuth('{{apiToken}}') })
  req(c, admin, 'Delete user', 'DELETE', `${M}/echo?id=7`, { auth: bearerAuth('{{apiToken}}') })
  req(c, auth, 'Login (urlencoded)', 'POST', '{{baseUrl}}/echo', {
    body: urlencodedBody([['username', 'demo'], ['password', 'hunter2'], ['grant_type', 'password']]),
  })
  req(c, auth, 'Basic auth check', 'GET', '{{baseUrl}}/echo', { auth: basicAuth('demo', 'hunter2') })
  req(c, auth, 'API key in header', 'GET', '{{baseUrl}}/echo', { auth: apiKeyAuth('X-API-Key', '{{apiToken}}', 'header') })
  req(c, auth, 'API key in query', 'GET', '{{baseUrl}}/echo?limit=10', { auth: apiKeyAuth('api_key', '{{apiToken}}', 'query') })
  req(c, files, 'Upload avatar (form-data)', 'POST', '{{baseUrl}}/echo', {
    body: formdataBody([{ key: 'title', value: 'My avatar' }, { key: 'file', src: '/home/user/Pictures/avatar.png' }]),
  })
  req(c, files, 'Upload binary (PUT)', 'PUT', '{{baseUrl}}/echo', { body: fileBody('/home/user/Documents/sample-upload.png') })
  req(c, files, 'Download PNG', 'GET', `${M}/png`)
  req(c, files, 'Download PDF', 'GET', `${M}/pdf`)
  req(c, null, 'JSON sample', 'GET', `${M}/json`)
  req(c, null, 'XML sample', 'GET', `${M}/xml`)
  req(c, null, 'HTML sample', 'GET', `${M}/html`)
  req(c, null, 'Text sample', 'GET', `${M}/text`)
  req(c, null, 'CSV sample', 'GET', `${M}/csv`)
  req(c, null, 'Random binary', 'GET', `${M}/binary`)
  req(c, null, 'Not found (404)', 'GET', `${M}/404`)
  req(c, null, 'Server error (500)', 'GET', `${M}/500`)
  req(c, null, 'Slow response (3s)', 'GET', `${M}/slow`, { description: 'Takes 3 seconds; use it to try cancelling.' })
  req(c, null, 'Cookies', 'GET', `${M}/cookies`)
  req(c, null, 'Big JSON (~3MB)', 'GET', `${M}/big`)
  req(c, null, 'httpbin anything (real fetch)', 'POST', 'https://httpbin.org/anything', {
    body: rawBody('{"hello":"world"}'),
    headers: [{ key: 'Content-Type', value: 'application/json' }],
  })
  req(c, null, 'JSONPlaceholder todo (real fetch)', 'GET', 'https://jsonplaceholder.typicode.com/todos/1')
  return collection.id
}

const PETSTORE = {
  info: { name: 'Petstore (imported)' },
  item: [
    {
      name: 'pets',
      item: [
        { name: 'List pets', request: { method: 'GET', header: [], url: { raw: 'https://mock.slinger.local/json?limit=10' } } },
        {
          name: 'Add pet',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"name":"Rex","tag":"dog"}', options: { raw: { language: 'json' } } },
            url: { host: ['mock', 'slinger', 'local'], path: ['echo'] },
          },
        },
      ],
    },
    { name: 'Health', request: { method: 'GET', url: 'https://mock.slinger.local/text' } },
  ],
}

function seedEnvironments(s: MockState, workspaceId: string): void {
  const local = addEnvironment(s, workspaceId, 'Local')
  addVariable(s, local.id, 'baseUrl', M)
  addVariable(s, local.id, 'apiToken', 'sk_live_demo_123', true)
  addVariable(s, local.id, 'userId', '42')
  addVariable(s, local.id, 'emptyVar', '')
  const staging = addEnvironment(s, workspaceId, 'Staging')
  addVariable(s, staging.id, 'baseUrl', 'https://httpbin.org')
  addVariable(s, staging.id, 'apiToken', 'sk_stage_demo_456', true)
}

function seedHistory(s: MockState, workspaceId: string): void {
  const now = nowSec()
  const entries: Array<[string, string, number | null, string | null, number, number]> = [
    ['GET', `${M}/json`, 200, null, 34, 600],
    ['POST', `${M}/echo`, 200, null, 41, 1800],
    ['GET', `${M}/404`, 404, null, 22, 3600],
    ['GET', 'https://example.invalid/', null, 'Failed to fetch (network error or blocked by CORS in the browser mock)', 12, 7200],
  ]
  for (const [method, url, statusCode, errorMessage, durationMs, ago] of entries) {
    s.history.push({
      id: uuid(),
      workspaceId,
      requestId: null,
      requestName: null,
      method,
      url,
      statusCode,
      ok: statusCode !== null && statusCode < 400,
      errorMessage,
      durationMs,
      createdAt: now - ago,
    })
  }
}

export function seedState(s: MockState): void {
  const now = nowSec()
  const personal = { id: uuid(), name: 'Personal', workspaceType: 'personal' as const, createdAt: now - 1, updatedAt: now - 1, version: 1 }
  const team = { id: uuid(), name: 'Team Sandbox', workspaceType: 'team' as const, createdAt: now, updatedAt: now, version: 1 }
  s.workspaces.push(personal, team)

  const demoId = seedDemoApi(s, personal.id)
  importPostman(s, personal.id, JSON.stringify(PETSTORE))
  seedEnvironments(s, personal.id)
  seedHistory(s, personal.id)
  addVersion(s, demoId, '1.0.0', 'Initial release of the demo API collection.')

  const shared = addCollection(s, team.id, 'Team Endpoints')
  addRequest(s, {
    workspaceId: team.id,
    collectionId: shared.id,
    folderId: null,
    name: 'Ping',
    method: 'GET',
    url: `${M}/text`,
    documentJson: makeDoc('Ping', 'GET', `${M}/text`),
  })
}
