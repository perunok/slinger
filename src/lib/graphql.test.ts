import { describe, expect, it } from 'vitest'
import { demoIntrospection } from '../dev/mock/graphql'
import fixtureJson from '../../electron/__tests__/fixtures/postman-graphql.collection.json'
import type { ApiRequest, Collection } from '../../shared/types'
import {
  graphqlErrorCount,
  graphqlPayload,
  INTROSPECTION_QUERY,
  operationNames,
  parseGraphqlBody,
  schemaFromIntrospection,
  schemaTypeList,
  serializeGraphqlBody,
  type GqlSchema,
} from './graphql'
import { graphqlCompletions } from './graphqlComplete'
import { buildPostmanCollection } from './postman'
import { prepareRequest } from './prepare'
import { draftFingerprint, emptyBody, newDraft, parseDocument, serializeDraft, templateTexts, upgradeDraft, type RequestDraft } from './request'
import { generateSnippet, SNIPPET_LANGS } from './snippets'
import { makeScope } from './template'
import { render } from './versionDiff'

/** A real Postman v2.1 export with two GraphQL requests (variables as JSON text, as Postman writes them). */
const FIXTURE = fixtureJson as {
  item: Array<{ name: string; request: { method: string; body: unknown; url: { raw: string } } }>
}

/** The document the Postman importer stores for an item (headers, body and auth verbatim). */
const importedRequest = (i: number): ApiRequest => {
  const item = FIXTURE.item[i]!
  return {
    id: `r${i}`,
    workspaceId: 'w',
    collectionId: 'c',
    folderId: null,
    name: item.name,
    method: item.request.method,
    url: item.request.url.raw,
    documentJson: JSON.stringify({ name: item.name, method: item.request.method, url: item.request.url.raw, headers: [], body: item.request.body, auth: null }),
    sortOrder: i,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  } as unknown as ApiRequest
}

const graphqlDraft = (query: string, variables = '', operationName = ''): RequestDraft => {
  const d = newDraft({ method: 'POST', url: 'https://api.test/graphql' })
  d.body = { ...emptyBody(), kind: 'graphql', graphql: { query, variables, operationName } }
  return d
}

const scope = makeScope('Dev', [
  { key: 'code', value: 'ET', secret: false },
  { key: 'quote', value: 'say "hi"', secret: false },
  { key: 'num', value: '7', secret: false },
  { key: 'tok', value: null, secret: true, id: 'v1' },
])
const ctx = { workspaceId: 'w', scope, secrets: new Map([['tok', 'S3CRET']]) }

describe('GraphQL body model', () => {
  it('parses a Postman GraphQL body (variables text or object) and writes it back in Postman form', () => {
    expect(parseGraphqlBody({ query: '{a}', variables: '{"x":1}' })).toEqual({ query: '{a}', variables: '{"x":1}', operationName: '' })
    expect(parseGraphqlBody({ query: '{a}', variables: { x: 1 } }).variables).toBe('{\n  "x": 1\n}')
    expect(parseGraphqlBody(null)).toEqual({ query: '', variables: '', operationName: '' })
    expect(serializeGraphqlBody({ query: 'q', variables: '', operationName: '' })).toEqual({ query: 'q', variables: '' })
    expect(serializeGraphqlBody({ query: 'q', variables: '{}', operationName: ' Op ' })).toEqual({ query: 'q', variables: '{}', operationName: 'Op' })
  })

  it('round-trips the imported Postman items unchanged through the editor model', () => {
    for (const i of [0, 1]) {
      const r = importedRequest(i)
      const d = parseDocument(r)
      expect(d.body.kind).toBe('graphql')
      expect(d.body.graphql.query).toBe((FIXTURE.item[i]!.request.body as { graphql: { query: string } }).graphql.query)
      const doc = JSON.parse(serializeDraft(d).documentJson)
      expect(doc.body).toEqual(FIXTURE.item[i]!.request.body)
      // Unchanged after a parse/serialize cycle: no dirty state from loading.
      expect(draftFingerprint(parseDocument({ ...r, documentJson: serializeDraft(d).documentJson }))).toBe(draftFingerprint(d))
    }
  })

  it('exports to Postman v2.1 exactly as imported', () => {
    const collection = { id: 'c', workspaceId: 'w', name: 'GraphQL', description: null } as unknown as Collection
    const out = buildPostmanCollection({ collection, folders: [], requests: [importedRequest(0), importedRequest(1)] })
    expect(out.item.map((i) => i.request?.body)).toEqual(FIXTURE.item.map((i) => i.request.body))
  })

  it('keeps the GraphQL fields while another mode is picked, and upgrades drafts saved before 0.30', () => {
    const d = graphqlDraft('{ a }', '{"x":1}')
    d.body = { ...d.body, kind: 'raw', raw: 'x' }
    expect(d.body.graphql.query).toBe('{ a }')
    const old = newDraft()
    delete (old.body as Partial<RequestDraft['body']>).graphql
    expect(upgradeDraft(old).body.graphql).toEqual({ query: '', variables: '', operationName: '' })
  })

  it('lists the query, variables and operation name as template texts', () => {
    expect(templateTexts(graphqlDraft('{ a(x: "{{q}}") }', '{"v": "{{v}}"}', '{{op}}'))).toEqual(expect.arrayContaining(['{ a(x: "{{q}}") }', '{"v": "{{v}}"}', '{{op}}']))
  })

  it('renders the body in version diffs', () => {
    const d = graphqlDraft('{ books { id } }', '{"a": 1}', 'Books')
    const { documentJson } = serializeDraft(d)
    expect(render({ name: 'x', method: 'POST', url: d.url, documentJson }).body).toBe('graphql (operation Books)\n{ books { id } }\nvariables:\n{"a": 1}')
  })
})

describe('prepareRequest with a GraphQL body', () => {
  it('sends the JSON a GraphQL client posts, with application/json, and keeps the method', () => {
    const res = prepareRequest(graphqlDraft('query Q($c: ID!) { country(code: $c) { name } }', '{"c": "{{code}}"}', 'Q'), ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.input.method).toBe('POST')
    expect(res.input.body.mode).toBe('raw')
    expect(res.input.body.raw?.contentType).toBe('application/json')
    expect(JSON.parse(res.input.body.raw!.content)).toEqual({ query: 'query Q($c: ID!) { country(code: $c) { name } }', variables: { c: 'ET' }, operationName: 'Q' })
    const get = graphqlDraft('{ a }')
    get.method = 'GET'
    const r2 = prepareRequest(get, ctx)
    expect(r2.ok && r2.input.method).toBe('GET')
    expect(r2.ok && JSON.parse(r2.input.body.raw!.content)).toEqual({ query: '{ a }' })
  })

  it('resolves {{variables}} in the query and the variables (JSON-escaped inside strings, raw outside); secrets too', () => {
    const res = prepareRequest(graphqlDraft('{ a(x: "{{code}}") }', '{"q": "{{quote}}", "t": "{{tok}}", "n": {{num}}}'), ctx)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(JSON.parse(res.input.body.raw!.content)).toEqual({ query: '{ a(x: "ET") }', variables: { q: 'say "hi"', t: 'S3CRET', n: 7 } })
  })

  it('fails before sending on invalid or non-object variables, and on unresolved variables', () => {
    const bad = prepareRequest(graphqlDraft('{ a }', '{"x": '), ctx)
    expect(bad).toMatchObject({ ok: false, unresolved: [] })
    expect(!bad.ok && bad.error).toMatch(/^The GraphQL variables are not valid JSON/)
    const arr = prepareRequest(graphqlDraft('{ a }', '[1]'), ctx)
    expect(!arr.ok && arr.error).toBe('The GraphQL variables must be a JSON object, like {"id": 1}.')
    const missing = prepareRequest(graphqlDraft('{ a(x: "{{nope}}") }'), ctx)
    expect(missing).toMatchObject({ ok: false, unresolved: ['nope'] })
  })

  it('keeps a user Content-Type (main adds application/json only when there is none)', () => {
    const d = graphqlDraft('{ a }')
    d.headers = [{ ...d.headers[0]!, key: 'Content-Type', value: 'application/graphql+json', enabled: true }]
    const res = prepareRequest(d, ctx)
    expect(res.ok && res.input.headers).toEqual([{ key: 'Content-Type', value: 'application/graphql+json' }])
    expect(res.ok && generateSnippet('curl', res.input)).not.toContain("'Content-Type: application/json'")
  })

  it('graphqlPayload: lenient mode writes unparsable variables as typed (snippets with unresolved variables)', () => {
    const id = (t: string) => t
    expect(graphqlPayload({ query: '{ a }', variables: '{"id": {{id}}}', operationName: '' }, id, id, true)).toEqual({ ok: true, content: '{"query":"{ a }","variables":{"id": {{id}}}}' })
    expect(graphqlPayload({ query: '{ a }', variables: 'null', operationName: '' }, id, id)).toEqual({ ok: true, content: '{"query":"{ a }"}' })
  })
})

describe('code snippets of a GraphQL request', () => {
  const res = prepareRequest(graphqlDraft('query Q { books { title } }', '{"first": 2}', 'Q'), { ...ctx, allowUnresolved: true })
  if (!res.ok) throw new Error('prepare failed')
  const payload = '{"query":"query Q { books { title } }","variables":{"first":2},"operationName":"Q"}'

  it.each(SNIPPET_LANGS.map((l) => l.id))('%s posts the JSON body with Content-Type application/json', (lang) => {
    const code = generateSnippet(lang, res.input)
    expect(code).toMatch(/application\/json/)
    expect(code).toMatch(/post/i)
    // Each language quotes the body its own way; the query text and the variables are always there.
    expect(code).toContain('query Q { books { title } }')
    expect(code).toMatch(/first\\?"?:\s?2/)
  })

  it('cURL and .http carry the exact JSON', () => {
    expect(generateSnippet('curl', res.input)).toContain(`--data-raw '${payload}'`)
    expect(generateSnippet('http', res.input)).toContain(`Content-Type: application/json\n\n${payload}`)
  })

  it('a snippet with an unresolved variable in the variables still shows them', () => {
    const r = prepareRequest(graphqlDraft('{ a }', '{"id": {{someId}}}'), { ...ctx, allowUnresolved: true })
    expect(r.ok && generateSnippet('curl', r.input)).toContain('"variables":{"id": {{someId}}}')
  })
})

describe('introspection', () => {
  it('the query asks for every part the schema browser and completion use', () => {
    for (const part of ['__schema', 'queryType', 'mutationType', 'fields(includeDeprecated: true)', 'inputFields', 'enumValues', 'possibleTypes', 'directives']) {
      expect(INTROSPECTION_QUERY).toContain(part)
    }
    expect(operationNames(INTROSPECTION_QUERY)).toEqual(['IntrospectionQuery'])
  })

  it('reads an introspection response into types, fields, arguments, enums and unions', () => {
    const res = schemaFromIntrospection(demoIntrospection())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const s = res.schema
    expect([s.queryType, s.mutationType, s.subscriptionType]).toEqual(['Query', 'Mutation', null])
    const books = s.types.Query!.fields.find((f) => f.name === 'books')!
    expect(books).toMatchObject({ type: '[Book!]!', typeName: 'Book', description: 'Books, newest first.' })
    expect(books.args).toEqual([
      { name: 'genre', description: 'Only this genre.', type: 'Genre', typeName: 'Genre', defaultValue: null },
      { name: 'first', description: 'How many to return.', type: 'Int', typeName: 'Int', defaultValue: '10' },
    ])
    expect(s.types.Book!.fields.find((f) => f.name === 'isbn')!.deprecated).toBe('Use `id`.')
    expect(s.types.Genre!.enumValues.map((e) => e.name)).toEqual(['FANTASY', 'SCIENCE_FICTION', 'MYSTERY', 'POETRY'])
    expect(s.types.SearchResult!.possibleTypes).toEqual(['Book', 'Author'])
    expect(s.types.BookInput!.fields.map((f) => f.name)).toEqual(['title', 'authorId', 'genre', 'year'])
    expect(schemaTypeList(s).slice(0, 2).map((t) => t.name)).toEqual(['Query', 'Mutation'])
    expect(s.directives.map((d) => d.name)).toEqual(['include', 'skip'])
  })

  it('reports a GraphQL error answer or a non-introspection body', () => {
    expect(schemaFromIntrospection({ errors: [{ message: 'introspection is disabled' }] })).toEqual({ ok: false, error: 'The server answered with a GraphQL error: introspection is disabled' })
    expect(schemaFromIntrospection({ hello: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('not a GraphQL introspection result') })
  })

  it('counts `errors` of a GraphQL answer (response hint)', () => {
    expect(graphqlErrorCount('{"data":null,"errors":[{"message":"x"},{"message":"y"}]}')).toBe(2)
    expect(graphqlErrorCount('{"data":{}}')).toBe(0)
    expect(graphqlErrorCount('not json')).toBe(0)
  })
})

describe('schema completion', () => {
  const schema = (schemaFromIntrospection(demoIntrospection()) as { ok: true; schema: GqlSchema }).schema
  /** Completion labels at the `|` of `text`. */
  const at = (text: string) => {
    const pos = text.indexOf('|')
    const r = graphqlCompletions(schema, text.replace('|', ''), pos)
    return r ? r.options.map((o) => o.label) : null
  }

  it('offers the root fields, then the fields of each nested type', () => {
    expect(at('{ |')).toEqual(['books', 'book', 'authors', 'search', '__typename'])
    expect(at('query Q { bo|')).toEqual(expect.arrayContaining(['books', 'book']))
    expect(at('{ books { |')).toEqual(['id', 'title', 'genre', 'year', 'author', 'isbn', '__typename'])
    expect(at('{ books(first: 2) { author { |')).toEqual(['id', 'name', 'books', '__typename'])
    expect(at('{ books { id } authors { |')).toEqual(['id', 'name', 'books', '__typename'])
    expect(at('mutation { addBook(input: {title: "x"}) { |')).toContain('title')
    expect(at('mutation { |')).toEqual(['addBook', '__typename'])
    // An alias does not change the field.
    expect(at('{ mine: books { ti|')).toContain('title')
  })

  it('offers arguments, enum values, input fields and Boolean literals', () => {
    expect(at('{ books(|')).toEqual(['genre', 'first'])
    expect(at('{ books(first: 2, |')).toEqual(['genre', 'first'])
    expect(at('{ books(genre: |')).toEqual(['FANTASY', 'SCIENCE_FICTION', 'MYSTERY', 'POETRY'])
    expect(at('mutation { addBook(input: { |')).toEqual(['title', 'authorId', 'genre', 'year'])
    expect(at('mutation { addBook(input: { title: "a", genre: |')).toContain('POETRY')
    expect(at('{ books @include(|')).toEqual(['if'])
    expect(at('{ books @include(if: |')).toEqual(['true', 'false'])
  })

  it('offers types after `on` and in variable definitions, and directives after @', () => {
    expect(at('{ search(text: "a") { ... on |')).toEqual(expect.arrayContaining(['Book', 'Author', 'SearchResult']))
    expect(at('{ search(text: "a") { ... on Book { |')).toContain('title')
    expect(at('{ search(text: "a") { |')).toEqual(['__typename'])
    expect(at('query Q($g: |')).toEqual(expect.arrayContaining(['Genre', 'BookInput', 'ID', 'String']))
    expect(at('query Q($g: |')).not.toContain('Book')
    expect(at('{ books @|')).toEqual(['include', 'skip'])
    expect(at('fragment F on |')).toContain('Book')
    expect(at('fragment F on Book { |')).toContain('title')
  })

  it('offers nothing inside strings, comments, {{templates}} and variable names; keywords at the top level', () => {
    expect(at('{ books(text: "ab|')).toBeNull()
    expect(at('# { |')).toBeNull()
    expect(at('{ books(first: {{n|')).toBeNull()
    expect(at('query Q($|')).toBeNull()
    expect(at('|')).toEqual(['query', 'mutation', 'subscription', 'fragment'])
    expect(at('{ a } |')).toEqual(['query', 'mutation', 'subscription', 'fragment'])
  })

  it('carries descriptions and types for the completion info', () => {
    const r = graphqlCompletions(schema, '{ ', 2)!
    expect(r.options.find((o) => o.label === 'books')).toMatchObject({ detail: '(genre, first): [Book!]!', info: 'Books, newest first.' })
    const isbn = graphqlCompletions(schema, '{ books { ', 10)!.options.find((o) => o.label === 'isbn')
    expect(isbn?.info).toContain('Deprecated: Use `id`.')
  })
})
