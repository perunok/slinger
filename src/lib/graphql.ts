/**
 * GraphQL request bodies (Postman v2.1 `body: {mode: 'graphql', graphql: {query, variables}}`) and schemas. Pure functions.
 *
 * A GraphQL body is sent as the JSON a GraphQL client posts, `{"query", "variables"?, "operationName"?}` with
 * `Content-Type: application/json` (prepare.ts turns it into a raw JSON body, so main, code snippets, cURL and history see an
 * ordinary JSON request). Postman keeps `variables` as JSON *text*; so does the draft, so `{{variables}}` and unsaved typing
 * survive. `operationName` is Slinger's addition to the stored object, written only when set (Postman ignores it).
 *
 * The schema comes from the standard introspection query (`INTROSPECTION_QUERY`), sent like any request of the tab (same
 * environment, auth, network settings and cookie jar) and reduced to `GqlSchema` for autocomplete and the schema browser.
 */

export interface GraphqlBody {
  query: string
  /** The variables as JSON text (Postman's format); '' = none. */
  variables: string
  /** Which operation of the document to run; '' = the server picks (the only one). */
  operationName: string
}

export const emptyGraphql = (): GraphqlBody => ({ query: '', variables: '', operationName: '' })

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Postman's `body.graphql` (variables as text, or an object in older/hand-written files) to the draft's fields. */
export function parseGraphqlBody(g: unknown): GraphqlBody {
  if (!isObj(g)) return emptyGraphql()
  const v = g.variables
  const variables = typeof v === 'string' ? v : v != null && typeof v === 'object' ? JSON.stringify(v, null, 2) : ''
  return { query: str(g.query), variables, operationName: str(g.operationName) }
}

/** The stored (Postman) `body.graphql`: variables stay text; operationName only when set. */
export function serializeGraphqlBody(g: GraphqlBody): Json {
  const out: Json = { query: g.query, variables: g.variables }
  if (g.operationName.trim()) out.operationName = g.operationName.trim()
  return out
}

export type GraphqlPayloadResult = { ok: true; content: string } | { ok: false; error: string }

/**
 * The JSON body a GraphQL client posts. `resolveQuery` resolves `{{templates}}` in the query text and `resolveVariables` in
 * the variables JSON text (prepare.ts: JSON-aware, so a value inside a string literal stays valid JSON). Variables must
 * be a JSON object (or empty). With `lenient` (code snippets with unresolved variables) invalid variables are written as
 * typed instead of failing, so the snippet still shows them.
 */
export function graphqlPayload(
  g: GraphqlBody,
  resolveQuery: (t: string) => string,
  resolveVariables: (t: string) => string,
  lenient = false,
): GraphqlPayloadResult {
  const query = resolveQuery(g.query)
  const varsText = resolveVariables(g.variables ?? '').trim()
  const operationName = resolveQuery(g.operationName ?? '').trim()
  let variables: unknown
  if (varsText) {
    try {
      variables = JSON.parse(varsText)
    } catch (e) {
      if (lenient) return { ok: true, content: manualPayload(query, varsText, operationName) }
      return { ok: false, error: `The GraphQL variables are not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (variables === null) variables = undefined
    else if (!isObj(variables)) {
      if (lenient) return { ok: true, content: manualPayload(query, varsText, operationName) }
      return { ok: false, error: 'The GraphQL variables must be a JSON object, like {"id": 1}.' }
    }
  }
  const body: Json = { query }
  if (variables !== undefined) body.variables = variables
  if (operationName) body.operationName = operationName
  return { ok: true, content: JSON.stringify(body) }
}

/** The payload with the variables text inserted verbatim (it is not JSON yet, e.g. a bare `{{id}}`). */
function manualPayload(query: string, varsText: string, operationName: string): string {
  return `{"query":${JSON.stringify(query)},"variables":${varsText}${operationName ? `,"operationName":${JSON.stringify(operationName)}` : ''}}`
}

/** Operation names defined in a query document (`query Name`, `mutation Name`, `subscription Name`), in order. */
export function operationNames(query: string): string[] {
  const out: string[] = []
  const re = /(?:^|[^\w$@.])(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/g
  for (const m of stripCommentsAndStrings(query).matchAll(re)) out.push(m[2])
  return out
}

/** The text with comments and string contents blanked (same length), for simple scans. */
export function stripCommentsAndStrings(text: string): string {
  return text.replace(/"""[\s\S]*?(?:"""|$)|"(?:[^"\\\n]|\\.)*"?|#[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } }'

/** The standard introspection query (as GraphQL clients send it; without fields newer than the 2018 spec). */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
  possibleTypes { ...TypeRef }
}

fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}

fragment TypeRef on __Type {
  ${TYPE_REF}
}
`

export const INTROSPECTION_OPERATION = 'IntrospectionQuery'

export type GqlTypeKind = 'SCALAR' | 'OBJECT' | 'INTERFACE' | 'UNION' | 'ENUM' | 'INPUT_OBJECT'

export interface GqlArg {
  name: string
  description: string
  /** As written in GraphQL, e.g. `[Book!]!`. */
  type: string
  /** The named type inside the wrappers, e.g. `Book`. */
  typeName: string
  defaultValue: string | null
}

export interface GqlField extends GqlArg {
  args: GqlArg[]
  /** The reason when deprecated, else null. */
  deprecated: string | null
}

export interface GqlEnumValue {
  name: string
  description: string
  deprecated: string | null
}

export interface GqlType {
  name: string
  kind: GqlTypeKind
  description: string
  /** Object / interface fields, or an input object's input fields. */
  fields: GqlField[]
  enumValues: GqlEnumValue[]
  /** Union members, or an interface's implementations. */
  possibleTypes: string[]
  interfaces: string[]
}

export interface GqlDirective {
  name: string
  description: string
  args: GqlArg[]
}

export interface GqlSchema {
  queryType: string | null
  mutationType: string | null
  subscriptionType: string | null
  /** By name, in the server's order. */
  types: Record<string, GqlType>
  directives: GqlDirective[]
}

export type SchemaResult = { ok: true; schema: GqlSchema } | { ok: false; error: string }

const KINDS = new Set<GqlTypeKind>(['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT'])

/** `{kind: NON_NULL, ofType: {kind: LIST, ofType: {name: Book}}}` -> `[Book]!` and `Book`. */
function typeRef(t: unknown, depth = 0): { type: string; typeName: string } {
  if (!isObj(t) || depth > 10) return { type: '?', typeName: '' }
  if (t.kind === 'NON_NULL') {
    const inner = typeRef(t.ofType, depth + 1)
    return { type: `${inner.type}!`, typeName: inner.typeName }
  }
  if (t.kind === 'LIST') {
    const inner = typeRef(t.ofType, depth + 1)
    return { type: `[${inner.type}]`, typeName: inner.typeName }
  }
  const name = str(t.name)
  return { type: name || '?', typeName: name }
}

function argList(list: unknown): GqlArg[] {
  if (!Array.isArray(list)) return []
  return list.filter(isObj).map((a) => ({
    name: str(a.name),
    description: str(a.description),
    ...typeRef(a.type),
    defaultValue: typeof a.defaultValue === 'string' ? a.defaultValue : null,
  }))
}

const deprecation = (o: Json): string | null => (o.isDeprecated === true ? str(o.deprecationReason) || 'Deprecated' : null)

/**
 * The schema of an introspection response (`{data: {__schema}}`, or `{__schema}`). An answer without a schema reports the
 * server's first GraphQL error, or that the response is not an introspection result.
 */
export function schemaFromIntrospection(response: unknown): SchemaResult {
  const data = isObj(response) && isObj(response.data) ? response.data : response
  const s = isObj(data) ? data.__schema : null
  if (!isObj(s) || !Array.isArray(s.types)) {
    const errors = isObj(response) && Array.isArray(response.errors) ? response.errors : []
    const first = errors.find(isObj)
    if (first && typeof first.message === 'string') return { ok: false, error: `The server answered with a GraphQL error: ${first.message}` }
    return { ok: false, error: 'The response is not a GraphQL introspection result (no data.__schema).' }
  }
  const types: Record<string, GqlType> = {}
  for (const t of s.types) {
    if (!isObj(t) || typeof t.name !== 'string' || !KINDS.has(t.kind as GqlTypeKind)) continue
    const fieldSource = Array.isArray(t.fields) ? t.fields : Array.isArray(t.inputFields) ? t.inputFields : []
    types[t.name] = {
      name: t.name,
      kind: t.kind as GqlTypeKind,
      description: str(t.description),
      fields: fieldSource.filter(isObj).map((f) => ({
        name: str(f.name),
        description: str(f.description),
        ...typeRef(f.type),
        defaultValue: typeof f.defaultValue === 'string' ? f.defaultValue : null,
        args: argList(f.args),
        deprecated: deprecation(f),
      })),
      enumValues: Array.isArray(t.enumValues)
        ? t.enumValues.filter(isObj).map((e) => ({ name: str(e.name), description: str(e.description), deprecated: deprecation(e) }))
        : [],
      possibleTypes: Array.isArray(t.possibleTypes) ? t.possibleTypes.map((p) => typeRef(p).typeName).filter(Boolean) : [],
      interfaces: Array.isArray(t.interfaces) ? t.interfaces.map((p) => typeRef(p).typeName).filter(Boolean) : [],
    }
  }
  const rootName = (v: unknown) => (isObj(v) && typeof v.name === 'string' ? v.name : null)
  const directives = Array.isArray(s.directives)
    ? s.directives.filter(isObj).map((d) => ({ name: str(d.name), description: str(d.description), args: argList(d.args) }))
    : []
  return {
    ok: true,
    schema: { queryType: rootName(s.queryType), mutationType: rootName(s.mutationType), subscriptionType: rootName(s.subscriptionType), types, directives },
  }
}

/** Types a user defined (introspection types `__*` left out), roots first, then by name. */
export function schemaTypeList(schema: GqlSchema): GqlType[] {
  const roots = [schema.queryType, schema.mutationType, schema.subscriptionType].filter((n): n is string => !!n)
  const own = Object.values(schema.types).filter((t) => !t.name.startsWith('__'))
  const rootTypes = roots.map((n) => schema.types[n]).filter((t): t is GqlType => !!t)
  const rest = own.filter((t) => !roots.includes(t.name)).sort((a, b) => a.name.localeCompare(b.name))
  return [...rootTypes, ...rest]
}

/** Whether a JSON response body is a GraphQL answer carrying `errors` (for the response viewer's hint). */
export function graphqlErrorCount(bodyText: string | null | undefined): number {
  if (!bodyText) return 0
  const t = bodyText.trimStart()
  if (!t.startsWith('{')) return 0
  try {
    const v = JSON.parse(bodyText) as unknown
    return isObj(v) && Array.isArray(v.errors) ? v.errors.length : 0
  } catch {
    return 0
  }
}
