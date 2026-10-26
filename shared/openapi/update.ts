/**
 * Updating a collection from a new version of its OpenAPI document (docs/ARCHITECTURE.md, "OpenAPI", updates). Pure:
 * planning (what differs between the document and the collection's requests) and merging (the request after an update),
 * shared by main (electron/openapi/update.ts, which reads and writes SQLite) and the browser mock backend.
 *
 * The plan compares the new document with the collection, not with the old document, so requests added or removed by
 * hand count. Requests are matched by their `openapi.key`, else (a collection linked later, or on another device) by
 * method + path template (`{{baseUrl}}/pets/:id` matches `GET /pets/{petId}`).
 */
import type { OpenApiFolderMode, OpenApiPlannedChange, OpenApiRequestMeta } from '../types'
import { fingerprintDocument, stableHash } from './fingerprint'
import { isObj, type Json, type LoadedSpec } from './load'
import { examplesHash, generatedItems } from './toCollection'

export interface LiveRequest {
  id: string
  name: string
  method: string
  url: string
  folderId: string | null
  documentJson: string
  version: number
  sortOrder: number
}
export interface LiveFolder {
  id: string
  name: string
  parentFolderId: string | null
  sortOrder: number
}

/** A request as the importer writes it (main: services/postmanImport.ts, mock: dev/mock/postmanImport.ts). */
export interface RequestShape {
  name: string
  method: string
  url: string
  document: Json
}
/**
 * Item -> stored request. `inheritedAuth` (the collection's) is not copied into the request: requests without their own
 * auth inherit it at send time (container auth); the argument is informational.
 */
export type ItemToRequest = (item: Json, inheritedAuth: Json | null) => RequestShape | null

/** What a document generates: the items by operation key, the auth requests inherit, the collection variables. */
export interface Generated {
  byKey: Map<string, { item: Json; folder: string | null }>
  collectionAuth: Json | null
  baseUrl: string
  /** Collection variables other than baseUrl (server variables, auth placeholders). */
  variables: Array<{ key: string; value: string; description: string }>
  warnings: string[]
}

export function generate(spec: LoadedSpec, text: string, folders: OpenApiFolderMode): Generated {
  const { byKey, collection, warnings } = generatedItems(spec, { folders, specText: text })
  const vars = (Array.isArray(collection.variable) ? collection.variable : []).filter(isObj)
  const baseUrl = vars.find((v) => v.key === 'baseUrl')
  return {
    byKey,
    collectionAuth: isObj(collection.auth) ? collection.auth : null,
    baseUrl: typeof baseUrl?.value === 'string' ? baseUrl.value : '',
    variables: vars
      .filter((v) => v.key !== 'baseUrl' && typeof v.key === 'string')
      .map((v) => ({ key: String(v.key), value: String(v.value ?? ''), description: String(v.description ?? '') })),
    warnings,
  }
}

export interface PlanInput {
  next: Generated
  /** What the linked (previous) document generated; null without a link or when it no longer reads. */
  previous: Generated | null
  /** Live requests of the collection. */
  requests: LiveRequest[]
  folders: LiveFolder[]
  /** Collection variables (key, value). */
  variables: Array<{ key: string; value: string }>
  /** The collection's stored auth (Postman `auth` object, null for none); undefined: not known, never changed. */
  collectionAuth?: Json | null
  toRequest: ItemToRequest
}

export interface PlannedOp {
  change: OpenApiPlannedChange
  request: LiveRequest | null
  doc: Json | null
  /** How the request was found: its `openapi.key`, or method + path (it has no key yet). */
  matchedBy: 'key' | 'path' | null
  /** The request's spec-owned parts are as the last import/update generated them. */
  clean: boolean
}

export interface PlanCore {
  ops: PlannedOp[]
  notes: string[]
  warnings: string[]
  /** New value for the baseUrl variable (null: leave it). */
  baseUrl: string | null
  /** Collection variables the document needs that the collection lacks. */
  newVariables: Array<{ key: string; value: string; description: string }>
  /** New collection auth (null: none); undefined: leave it. */
  collectionAuth?: Json | null
}

export type Choice = 'apply' | 'keep' | 'delete' | 'skip'

const parseDoc = (json: string): Json => {
  try {
    const v = JSON.parse(json || '{}') as unknown
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

export function metaOf(doc: Json): OpenApiRequestMeta | null {
  const m = doc.openapi
  return isObj(m) && typeof m.key === 'string' && typeof m.itemHash === 'string' ? (m as unknown as OpenApiRequestMeta) : null
}

const itemMeta = (item: Json): OpenApiRequestMeta => item._slinger_openapi as unknown as OpenApiRequestMeta

/** Fingerprints of the spec-owned parts one by one (method, URL, headers, body, auth, description). */
const PART_LABELS = ['method', 'URL', 'headers', 'body', 'auth', 'description'] as const
function partHashes(doc: Json): string[] {
  const one = (part: Json) => fingerprintDocument({ method: '', url: '', ...part }, '', '')
  return [
    String(doc.method ?? '').toUpperCase(),
    String(doc.url ?? ''),
    one({ headers: doc.headers }),
    one({ body: doc.body }),
    one({ auth: doc.auth }),
    one({ description: doc.description }),
  ]
}
const authKey = (auth: unknown) => fingerprintDocument({ method: '', url: '', auth }, '', '')
const descriptionKey = (description: unknown) => fingerprintDocument({ method: '', url: '', description }, '', '')

function describeDiff(from: Json, to: Json, examples: boolean): string {
  const a = partHashes(from)
  const b = partHashes(to)
  const parts: string[] = PART_LABELS.filter((_, i) => a[i] !== b[i])
  if (examples) parts.push('examples')
  if (!parts.length) return 'Details'
  const text = parts.join(', ')
  return text[0]!.toUpperCase() + text.slice(1)
}

const TEMPLATE_SEGMENT = /^(?::.+|\{\{.+\}\}|\{.+\})$/

/** The path part of a server URL ("https://x.example.com/v1" -> "/v1"; "" for none). */
export function serverPath(url: string): string {
  return url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
}

/**
 * A URL or document path as a template for matching: host and `{{baseUrl}}` dropped, the server's base path dropped,
 * `:p`, `{p}` and `{{p}}` segments as `{}` ("{{baseUrl}}/pets/:id?x=1" -> "/pets/{}").
 */
export function pathTemplate(url: string, basePaths: readonly string[] = []): string {
  let u = url.trim().replace(/[?#].*$/, '')
  if (/^\{\{[^}]+\}\}/.test(u)) u = u.replace(/^\{\{[^}]+\}\}/, '')
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
  else if (!u.startsWith('/')) u = u.includes('/') ? u.slice(u.indexOf('/')) : ''
  for (const base of basePaths) {
    if (base && (u === base || u.startsWith(`${base}/`))) {
      u = u.slice(base.length)
      break
    }
  }
  const segments = u.split('/').filter(Boolean).map((s) => (TEMPLATE_SEGMENT.test(s) ? '{}' : s))
  return `/${segments.join('/')}`
}

/** `template` (from the document) matches `path` (from a request) when `{}` segments stand for any one segment. */
function wildcardMatch(template: string, path: string): boolean {
  const t = template.split('/')
  const p = path.split('/')
  return t.length === p.length && t.every((s, i) => s === p[i] || s === '{}')
}

/** Identity of the collection's live requests (ids + versions) and its baseUrl: a plan is stale when it changes. */
export function planStamp(requests: readonly LiveRequest[], baseUrl: string | null): string {
  return stableHash({ requests: requests.map((r) => [r.id, r.version]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), baseUrl })
}

const keyMethod = (key: string) => key.slice(0, key.indexOf(' '))
const keyPath = (key: string) => key.slice(key.indexOf(' ') + 1)

/** Compares the document with the collection (see the module comment). Default choices as in the dialog. */
export function planChanges(input: PlanInput): PlanCore {
  const { next, previous } = input
  const warnings = [...next.warnings]
  const requests = [...input.requests].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  const docs = new Map(requests.map((r) => [r.id, parseDoc(r.documentJson)]))

  // By key: the first request carrying it (a duplicated request carries the same key; it is left alone).
  const keyed = new Map<string, LiveRequest>()
  const duplicates = new Map<string, number>()
  const unkeyed: LiveRequest[] = []
  for (const r of requests) {
    const m = metaOf(docs.get(r.id)!)
    if (!m) {
      if (r.method !== 'MCP') unkeyed.push(r)
    } else if (keyed.has(m.key)) duplicates.set(m.key, (duplicates.get(m.key) ?? 1) + 1)
    else keyed.set(m.key, r)
  }
  for (const [key, n] of duplicates) {
    warnings.push(`${n} requests carry the operation ${key}: only "${keyed.get(key)!.name}" is compared with the document.`)
  }

  // Unkeyed requests matched by method + path template: exact templates first, then document segments as wildcards.
  const bases = [...new Set([serverPath(next.baseUrl), previous ? serverPath(previous.baseUrl) : '', serverPath(input.variables.find((v) => v.key === 'baseUrl')?.value ?? '')])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const byPath = new Map<string, LiveRequest>()
  const used = new Set<string>()
  const open = [...next.byKey.keys()].filter((k) => !keyed.has(k))
  const paths = new Map(unkeyed.map((r) => [r.id, pathTemplate(r.url, bases)]))
  for (const exact of [true, false]) {
    for (const key of open) {
      if (byPath.has(key)) continue
      const template = pathTemplate(keyPath(key))
      const hit = unkeyed.find((r) => !used.has(r.id) && r.method.toUpperCase() === keyMethod(key) &&
        (exact ? paths.get(r.id) === template : wildcardMatch(template, paths.get(r.id)!)))
      if (hit) {
        byPath.set(key, hit)
        used.add(hit.id)
      }
    }
  }

  const ops: PlannedOp[] = []
  const nextShape = (item: Json) => input.toRequest(item, next.collectionAuth)
  for (const [key, g] of next.byKey) {
    const gm = itemMeta(g.item)
    const shape = nextShape(g.item)
    if (!shape) continue
    const r = keyed.get(key) ?? byPath.get(key) ?? null
    if (!r) {
      ops.push({
        change: { key, kind: 'added', editedHere: false, name: shape.name, requestId: null, folder: g.folder, summary: 'New in the document', defaultChoice: 'apply' },
        request: null, doc: null, matchedBy: null, clean: false,
      })
      continue
    }
    const doc = docs.get(r.id)!
    const fp = fingerprintDocument(doc, r.method, r.url)
    if (keyed.get(key) === r) {
      const m = metaOf(doc)!
      const storedExamples = m.examplesHash ?? examplesHash(doc.responses)
      const examplesChanged = gm.examplesHash !== storedExamples
      const changed = gm.itemHash !== m.itemHash || examplesChanged
      const clean = fp === m.itemHash
      // Edited here: the spec-owned parts differ from what was generated (unless the user already made the new version).
      const editedHere = !clean && fp !== gm.itemHash
      const prevItem = previous?.byKey.get(key)?.item
      const base = prevItem ? input.toRequest(prevItem, previous!.collectionAuth)?.document ?? doc : doc
      ops.push({
        change: {
          key, kind: changed ? 'changed' : 'unchanged', editedHere, name: r.name, requestId: r.id, folder: g.folder,
          summary: changed ? describeDiff(base, shape.document, examplesChanged) : '', defaultChoice: changed && !editedHere ? 'apply' : 'keep',
        },
        request: r, doc, matchedBy: 'key', clean,
      })
    } else {
      // Found by method + path: a request the user made (or one linked on another device). Same parts: just linked.
      const same = fp === gm.itemHash
      ops.push({
        change: {
          key, kind: same ? 'unchanged' : 'changed', editedHere: !same, name: r.name, requestId: r.id, folder: g.folder,
          summary: same ? 'Matched by method and path' : `Matched by method and path; differs in: ${describeDiff(doc, shape.document, examplesHash(doc.responses) !== gm.examplesHash).toLowerCase()}`,
          defaultChoice: 'keep',
        },
        request: r, doc, matchedBy: 'path', clean: false,
      })
    }
  }
  for (const [key, r] of keyed) {
    if (next.byKey.has(key)) continue
    ops.push({
      change: { key, kind: 'removed', editedHere: false, name: r.name, requestId: r.id, folder: null, summary: 'No longer in the document', defaultChoice: 'keep' },
      request: r, doc: docs.get(r.id)!, matchedBy: 'key', clean: false,
    })
  }

  // Collection level: server URL, folders to create, variables.
  const notes: string[] = []
  const current = input.variables.find((v) => v.key === 'baseUrl')
  let baseUrl: string | null = null
  if (next.baseUrl && current?.value !== next.baseUrl) {
    if (!current) {
      baseUrl = next.baseUrl
      notes.push(`Server URL: ${next.baseUrl} (new variable baseUrl)`)
    } else if (previous && current.value === previous.baseUrl) {
      baseUrl = next.baseUrl
      notes.push(`Server URL: ${current.value || '(empty)'} -> ${next.baseUrl}`)
    } else {
      notes.push(`Server URL in the document: ${next.baseUrl}. The variable baseUrl keeps ${current.value || 'its empty value'} (it was changed here).`)
    }
  }
  const topFolders = new Set(input.folders.filter((f) => f.parentFolderId === null).map((f) => f.name))
  const newFolders = [...new Set(ops.filter((o) => o.change.kind === 'added' && o.change.folder && !topFolders.has(o.change.folder)).map((o) => o.change.folder!))]
  for (const f of newFolders) notes.push(`New folder: ${f}`)
  const have = new Set(input.variables.map((v) => v.key))
  const newVariables = next.variables.filter((v) => !have.has(v.key))
  if (newVariables.length) notes.push(`New ${newVariables.length === 1 ? 'variable' : 'variables'}: ${newVariables.map((v) => v.key).join(', ')}`)
  // The collection's auth (what requests without their own inherit) follows the document unless it was changed here.
  // A collection without any (older imports copied it into every request) takes the document's.
  let collectionAuth: Json | null | undefined
  if (input.collectionAuth !== undefined && authKey(input.collectionAuth) !== authKey(next.collectionAuth)) {
    const current = input.collectionAuth
    const label = (a: Json | null) => (a && typeof a.type === 'string' ? a.type : 'none')
    if (current === null || (previous && authKey(current) === authKey(previous.collectionAuth))) {
      collectionAuth = next.collectionAuth
      notes.push(`Collection authorization: ${label(current)} -> ${label(next.collectionAuth)}`)
    } else {
      notes.push(`Collection authorization in the document: ${label(next.collectionAuth)}. The collection keeps ${label(current)} (it was changed here).`)
    }
  }
  return { ops, notes, warnings: [...new Set(warnings)], baseUrl, newVariables, ...(collectionAuth !== undefined ? { collectionAuth } : {}) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Merging

const rowsOf = (list: unknown): Json[] => (Array.isArray(list) ? list.filter(isObj) : [])
const lower = (k: unknown) => String(k ?? '').trim().toLowerCase()
const keySet = (...lists: unknown[]) => new Set(lists.flatMap((l) => rowsOf(l).map((r) => lower(r.key))).filter(Boolean))
const urlQueryOf = (doc: Json | undefined): unknown => {
  const src = doc && isObj(doc.source) && isObj(doc.source.request) && isObj(doc.source.request.url) ? doc.source.request.url : null
  return src?.query
}
/** Enabled `key=value` pairs of a URL's query string, as written. */
function urlPairs(url: string): Array<{ key: string; raw: string }> {
  const q = url.replace(/#.*$/, '').split('?').slice(1).join('?')
  return q ? q.split('&').filter(Boolean).map((raw) => ({ key: raw.split('=')[0]!, raw })) : []
}
const enc = (t: string) => encodeURIComponent(t).replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}')

/**
 * The request after taking the document's version (choice "apply" for a changed request). Only the spec-owned parts
 * change: method, URL and query parameters, headers (the user's own headers and query parameters, ones neither document
 * defines, are kept), body, saved examples (generated ones replaced, the user's kept), auth and description only when
 * they still are what a document generated. The name follows the document unless the user renamed the request. Scripts,
 * settings, folder, sort order and id are untouched.
 */
export function mergeRequest(input: { request: LiveRequest; doc: Json; clean: boolean; next: RequestShape; previous: RequestShape | null }): RequestShape {
  const { request, doc, clean, next, previous } = input
  const prev = previous?.document
  const nd = next.document

  const specHeaders = keySet(nd.headers, prev?.headers, clean ? doc.headers : [])
  const headers = [...rowsOf(nd.headers), ...rowsOf(doc.headers).filter((h) => lower(h.key) && !specHeaders.has(lower(h.key)))]

  // Query parameters the user added: from the editor's `params` list when saved there, else from the URL.
  const specQuery = keySet(urlQueryOf(nd), urlQueryOf(prev), clean ? (Array.isArray(doc.params) ? doc.params : urlPairs(String(doc.url ?? request.url))) : [])
  const userParams = Array.isArray(doc.params) ? rowsOf(doc.params).filter((p) => lower(p.key) && !specQuery.has(lower(p.key))) : null
  const userPairs = userParams
    ? userParams.filter((p) => p.disabled !== true).map((p) => `${enc(String(p.key))}=${enc(String(p.value ?? ''))}`)
    : urlPairs(String(doc.url ?? request.url)).filter((p) => !specQuery.has(lower(p.key))).map((p) => p.raw)
  const url = userPairs.length ? `${next.url}${next.url.includes('?') ? '&' : '?'}${userPairs.join('&')}` : next.url

  const authFromSpec = clean || authKey(doc.auth) === authKey(nd.auth) || (prev !== undefined && authKey(doc.auth) === authKey(prev.auth))
  const d = descriptionKey(doc.description)
  const descriptionFromSpec = clean || d === descriptionKey(null) || d === descriptionKey(nd.description) || (prev !== undefined && d === descriptionKey(prev.description))
  const name = previous && request.name === previous.name ? next.name : request.name
  const responses = [...rowsOf(nd.responses), ...(Array.isArray(doc.responses) ? doc.responses : []).filter((r) => !(isObj(r) && r._slinger_openapi === true))]
  const oldSource = isObj(doc.source) ? doc.source : {}
  const source = { ...(isObj(nd.source) ? nd.source : {}), name, ...(oldSource.event !== undefined ? { event: oldSource.event } : {}) }

  const document: Json = {
    ...doc,
    name,
    method: next.method,
    url,
    headers,
    body: nd.body ?? null,
    auth: authFromSpec ? (nd.auth ?? null) : (doc.auth ?? null),
    description: descriptionFromSpec ? (nd.description ?? null) : (doc.description ?? null),
    responses,
    source,
    openapi: nd.openapi,
  }
  if (userParams) {
    const generated = rowsOf(urlQueryOf(nd)).map((q) => ({
      key: String(q.key ?? ''), value: String(q.value ?? ''), type: 'text',
      ...(q.disabled === true ? { disabled: true } : {}), ...(typeof q.description === 'string' && q.description ? { description: q.description } : {}),
    }))
    document.params = [...generated, ...userParams]
  }
  return { name, method: next.method, url, document }
}

// ---------------------------------------------------------------------------------------------------------------------
// Applying (what to write; main and the mock do the writing)

export interface PlanWrites {
  add: Array<{ key: string; folder: string | null; request: RequestShape }>
  update: Array<{ id: string; key: string; request: RequestShape }>
  /** Requests found by method + path that already match: only their `openapi` field is written (not counted). */
  link: Array<{ id: string; request: RequestShape }>
  remove: string[]
  kept: number
  baseUrl: string | null
  variables: Array<{ key: string; value: string; description: string }>
  /** New collection auth (null: none); undefined: leave it. */
  collectionAuth?: Json | null
}

const ALLOWED: Record<OpenApiPlannedChange['kind'], readonly Choice[]> = {
  added: ['apply', 'skip', 'keep'],
  changed: ['apply', 'keep'],
  removed: ['keep', 'delete'],
  unchanged: ['keep'],
}

/** The writes for `choices` (missing keys: the default). Throws `Error` with a message for an impossible choice. */
export function writesFor(input: PlanInput, core: PlanCore, choices: Readonly<Record<string, Choice>>): PlanWrites {
  const out: PlanWrites = {
    add: [], update: [], link: [], remove: [], kept: 0, baseUrl: core.baseUrl, variables: core.newVariables,
    ...(core.collectionAuth !== undefined ? { collectionAuth: core.collectionAuth } : {}),
  }
  for (const op of core.ops) {
    const c = op.change
    const choice = choices[c.key] ?? c.defaultChoice
    if (!ALLOWED[c.kind].includes(choice)) throw new Error(`"${choice}" is not a choice for ${c.key} (${c.kind})`)
    const g = input.next.byKey.get(c.key)
    if (c.kind === 'added') {
      const shape = g ? input.toRequest(g.item, input.next.collectionAuth) : null
      if (choice === 'apply' && shape) out.add.push({ key: c.key, folder: c.folder, request: shape })
      else out.kept++
    } else if (c.kind === 'removed') {
      if (choice === 'delete') out.remove.push(op.request!.id)
      else out.kept++
    } else if (c.kind === 'changed' && choice === 'apply') {
      const prevItem = op.matchedBy === 'key' ? input.previous?.byKey.get(c.key)?.item : undefined
      out.update.push({
        id: op.request!.id,
        key: c.key,
        request: mergeRequest({
          request: op.request!, doc: op.doc!, clean: op.clean, next: input.toRequest(g!.item, input.next.collectionAuth)!,
          previous: prevItem ? input.toRequest(prevItem, input.previous!.collectionAuth) : null,
        }),
      })
    } else if (c.kind === 'changed') {
      out.kept++
    } else if (op.matchedBy === 'path') {
      // Unchanged but found by method + path: record the operation so later updates match it by key.
      const r = op.request!
      const meta = itemMeta(g!.item)
      out.link.push({ id: r.id, request: { name: r.name, method: r.method, url: r.url, document: { ...op.doc!, openapi: meta } } })
    }
  }
  return out
}

/** "3 added, 2 updated" style summary of a result's counts. */
export function resultSummary(r: { added: number; updated: number; deleted: number; kept: number }): string {
  const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.deleted && `${r.deleted} deleted`, r.kept && `${r.kept} kept`].filter(Boolean)
  return parts.length ? parts.join(', ') : 'Nothing changed'
}
