/**
 * GraphQL requests end to end on the main side: a Postman export with GraphQL bodies is imported by the real importer,
 * resolved by the renderer's prepare.ts, sent by the real HTTP executor to a tiny local GraphQL server (fixed
 * introspection answer, echoes variables), and exported back unchanged.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { demoIntrospection } from '../../src/dev/mock/graphql'
import { INTROSPECTION_OPERATION, INTROSPECTION_QUERY, schemaFromIntrospection } from '../../src/lib/graphql'
import { buildPostmanCollection } from '../../src/lib/postman'
import { prepareRequest } from '../../src/lib/prepare'
import { parseDocument, type RequestDraft } from '../../src/lib/request'
import { makeScope } from '../../src/lib/template'
import { makeEnv, scaffold, type TestEnv } from './helpers'

const FIXTURE = readFileSync(new URL('./fixtures/postman-graphql.collection.json', import.meta.url), 'utf8')

interface Seen {
  method: string
  contentType: string | undefined
  authorization: string | undefined
  body: { query?: string; variables?: Record<string, unknown>; operationName?: string }
}

/** POST /graphql: the introspection answer for `__schema` queries, else `{data: {echo: variables}}`. */
async function startGraphqlServer() {
  const seen: Seen[] = []
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: Seen['body'] = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Seen['body']
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return void res.end(JSON.stringify({ errors: [{ message: 'body is not JSON' }] }))
      }
      seen.push({ method: req.method ?? '', contentType: req.headers['content-type'], authorization: req.headers.authorization, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body.query?.includes('__schema') ? demoIntrospection() : { data: { echo: body.variables ?? null } }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return { base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) }
}

let env: TestEnv
let ws: string
let gql: Awaited<ReturnType<typeof startGraphqlServer>>
beforeEach(async () => {
  env = makeEnv()
  ws = (await scaffold(env)).workspace.id
  gql = await startGraphqlServer()
})
afterEach(async () => {
  await gql.close()
  env.cleanup()
})

const scope = () =>
  makeScope('Dev', [
    { key: 'graphqlUrl', value: gql.base, secret: false },
    { key: 'countryCode', value: 'ET', secret: false },
  ])

async function send(draft: RequestDraft) {
  const prepared = prepareRequest(draft, { workspaceId: ws, scope: scope() })
  if (!prepared.ok) throw new Error(prepared.error)
  return env.api.executeHttpRequest(prepared.input)
}

describe('GraphQL requests', () => {
  it('imports a Postman GraphQL request, sends it as JSON with resolved variables, and exports it unchanged', async () => {
    const imported = await env.api.importPostmanCollection(ws, FIXTURE)
    const requests = await env.api.listRequests(imported.collection.id)
    const country = requests.find((r) => r.name === 'Country by code')!
    const draft = parseDocument(country)
    expect(draft.body.kind).toBe('graphql')

    const res = await send(draft)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.bodyText!)).toEqual({ data: { echo: { code: 'ET' } } })
    expect(gql.seen[0]).toMatchObject({
      method: 'POST',
      contentType: 'application/json',
      body: { query: expect.stringContaining('country(code: $code)'), variables: { code: 'ET' } },
    })
    // No variables: none are sent.
    await send(parseDocument(requests.find((r) => r.name === 'All continents')!))
    expect(gql.seen[1]!.body).toEqual({ query: '{\n  continents {\n    code\n    name\n  }\n}' })

    const exported = buildPostmanCollection({ collection: imported.collection, folders: [], requests })
    const original = JSON.parse(FIXTURE) as { item: Array<{ request: { body: unknown } }> }
    expect(exported.item.map((i) => i.request!.body)).toEqual(original.item.map((i) => i.request.body))
  })

  it('fetches the schema with the introspection query (with the request auth) and reads it', async () => {
    const imported = await env.api.importPostmanCollection(ws, FIXTURE)
    const [request] = await env.api.listRequests(imported.collection.id)
    const draft = parseDocument(request!)
    draft.auth = { ...draft.auth, kind: 'bearer', bearer: { token: 'tok-1' } }
    draft.body = { ...draft.body, graphql: { query: INTROSPECTION_QUERY, variables: '', operationName: INTROSPECTION_OPERATION } }
    const res = await send(draft)
    expect(gql.seen[0]).toMatchObject({ authorization: 'Bearer tok-1', body: { operationName: 'IntrospectionQuery' } })
    const schema = schemaFromIntrospection(JSON.parse(res.bodyText!))
    expect(schema.ok && Object.keys(schema.schema.types)).toEqual(expect.arrayContaining(['Query', 'Book', 'Genre', 'BookInput']))
  })

  it('a user Content-Type header wins over application/json', async () => {
    const imported = await env.api.importPostmanCollection(ws, FIXTURE)
    const [request] = await env.api.listRequests(imported.collection.id)
    const draft = parseDocument(request!)
    draft.headers = [{ ...draft.headers[0]!, key: 'Content-Type', value: 'application/graphql-response+json', enabled: true }]
    await send(draft)
    expect(gql.seen[0]!.contentType).toBe('application/graphql-response+json')
  })
})
