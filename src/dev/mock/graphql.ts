/**
 * A tiny GraphQL "library" API for the browser dev mode (`https://mock.slinger.local/graphql`) and tests: it answers the
 * introspection query with a small schema (books, authors, a union, an enum, an input type, a deprecated field) and any
 * other query with fixed data. No GraphQL engine: just enough for the GraphQL body, "Fetch schema" and autocomplete.
 */
type Json = Record<string, unknown>

/** `[name, type, description?, args?, deprecationReason?]`; an arg is `[name, type, description?, defaultValue?]`. */
type ArgDef = [string, string, string?, string?]
type FieldDef = [string, string, string?, ArgDef[]?, string?]

interface TypeDef {
  kind: 'OBJECT' | 'UNION' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR'
  name: string
  description?: string
  fields?: FieldDef[]
  enumValues?: Array<[string, string?]>
  possibleTypes?: string[]
}

const DEMO_TYPES: TypeDef[] = [
  {
    kind: 'OBJECT',
    name: 'Query',
    description: 'Everything you can read.',
    fields: [
      ['books', '[Book!]!', 'Books, newest first.', [['genre', 'Genre', 'Only this genre.'], ['first', 'Int', 'How many to return.', '10']]],
      ['book', 'Book', 'One book by id.', [['id', 'ID!']]],
      ['authors', '[Author!]!', 'All authors.'],
      ['search', '[SearchResult!]!', 'Books and authors matching a text.', [['text', 'String!']]],
    ],
  },
  { kind: 'OBJECT', name: 'Mutation', fields: [['addBook', 'Book!', 'Adds a book to the library.', [['input', 'BookInput!']]]] },
  {
    kind: 'OBJECT',
    name: 'Book',
    description: 'A book in the library.',
    fields: [
      ['id', 'ID!'],
      ['title', 'String!', 'The title as printed on the cover.'],
      ['genre', 'Genre'],
      ['year', 'Int', 'Year of first publication.'],
      ['author', 'Author!'],
      ['isbn', 'String', 'ISBN-10.', [], 'Use `id`.'],
    ],
  },
  { kind: 'OBJECT', name: 'Author', description: 'Someone who wrote a book.', fields: [['id', 'ID!'], ['name', 'String!'], ['books', '[Book!]!']] },
  { kind: 'UNION', name: 'SearchResult', description: 'A book or an author.', possibleTypes: ['Book', 'Author'] },
  { kind: 'ENUM', name: 'Genre', enumValues: [['FANTASY'], ['SCIENCE_FICTION', 'Science fiction.'], ['MYSTERY'], ['POETRY']] },
  { kind: 'INPUT_OBJECT', name: 'BookInput', fields: [['title', 'String!'], ['authorId', 'ID!'], ['genre', 'Genre'], ['year', 'Int']] },
  { kind: 'SCALAR', name: 'ID' },
  { kind: 'SCALAR', name: 'String' },
  { kind: 'SCALAR', name: 'Int' },
  { kind: 'SCALAR', name: 'Boolean' },
]

/** `[Book!]!` -> introspection type reference. */
function typeRef(t: string): Json {
  if (t.endsWith('!')) return { kind: 'NON_NULL', name: null, ofType: typeRef(t.slice(0, -1)) }
  if (t.startsWith('[')) return { kind: 'LIST', name: null, ofType: typeRef(t.slice(1, -1)) }
  const def = DEMO_TYPES.find((d) => d.name === t)
  return { kind: def?.kind ?? 'SCALAR', name: t, ofType: null }
}

const inputValue = ([name, type, description, defaultValue]: ArgDef): Json => ({
  name,
  description: description ?? null,
  type: typeRef(type),
  defaultValue: defaultValue ?? null,
})

function typeJson(d: TypeDef): Json {
  const fields =
    d.kind === 'OBJECT'
      ? (d.fields ?? []).map(([name, type, description, args, deprecated]) => ({
          name,
          description: description ?? null,
          args: (args ?? []).map(inputValue),
          type: typeRef(type),
          isDeprecated: !!deprecated,
          deprecationReason: deprecated ?? null,
        }))
      : null
  return {
    kind: d.kind,
    name: d.name,
    description: d.description ?? null,
    fields,
    inputFields: d.kind === 'INPUT_OBJECT' ? (d.fields ?? []).map(([name, type, description]) => inputValue([name, type, description])) : null,
    interfaces: d.kind === 'OBJECT' ? [] : null,
    enumValues: d.kind === 'ENUM' ? (d.enumValues ?? []).map(([name, description]) => ({ name, description: description ?? null, isDeprecated: false, deprecationReason: null })) : null,
    possibleTypes: d.kind === 'UNION' ? (d.possibleTypes ?? []).map(typeRef) : null,
  }
}

/** The demo schema's introspection response (`{data: {__schema}}`), as a GraphQL server answers the standard query. */
export function demoIntrospection(): Json {
  return {
    data: {
      __schema: {
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        subscriptionType: null,
        types: DEMO_TYPES.map(typeJson),
        directives: [
          { name: 'include', description: 'Include this only when `if` is true.', locations: ['FIELD'], args: [inputValue(['if', 'Boolean!'])] },
          { name: 'skip', description: 'Skip this when `if` is true.', locations: ['FIELD'], args: [inputValue(['if', 'Boolean!'])] },
        ],
      },
    },
  }
}

const BOOKS = [
  { id: '1', title: 'The Left Hand of Darkness', genre: 'SCIENCE_FICTION', year: 1969, author: { id: 'a1', name: 'Ursula K. Le Guin' } },
  { id: '2', title: 'The Hobbit', genre: 'FANTASY', year: 1937, author: { id: 'a2', name: 'J. R. R. Tolkien' } },
]

/**
 * The answer to a GraphQL POST body: the schema for an introspection query, an `errors` answer for a body that is not a
 * GraphQL request, else the demo books (the query is not evaluated).
 */
export function demoGraphqlAnswer(bodyText: string): Json {
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return { errors: [{ message: 'The body is not JSON: send {"query": "..."}.' }] }
  }
  const query = body && typeof body === 'object' ? (body as Json).query : undefined
  if (typeof query !== 'string' || !query.trim()) return { errors: [{ message: 'Missing "query".' }] }
  if (query.includes('__schema')) return demoIntrospection()
  if (/\bunknownField\b/.test(query)) return { data: null, errors: [{ message: 'Cannot query field "unknownField" on type "Query".', locations: [{ line: 1, column: 3 }] }] }
  return { data: { books: BOOKS } }
}
