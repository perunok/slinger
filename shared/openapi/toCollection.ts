/**
 * An OpenAPI document as a Postman v2.1 collection, so the existing importer (services/postmanImport.ts) writes it: one
 * request per operation in folders by tag, URLs on `{{baseUrl}}`, parameters, bodies and auth, and saved examples for every
 * documented response (mock servers serve them at once). Mapping details: docs/ARCHITECTURE.md, "OpenAPI".
 *
 * Every item carries `_slinger_openapi` ({ key, operationId, specHash, itemHash, examplesHash }), which the importer keeps
 * as the request document's `openapi`; generated examples are marked `_slinger_openapi: true` so an update can tell them
 * from the user's.
 */
import { fingerprintDocument, stableHash } from './fingerprint'
import { deref, isObj, type Json, type LoadedSpec, type MediaType, type ResolvedParameter, type SpecOperation } from './load'
import { explicitExample, sampleFromSchema, sampleText } from './sample'

export type FolderMode = 'tags' | 'paths' | 'none'

export interface OpenApiItemMeta {
  key: string
  operationId: string | null
  specHash: string
  itemHash: string
  /** Hash of the generated examples (name, status, headers, body): an update notices example-only changes. */
  examplesHash: string
}

/** The `examplesHash` of a list of saved examples: only generated ones (`_slinger_openapi: true`) count. */
export function examplesHash(responses: unknown): string {
  const list = Array.isArray(responses) ? responses.filter((r): r is Json => isObj(r) && r._slinger_openapi === true) : []
  return stableHash(list.map((r) => ({ name: r.name ?? null, code: r.code ?? null, header: r.header ?? null, body: r.body ?? null })))
}

/** Collection variables the conversion adds (value, description). */
type Vars = Map<string, { value: string; description: string }>

const STATUS_TEXT: Record<string, string> = {
  '200': 'OK', '201': 'Created', '202': 'Accepted', '204': 'No Content', '301': 'Moved Permanently', '302': 'Found', '304': 'Not Modified',
  '400': 'Bad Request', '401': 'Unauthorized', '403': 'Forbidden', '404': 'Not Found', '405': 'Method Not Allowed', '409': 'Conflict',
  '410': 'Gone', '415': 'Unsupported Media Type', '422': 'Unprocessable Entity', '429': 'Too Many Requests', '500': 'Internal Server Error',
  '501': 'Not Implemented', '502': 'Bad Gateway', '503': 'Service Unavailable', '504': 'Gateway Timeout',
}

/** The status code an example is saved with: `2XX` -> 200, `default` -> 500 (the name keeps the original key). */
export function responseCode(key: string): number {
  if (/^[1-5]\d\d$/.test(key)) return Number(key)
  if (/^[1-5]XX$/i.test(key)) return Number(key[0]) * 100
  return 500
}

/** First server URL with its variables replaced by their defaults (and the variables themselves). */
function baseUrlOf(doc: Json, vars: Vars, warnings: string[]): string {
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isObj) : []
  const first = servers[0]
  if (!first || typeof first.url !== 'string' || !first.url.trim()) {
    warnings.push('The document has no server URL: set the collection variable baseUrl before sending.')
    return ''
  }
  let url = first.url.trim().replace(/\/+$/, '')
  const sv = isObj(first.variables) ? first.variables : {}
  for (const [name, def] of Object.entries(sv)) {
    const value = isObj(def) && def.default !== undefined ? String(def.default) : ''
    vars.set(name, { value, description: isObj(def) && typeof def.description === 'string' ? def.description : 'Server variable' })
    url = url.replaceAll(`{${name}}`, value)
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) warnings.push(`The server URL "${first.url}" is relative: set the collection variable baseUrl to the full URL.`)
  return url
}

const JSON_TYPE = /^application\/(?:[\w.+-]*\+)?json(?:;|$)/i

/** The media type a request/response is generated for (JSON first, then forms, text, anything). */
export function preferredMedia(content: MediaType[]): MediaType | null {
  const by = (test: (t: string) => boolean) => content.find((m) => test(m.type.toLowerCase()))
  return (
    by((t) => t.startsWith('application/json')) ??
    by((t) => JSON_TYPE.test(t)) ??
    by((t) => t.startsWith('application/x-www-form-urlencoded')) ??
    by((t) => t.startsWith('multipart/form-data')) ??
    by((t) => t.startsWith('text/')) ??
    content[0] ??
    null
  )
}

function paramValue(p: ResolvedParameter, doc: Json): string {
  if (p.example !== undefined) return sampleText(p.example)
  return sampleText(sampleFromSchema(p.schema, doc, { direction: 'request' }))
}

/** Example value of a media type: its first named example, else `example`, else a generated sample. */
function mediaSample(m: MediaType, doc: Json, direction: 'request' | 'response'): unknown {
  if (m.examples.length) return m.examples[0]!.value
  if (m.schema) return sampleFromSchema(m.schema, doc, { direction })
  return undefined
}

function bodyText(value: unknown, mediaType: string): string {
  if (value === undefined) return ''
  if (typeof value === 'string' && !JSON_TYPE.test(mediaType)) return value
  return JSON.stringify(value, null, 2)
}

function languageOf(type: string): string {
  const t = type.toLowerCase()
  if (JSON_TYPE.test(t)) return 'json'
  if (t.includes('xml')) return 'xml'
  if (t.includes('html')) return 'html'
  if (t.includes('javascript')) return 'javascript'
  return 'text'
}

function requestBody(op: SpecOperation, doc: Json): { body: Json | null; contentType: string | null } {
  const media = op.requestBody ? preferredMedia(op.requestBody.content) : null
  if (!media) return { body: null, contentType: null }
  const t = media.type.toLowerCase()
  if (t.startsWith('application/x-www-form-urlencoded') || t.startsWith('multipart/form-data')) {
    const schema = media.schema ? deref(doc, media.schema) : {}
    const props = isObj(schema.properties) ? schema.properties : {}
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
    const sample = mediaSample(media, doc, 'request')
    const fields = Object.entries(props).map(([key, raw]): Json => {
      const prop = deref(doc, raw)
      const file = prop.format === 'binary' || prop.format === 'base64' || (prop.type === 'array' && isObj(prop.items) && deref(doc, prop.items).format === 'binary')
      const value = isObj(sample) && sample[key] !== undefined ? sampleText(sample[key]) : sampleText(sampleFromSchema(raw, doc, { direction: 'request' }))
      return {
        key,
        ...(file ? { type: 'file', src: [] } : { type: 'text', value }),
        ...(typeof prop.description === 'string' ? { description: prop.description } : {}),
        ...(required.has(key) ? {} : { disabled: true }),
      }
    })
    return t.startsWith('multipart')
      ? { body: { mode: 'formdata', formdata: fields }, contentType: null } // the client sets the boundary
      : { body: { mode: 'urlencoded', urlencoded: fields.map(({ type: _t, src: _s, ...f }) => ({ ...f, value: typeof f.value === 'string' ? f.value : '' })) }, contentType: media.type }
  }
  const value = mediaSample(media, doc, 'request')
  return {
    body: { mode: 'raw', raw: bodyText(value, media.type), options: { raw: { language: languageOf(media.type) } } },
    contentType: media.type,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Auth

function kv(entries: Array<[string, string]>): Json[] {
  return entries.map(([key, value]) => ({ key, value, type: 'string' }))
}

/** Postman auth for a security requirement (its first scheme), adding the variables it uses. */
function authFor(requirement: Record<string, string[]> | undefined, doc: Json, vars: Vars): Json | null {
  if (!requirement) return { type: 'noauth' }
  const [name, scopes] = Object.entries(requirement)[0] ?? []
  if (!name) return { type: 'noauth' }
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? doc.components.securitySchemes : {}
  const scheme = deref(doc, schemes[name])
  const need = (v: string, description: string) => {
    if (!vars.has(v)) vars.set(v, { value: '', description })
    return `{{${v}}}`
  }
  if (scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'bearer') {
    return { type: 'bearer', bearer: kv([['token', need('bearerToken', `Bearer token (${name})`)]]) }
  }
  if (scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'basic') {
    return { type: 'basic', basic: kv([['username', need('username', `User name (${name})`)], ['password', need('password', `Password (${name})`)]]) }
  }
  if (scheme.type === 'apiKey' && typeof scheme.name === 'string') {
    if (scheme.in === 'cookie') return null // sent as a Cookie header param instead (see headers)
    return { type: 'apikey', apikey: kv([['key', scheme.name], ['value', need('apiKey', `API key (${name}, ${scheme.in} ${scheme.name})`)], ['in', scheme.in === 'query' ? 'query' : 'header']]) }
  }
  if (scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
    const flows = isObj(scheme.flows) ? scheme.flows : {}
    const pick = (['authorizationCode', 'clientCredentials', 'password', 'implicit'] as const).find((f) => isObj(flows[f]))
    const flow = pick ? (flows[pick] as Json) : {}
    const grant = pick === 'clientCredentials' ? 'client_credentials' : pick === 'password' ? 'password_credentials' : 'authorization_code_with_pkce'
    const scope = (scopes && scopes.length ? scopes : Object.keys(isObj(flow.scopes) ? flow.scopes : {})).join(' ')
    const entries: Array<[string, string]> = [
      ['grant_type', grant],
      ['authUrl', typeof flow.authorizationUrl === 'string' ? flow.authorizationUrl : ''],
      ['accessTokenUrl', typeof flow.tokenUrl === 'string' ? flow.tokenUrl : ''],
      ['clientId', need('clientId', `OAuth 2.0 client id (${name})`)],
      ['scope', scope],
    ]
    if (grant === 'authorization_code_with_pkce') entries.push(['challengeAlgorithm', 'S256'])
    if (grant === 'password_credentials') entries.push(['username', need('username', 'User name (OAuth 2.0 password flow)')], ['password', need('password', 'Password (OAuth 2.0 password flow)')])
    return { type: 'oauth2', oauth2: kv(entries) }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Items

function exampleName(key: string, description: string, exampleLabel: string | null): string {
  const base = `${key} ${description.split('\n')[0]!.trim() || STATUS_TEXT[key] || (key === 'default' ? 'Default' : '')}`.trim()
  return (exampleLabel ? `${base} (${exampleLabel})` : base).slice(0, 200)
}

function itemFor(op: SpecOperation, spec: LoadedSpec, vars: Vars, specHash: string, collectionAuth: Json | null): { item: Json; auth: Json | null } {
  const doc = spec.doc
  const path = op.path.replace(/\{([^}]+)\}/g, ':$1')
  const pathSegments = path.split('/').filter(Boolean)
  const query = op.parameters.filter((p) => p.in === 'query')
  const enabledQuery: Json[] = []
  for (const p of query) {
    const value = p.example !== undefined ? p.example : sampleFromSchema(p.schema, doc, { direction: 'request' })
    const values = Array.isArray(value) && p.explode !== false ? value.map(sampleText) : [sampleText(value)]
    for (const v of values) enabledQuery.push({ key: p.name, value: v, ...(p.description ? { description: p.description } : {}), ...(p.required ? {} : { disabled: true }) })
  }
  const enc = (t: string) => encodeURIComponent(t).replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}')
  const queryString = enabledQuery.filter((q) => q.disabled !== true).map((q) => `${enc(String(q.key))}=${enc(String(q.value))}`).join('&')
  const raw = `{{baseUrl}}${path}${queryString ? `?${queryString}` : ''}`
  const headers: Json[] = []
  const { body, contentType } = requestBody(op, doc)
  if (contentType) headers.push({ key: 'Content-Type', value: contentType })
  const okResponse = op.responses.find((r) => /^2/.test(r.key)) ?? op.responses[0]
  const accept = okResponse ? preferredMedia(okResponse.content) : null
  if (accept) headers.push({ key: 'Accept', value: accept.type })
  for (const p of op.parameters.filter((x) => x.in === 'header')) {
    if (['accept', 'content-type', 'authorization'].includes(p.name.toLowerCase())) continue
    headers.push({ key: p.name, value: paramValue(p, doc), ...(p.description ? { description: p.description } : {}), ...(p.required ? {} : { disabled: true }) })
  }
  const cookies = op.parameters.filter((x) => x.in === 'cookie')
  if (cookies.length) headers.push({ key: 'Cookie', value: cookies.map((c) => `${c.name}=${paramValue(c, doc)}`).join('; ') })

  const requirement = op.security !== null ? op.security[0] : Array.isArray(doc.security) ? (doc.security.filter(isObj)[0] as Record<string, string[]> | undefined) : undefined
  const auth = op.security !== null && op.security.length === 0 ? { type: 'noauth' } : requirement ? authFor(requirement, doc, vars) : null
  // The name is the summary; the description is the operation's own text.
  const description = [op.description ?? '', op.deprecated ? '**Deprecated** in the API description.' : ''].filter((p) => p.trim() !== '').join('\n\n')

  const request: Json = {
    method: op.method,
    header: headers,
    url: {
      raw,
      host: ['{{baseUrl}}'],
      path: pathSegments,
      ...(enabledQuery.length ? { query: enabledQuery } : {}),
      variable: op.parameters
        .filter((p) => p.in === 'path')
        .map((p) => ({ key: p.name, value: paramValue(p, doc), ...(p.description ? { description: p.description } : {}) })),
    },
    ...(body ? { body } : {}),
    ...(description ? { description } : {}),
  }
  // Same auth as the collection: inherited (left out here); otherwise the request's own.
  const sameAsCollection = auth && collectionAuth && JSON.stringify(auth) === JSON.stringify(collectionAuth)
  if (auth && !sameAsCollection) request.auth = auth

  const responses: Json[] = []
  for (const r of op.responses) {
    const media = preferredMedia(r.content)
    const code = responseCode(r.key)
    const header: Json[] = []
    if (media) header.push({ key: 'Content-Type', value: media.type })
    for (const h of r.headers) {
      if (h.name.toLowerCase() === 'content-type') continue
      const v = h.example !== undefined ? h.example : explicitExample(deref(doc, h.schema)) ?? sampleFromSchema(h.schema, doc, { direction: 'response' })
      header.push({ key: h.name, value: sampleText(v) })
    }
    const binary = media && /octet-stream|image\/|audio\/|video\/|application\/pdf|zip/i.test(media.type)
    const variants = media && media.examples.length > 1 ? media.examples.map((e) => ({ label: e.summary ?? e.name, value: e.value })) : [{ label: null, value: media && !binary ? mediaSample(media, doc, 'response') : undefined }]
    for (const v of variants) {
      responses.push({
        name: exampleName(r.key, r.description, v.label),
        originalRequest: { method: op.method, header: headers, url: request.url, ...(body ? { body } : {}) },
        status: STATUS_TEXT[String(code)] ?? '',
        code,
        _postman_previewlanguage: media ? languageOf(media.type) : 'text',
        header,
        body: media && !binary ? bodyText(v.value, media.type) : '',
        _slinger_openapi: true,
      })
    }
  }

  const name = `${(op.summary ?? op.operationId ?? op.key).slice(0, 480)}${op.deprecated ? ' (deprecated)' : ''}`
  const itemHash = fingerprintDocument(
    // Inherited auth is not part of the request (it stays on the collection), so not of its fingerprint either.
    { method: op.method, url: raw, headers, body: body ?? null, auth: request.auth ?? null, description },
    op.method,
    raw,
  )
  const meta: OpenApiItemMeta = { key: op.key, operationId: op.operationId, specHash, itemHash, examplesHash: examplesHash(responses) }
  return { item: { name, request, response: responses, _slinger_openapi: meta }, auth }
}

/** Folder (by `mode`) each operation goes to, with the folders in order and their descriptions. */
function folderPlan(spec: LoadedSpec, mode: FolderMode): { folderOf: (op: SpecOperation) => string | null; folders: Array<{ name: string; description: string | null }> } {
  if (mode === 'none') return { folderOf: () => null, folders: [] }
  if (mode === 'paths') {
    const folderOf = (op: SpecOperation) => op.path.split('/').filter(Boolean)[0]?.replace(/^\{(.+)\}$/, ':$1') ?? null
    const names = [...new Set(spec.operations.map(folderOf).filter((n): n is string => !!n))]
    return { folderOf, folders: names.map((name) => ({ name, description: null })) }
  }
  const tagDefs = Array.isArray(spec.doc.tags) ? spec.doc.tags.filter(isObj) : []
  const order: string[] = tagDefs.map((t) => String(t.name ?? '')).filter(Boolean)
  for (const op of spec.operations) if (op.tags[0] && !order.includes(op.tags[0])) order.push(op.tags[0])
  const used = new Set(spec.operations.map((op) => op.tags[0]).filter(Boolean))
  return {
    folderOf: (op) => op.tags[0] ?? null,
    folders: order
      .filter((n) => used.has(n))
      .map((name) => {
        const def = tagDefs.find((t) => t.name === name)
        return { name, description: def && typeof def.description === 'string' ? def.description : null }
      }),
  }
}

function infoDescription(spec: LoadedSpec): string {
  const info = isObj(spec.doc.info) ? spec.doc.info : {}
  const lines: string[] = []
  if (typeof info.description === 'string' && info.description.trim()) lines.push(info.description.trim())
  const facts: string[] = []
  if (spec.specVersion) facts.push(`Version ${spec.specVersion}`)
  facts.push(spec.version === '2.0' ? 'Swagger 2.0' : `OpenAPI ${String(spec.doc.openapi ?? spec.version)}`)
  if (isObj(info.contact)) {
    const c = info.contact
    const who = [c.name, c.email ? `<${String(c.email)}>` : null, c.url].filter(Boolean).join(' ')
    if (who) facts.push(`Contact: ${who}`)
  }
  if (isObj(info.license) && typeof info.license.name === 'string') facts.push(`License: ${info.license.name}`)
  if (isObj(spec.doc.externalDocs) && typeof spec.doc.externalDocs.url === 'string') facts.push(`Docs: ${spec.doc.externalDocs.url}`)
  lines.push(facts.map((f) => `- ${f}`).join('\n'))
  return lines.join('\n\n')
}

export interface ConvertedCollection {
  collection: Json
  warnings: string[]
}

/** The Postman v2.1 collection for `spec` (see the module comment). */
export function openApiToPostman(spec: LoadedSpec, opts: { folders: FolderMode; specText: string }): ConvertedCollection {
  const warnings = [...spec.warnings]
  const vars: Vars = new Map()
  const baseUrl = baseUrlOf(spec.doc, vars, warnings)
  const specHash = stableHash(opts.specText)
  // One auth for every operation: set on the collection, requests inherit it.
  const docRequirement = Array.isArray(spec.doc.security) ? (spec.doc.security.filter(isObj)[0] as Record<string, string[]> | undefined) : undefined
  const scratch: Vars = new Map()
  const auths = spec.operations.map((op) =>
    JSON.stringify(op.security !== null && op.security.length === 0 ? { type: 'noauth' } : (op.security?.[0] ?? docRequirement) ? authFor(op.security?.[0] ?? docRequirement, spec.doc, scratch) : null),
  )
  const shared = auths.every((a) => a === auths[0]) && auths[0] !== 'null' ? (JSON.parse(auths[0]!) as Json) : null
  const collectionAuth = shared && shared.type !== 'noauth' ? shared : null
  if (collectionAuth) authFor(docRequirement ?? spec.operations[0]!.security?.[0], spec.doc, vars)

  const plan = folderPlan(spec, opts.folders)
  const root: Json[] = []
  const folderItems = new Map<string, Json[]>(plan.folders.map((f) => [f.name, []]))
  for (const op of spec.operations) {
    const { item } = itemFor(op, spec, vars, specHash, collectionAuth)
    const folder = plan.folderOf(op)
    const target = folder ? folderItems.get(folder) : undefined
    ;(target ?? root).push(item)
  }
  const items: Json[] = [
    ...plan.folders.filter((f) => folderItems.get(f.name)!.length).map((f) => ({ name: f.name, ...(f.description ? { description: f.description } : {}), item: folderItems.get(f.name)! })),
    ...root,
  ]
  const variable = [
    { key: 'baseUrl', value: baseUrl, type: 'string', description: 'Server URL from the API description' },
    ...[...vars].map(([key, v]) => ({ key, value: v.value, type: 'string', description: v.description })),
  ]
  return {
    collection: {
      info: { name: spec.title, description: { content: infoDescription(spec), type: 'text/markdown' }, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: items,
      variable,
      ...(collectionAuth ? { auth: collectionAuth } : {}),
    },
    warnings: [...new Set(warnings)],
  }
}

/** Generated items by operation key (for updates: what the spec says each request should be now). */
export function generatedItems(
  spec: LoadedSpec,
  opts: { folders: FolderMode; specText: string },
): { byKey: Map<string, { item: Json; folder: string | null }>; collection: Json; warnings: string[] } {
  const { collection, warnings } = openApiToPostman(spec, opts)
  const byKey = new Map<string, { item: Json; folder: string | null }>()
  const walk = (items: unknown, folder: string | null) => {
    for (const it of Array.isArray(items) ? items : []) {
      if (!isObj(it)) continue
      if (Array.isArray(it.item)) walk(it.item, String(it.name))
      else if (isObj(it._slinger_openapi)) byKey.set(String(it._slinger_openapi.key), { item: it, folder })
    }
  }
  walk(collection.item, null)
  return { byKey, collection, warnings }
}
