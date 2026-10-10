/**
 * MCP tool implementations (shared/mcp.ts declares them; main forwards calls here). They use the same model and actions as
 * the UI: requests are edited through RequestDraft (parseDocument / serializeDraft), sends go through executeDraft, runs
 * through the runner store, and every write refreshes the stores so the window shows it at once.
 *
 * Results are JSON (as text for the LLM, and as structured content). Secret variable values are never read: only
 * `maskedValue` is available to the renderer anyway, and literal credentials inside requests are masked.
 */
import { MCP_BODY_LIMIT, MCP_TOOLS, type McpCallResult, type McpToolArgs, type McpToolName } from '../../../shared/mcp'
import type { ApiFolder, ApiRequest, Collection, CollectionVersion, HttpResponseData } from '../../../shared/types'
import { expandedStore } from '../../app/expanded.svelte'
import { app } from '../../app/state.svelte'
import { api, errorInfo } from '../../lib/ipc'
import {
  assertDocumentFits,
  blankExample,
  exampleFromResponse,
  exampleName,
  parseExample,
  readExamples,
  serializeExample,
  statusReason,
  updateExamples,
} from '../../lib/examples'
import { dataRows, newRow, type KvRow } from '../../lib/kv'
import { emptyBody, newDraft, parseDocument, serializeDraft, type RawLanguage, type RequestDraft } from '../../lib/request'
import { editorCode, withScript } from '../../lib/scripts'
import { compareSemver, parseSemver, sortVersionsDesc, suggestBumps, validateVersion } from '../../lib/semver'
import { diffSnapshots, folderPath as snapshotFolderPath, snapshotFromCollection } from '../../lib/versionDiff'
import { buildUrlFromParams, mergeParamsFromUrl } from '../../lib/urlParams'
import { executeDraft } from '../requests/execute'
import { tabsStore } from '../requests/tabs.svelte'
import { collectRunItems, summarize } from '../runner/runner'
import { runsStore } from '../runner/runs.svelte'
import { mapRestored, remapExpandedKeys } from '../versions/restoreRemap'

type Data = Record<string, unknown>

/** A message for the LLM (not a crash). */
class ToolError extends Error {}
const fail = (message: string): never => {
  throw new ToolError(message)
}
const done = (data: Data): McpCallResult => ({ ok: true, text: JSON.stringify(data, null, 2), data })

// ---- lookups ----------------------------------------------------------------------------------------------------

function workspaceOf(given: string | undefined): string {
  const id = given ?? app.workspaceId ?? fail('No workspace is open in Slinger.')
  if (!app.workspaces.some((w) => w.id === id)) fail(`Unknown workspace "${id}". Use list_workspaces.`)
  return id
}

interface Tree {
  collections: Collection[]
  folders: ApiFolder[]
  requests: ApiRequest[]
}

/** The open workspace comes from the stores; another one is read through IPC. */
async function treeOf(workspaceId: string): Promise<Tree> {
  if (workspaceId === app.workspaceId) return { collections: app.collections, folders: app.folders, requests: app.requests }
  const collections = await api().listCollections(workspaceId)
  const parts = await Promise.all(collections.map(async (c) => ({ f: await api().listFolders(c.id), r: await api().listRequests(c.id) })))
  return { collections, folders: parts.flatMap((p) => p.f), requests: parts.flatMap((p) => p.r) }
}

/** Finds an item by id in the open workspace first, then in the others. */
async function locate<T>(pick: (t: Tree) => T | undefined, what: string, id: string): Promise<T> {
  const open = app.workspaceId
  if (open) {
    const hit = pick(await treeOf(open))
    if (hit) return hit
  }
  for (const w of app.workspaces) {
    if (w.id === open) continue
    const hit = pick(await treeOf(w.id))
    if (hit) return hit
  }
  return fail(`No ${what} with id "${id}". Use get_tree or search_requests to find ids.`)
}
const findRequest = (id: string) => locate((t) => t.requests.find((r) => r.id === id), 'request', id)
const findCollection = (id: string) => locate((t) => t.collections.find((c) => c.id === id), 'collection', id)
const findFolder = (id: string) => locate((t) => t.folders.find((f) => f.id === id), 'folder', id)

async function findEnvironment(id: string) {
  for (const w of app.workspaces) {
    const env = (await api().listEnvironments(w.id)).find((e) => e.id === id)
    if (env) return env
  }
  return fail(`No environment with id "${id}". Use list_environments.`)
}

/** History entry for an edit (flagged "AI assistant"). Best effort: a failure never fails the edit itself. */
async function logEdit(workspaceId: string, detail: string, request?: Pick<ApiRequest, 'id' | 'name' | 'method' | 'url'> | null): Promise<void> {
  try {
    await api().recordAssistantEdit({
      workspaceId,
      requestId: request?.id ?? null,
      requestName: request?.name ?? null,
      method: request?.method ?? '',
      url: request?.url ?? '',
      detail: detail.slice(0, 1000),
    })
    if (workspaceId === app.workspaceId) app.historyTick++
  } catch {
    /* history is a log; the change itself succeeded */
  }
}

const q = (name: string) => `“${name}”`
/** "url, headers and body" from the tool arguments that were given. */
function changedParts(a: Record<string, unknown>, skip: string[]): string {
  const parts = Object.keys(a).filter((k) => !skip.includes(k) && a[k] !== undefined).map((k) => k.replace(/_/g, ' '))
  if (parts.length === 0) return 'nothing'
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** Refreshes what the window shows after a write in `workspaceId` (other workspaces load when opened). */
async function refresh(workspaceId: string, collectionId?: string): Promise<void> {
  if (workspaceId !== app.workspaceId) return
  if (collectionId) await app.reloadCollection(collectionId)
  else await app.reloadCollections()
}

function requireOpen(workspaceId: string, what: string): void {
  if (workspaceId !== app.workspaceId) {
    const name = app.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId
    fail(`${what} only works in the workspace open in the Slinger window, and this one is in "${name}". Call open_in_app for it first.`)
  }
}

// ---- request <-> tool shapes ------------------------------------------------------------------------------------

const HIDDEN = '•••• (set, hidden)'
/** Literal credentials are hidden; {{variable}} references are shown as they are. */
const masked = (v: string) => (v === '' || v.includes('{{') ? v : HIDDEN)
const rowsOut = (rows: KvRow[]) => dataRows(rows).map((r) => ({ key: r.key, value: r.value, enabled: r.enabled }))
const rowsIn = (rows: { key: string; value: string; enabled?: boolean }[]) =>
  rows.map((r) => newRow({ key: r.key, value: r.value, enabled: r.enabled ?? true }))

function bodyOut(d: RequestDraft): Data {
  const b = d.body
  switch (b.kind) {
    case 'none':
      return { mode: 'none' }
    case 'raw':
      return b.rawLanguage === 'json' ? { mode: 'json', raw: b.raw } : { mode: 'raw', language: b.rawLanguage, raw: b.raw }
    case 'urlEncoded':
      return { mode: 'urlencoded', fields: rowsOut(b.urlEncoded) }
    case 'formData':
      return { mode: 'form-data', fields: dataRows(b.formData).map((r) => (r.kind === 'file' ? { key: r.key, file: r.value, enabled: r.enabled } : { key: r.key, value: r.value, enabled: r.enabled })) }
    case 'binary':
      return { mode: 'binary', file: b.binaryPath }
    default:
      return { mode: 'unsupported (kept as it is)' }
  }
}

function authOut(d: RequestDraft): Data {
  const a = d.auth
  switch (a.kind) {
    case 'none':
      return { type: 'none' }
    case 'basic':
      return { type: 'basic', username: a.basic.username, password: masked(a.basic.password) }
    case 'bearer':
      return { type: 'bearer', token: masked(a.bearer.token) }
    case 'apiKey':
      return { type: 'apikey', key: a.apiKey.key, value: masked(a.apiKey.value), in: a.apiKey.addTo }
    case 'oauth2':
      return {
        type: 'oauth2 (edit it in the Slinger window)',
        grant_type: a.oauth2.grantType,
        access_token_url: a.oauth2.accessTokenUrl,
        client_id: a.oauth2.clientId,
        client_secret: masked(a.oauth2.clientSecret),
        scope: a.oauth2.scope,
      }
    default:
      return { type: `${a.unsupportedType ?? 'unsupported'} (kept as it is)` }
  }
}

function requestOut(r: ApiRequest, d: RequestDraft): Data {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    collection_id: r.collectionId,
    folder_id: r.folderId,
    name: d.name,
    method: d.method,
    url: d.url,
    query: rowsOut(d.params),
    headers: rowsOut(d.headers),
    body: bodyOut(d),
    auth: authOut(d),
    pre_request_script: editorCode(d.extras.scripts, 'prerequest'),
    test_script: editorCode(d.extras.scripts, 'test'),
    description: d.description,
    saved_examples: exampleList(r),
    version: r.version,
  }
}

type RequestFields = Partial<McpToolArgs<'update_request'>>

/** Applies the given tool fields to a draft (what is not given stays). */
function applyFields(d: RequestDraft, f: RequestFields): RequestDraft {
  if (f.name !== undefined) d.name = f.name
  if (f.method !== undefined) d.method = f.method.trim().toUpperCase()
  if (f.url !== undefined) {
    d.url = f.url
    d.params = mergeParamsFromUrl(f.url, d.params)
  }
  if (f.query !== undefined) {
    d.params = rowsIn(f.query)
    d.url = buildUrlFromParams(d.url, d.params)
  }
  if (f.headers !== undefined) d.headers = rowsIn(f.headers)
  if (f.body !== undefined) {
    const b = { ...emptyBody(), preserved: undefined }
    const m = f.body.mode
    if (m === 'json' || m === 'raw') {
      b.kind = 'raw'
      b.rawLanguage = m === 'json' ? 'json' : ((f.body.language ?? 'text') as RawLanguage)
      b.raw = f.body.raw ?? ''
    } else if (m === 'urlencoded') {
      b.kind = 'urlEncoded'
      b.urlEncoded = rowsIn(f.body.fields ?? [])
    } else if (m === 'form-data') {
      b.kind = 'formData'
      b.formData = rowsIn(f.body.fields ?? [])
    }
    d.body = b
  }
  if (f.auth !== undefined) {
    const a = { ...d.auth, preserved: undefined, unsupportedType: undefined }
    const t = f.auth.type
    if (t === 'none') a.kind = 'none'
    else if (t === 'basic') {
      a.kind = 'basic'
      a.basic = { username: f.auth.username ?? a.basic.username, password: f.auth.password ?? a.basic.password }
    } else if (t === 'bearer') {
      a.kind = 'bearer'
      a.bearer = { token: f.auth.token ?? a.bearer.token }
    } else {
      a.kind = 'apiKey'
      a.apiKey = { key: f.auth.key ?? a.apiKey.key, value: f.auth.value ?? a.apiKey.value, addTo: f.auth.in ?? a.apiKey.addTo }
    }
    d.auth = a
  }
  if (f.description !== undefined) d.description = f.description
  for (const [listen, code] of [
    ['prerequest', f.pre_request_script],
    ['test', f.test_script],
  ] as const) {
    if (code === undefined) continue
    const next = withScript(d.extras.scripts, listen, code)
    const extras = { ...d.extras }
    if (next.length === 0) delete extras.scripts
    else extras.scripts = next
    d.extras = extras
  }
  return d
}

// ---- saved examples (the request document's `responses`) ---------------------------------------------------------

type ExampleFields = Partial<McpToolArgs<'update_example'>>

/** Saves a changed example list on the request (any workspace); the window follows when it shows that workspace. */
async function writeExamples(r: ApiRequest, fn: (list: unknown[]) => unknown[]): Promise<ApiRequest> {
  const documentJson = updateExamples(r.documentJson, fn)
  try {
    assertDocumentFits(documentJson)
  } catch (e) {
    fail((e as Error).message)
  }
  const updated = await api().updateRequest({ requestId: r.id, name: r.name, method: r.method, url: r.url, documentJson, expectedVersion: r.version })
  if (r.workspaceId === app.workspaceId) {
    tabsStore.afterExamplesWrite(updated)
    await app.reloadCollection(r.collectionId)
  }
  return updated
}

function pickExample(list: unknown[], sel: number | string): number {
  if (typeof sel === 'number') {
    if (sel >= list.length) fail(list.length ? `There is no example ${sel}: the request has ${list.length} (0 to ${list.length - 1}).` : 'The request has no saved examples.')
    return sel
  }
  const hits = list.flatMap((e, i) => (exampleName(e) === sel ? [i] : []))
  if (hits.length === 0) fail(`No saved example named "${sel}". get_request lists them.`)
  if (hits.length > 1) fail(`Several examples are named "${sel}" (indices ${hits.join(', ')}); give the index instead.`)
  return hits[0]!
}

const exampleList = (r: ApiRequest) =>
  readExamples(r.documentJson).map((e, index) => ({ index, name: exampleName(e), status: parseExample(e, r).response.code }))

function exampleOut(r: ApiRequest, index: number): Data {
  const stored = readExamples(r.documentJson)[index]
  const p = parseExample(stored, r)
  let body = p.response.body
  let note: string | null = null
  if (p.response.bodyEncoding === 'base64') {
    note = `binary body stored as base64 (${body.length} characters), not shown`
    body = ''
  } else if (body.length > MCP_BODY_LIMIT) {
    body = body.slice(0, MCP_BODY_LIMIT)
    note = `only the first ${MCP_BODY_LIMIT} characters are shown`
  }
  return {
    request_id: r.id,
    index,
    name: exampleName(stored),
    status_code: p.response.code,
    status_text: p.response.status,
    headers: rowsOut(p.response.headers),
    language: p.response.language || null,
    body,
    ...(note ? { body_note: note } : {}),
    request: { method: p.request.method, url: p.request.url, query: rowsOut(p.request.params), headers: rowsOut(p.request.headers), body: bodyOut(p.request), auth: authOut(p.request) },
  }
}

/** The stored example with the given tool fields applied; everything not given stays exactly as stored. */
function editedExample(stored: unknown, parent: ApiRequest, f: ExampleFields): unknown {
  const baseline = parseExample(stored, parent)
  const response = { ...baseline.response }
  if (f.name !== undefined) response.name = f.name
  if (f.status_code !== undefined) {
    response.code = f.status_code
    if (f.status_text === undefined) response.status = statusReason(f.status_code)
  }
  if (f.status_text !== undefined) response.status = f.status_text
  if (f.headers !== undefined) response.headers = rowsIn(f.headers)
  if (f.body !== undefined) {
    response.body = f.body
    response.bodyEncoding = null
  }
  if (f.language !== undefined) response.language = f.language
  const request = f.request ? applyFields(parseExample(stored, parent).request, f.request) : baseline.request
  return serializeExample(stored, baseline, { response, request })
}

// ---- collection versions ----------------------------------------------------------------------------------------

const versionsOf = async (c: Collection) => sortVersionsDesc(await api().listCollectionVersions(c.id))

function pickVersion(list: CollectionVersion[], c: Collection, text: string): CollectionVersion {
  const wanted = parseSemver(text.trim().replace(/^v/i, ''))
  const hit = wanted ? list.find((v) => { const p = parseSemver(v.version); return p !== null && compareSemver(p, wanted) === 0 }) : undefined
  return hit ?? fail(`${q(c.name)} has no version ${text}. list_versions shows its versions.`)
}

const versionLine = (v: CollectionVersion) => ({
  id: v.id,
  version: v.version,
  notes: v.notes,
  folders: v.folderCount,
  requests: v.requestCount,
  created: new Date(v.createdAt * 1000).toISOString(),
})

// ---- trees ------------------------------------------------------------------------------------------------------

const bySort = <T extends { sortOrder: number }>(a: T, b: T) => a.sortOrder - b.sortOrder
const requestLine = (r: ApiRequest) => ({ id: r.id, name: r.name, method: r.method, url: r.url })

function collectionTree(c: Collection, t: Tree): Data {
  const folders = t.folders.filter((f) => f.collectionId === c.id)
  const requests = t.requests.filter((r) => r.collectionId === c.id)
  const folderNode = (f: ApiFolder): Data => ({
    id: f.id,
    name: f.name,
    folders: folders.filter((x) => x.parentFolderId === f.id).sort(bySort).map(folderNode),
    requests: requests.filter((r) => r.folderId === f.id).sort(bySort).map(requestLine),
  })
  return {
    id: c.id,
    name: c.name,
    folders: folders.filter((f) => f.parentFolderId === null).sort(bySort).map(folderNode),
    requests: requests.filter((r) => r.folderId === null).sort(bySort).map(requestLine),
  }
}

// ---- responses --------------------------------------------------------------------------------------------------

function responseOut(res: HttpResponseData): Data {
  let body: string
  let truncated = false
  if (res.bodyText === null) body = `(binary body, ${res.bodyByteLength} bytes, not shown)`
  else {
    body = res.bodyText
    const isJson = res.headers.some((h) => h.key.toLowerCase() === 'content-type' && /json/i.test(h.value))
    if (isJson && body.length <= MCP_BODY_LIMIT) {
      try {
        body = JSON.stringify(JSON.parse(body), null, 2)
      } catch {
        /* not valid JSON after all: keep the text */
      }
    }
    if (body.length > MCP_BODY_LIMIT) {
      body = body.slice(0, MCP_BODY_LIMIT)
      truncated = true
    }
  }
  return {
    status: res.status,
    status_text: res.statusText,
    time_ms: Math.round(res.durationMs),
    size_bytes: res.bodyByteLength,
    headers: res.headers.map((h) => ({ key: h.key, value: h.value })),
    body,
    ...(truncated ? { body_truncated: `only the first ${MCP_BODY_LIMIT} characters are shown` } : {}),
  }
}

async function environmentArg(id: string | null | undefined, workspaceId: string) {
  if (id === undefined) return undefined
  if (id === null) return null
  const env = (await api().listEnvironments(workspaceId)).find((e) => e.id === id) ?? fail(`No environment "${id}" in this workspace.`)
  return { id: env.id, name: env.name }
}

// ---- the tools --------------------------------------------------------------------------------------------------

type Impl<T extends McpToolName> = (args: McpToolArgs<T>) => Promise<McpCallResult>
type Impls = { [T in McpToolName]: Impl<T> }

const tools: Impls = {
  async list_workspaces() {
    return done({ workspaces: app.workspaces.map((w) => ({ id: w.id, name: w.name, open: w.id === app.workspaceId })) })
  },

  async get_tree(a) {
    const ws = workspaceOf(a.workspace_id)
    const t = await treeOf(ws)
    const cols = a.collection_id ? t.collections.filter((c) => c.id === a.collection_id) : t.collections
    if (a.collection_id && cols.length === 0) fail(`No collection "${a.collection_id}" in this workspace.`)
    return done({ workspace_id: ws, collections: cols.map((c) => collectionTree(c, t)) })
  },

  async search_requests(a) {
    const ws = workspaceOf(a.workspace_id)
    const t = await treeOf(ws)
    const q = a.query.toLowerCase()
    const hits = t.requests.filter((r) => `${r.method} ${r.name} ${r.url}`.toLowerCase().includes(q)).slice(0, 100)
    const colName = (id: string) => t.collections.find((c) => c.id === id)?.name ?? ''
    return done({ matches: hits.map((r) => ({ ...requestLine(r), collection_id: r.collectionId, collection: colName(r.collectionId), folder_id: r.folderId })) })
  },

  async get_request(a) {
    const r = await findRequest(a.request_id)
    return done(requestOut(r, parseDocument(r)))
  },

  async create_collection(a) {
    const ws = workspaceOf(a.workspace_id)
    const c = await api().createCollection(ws, a.name)
    await refresh(ws)
    await logEdit(ws, `Created collection ${q(c.name)}`)
    return done({ created: { id: c.id, name: c.name, workspace_id: ws } })
  },

  async create_folder(a) {
    const c = await findCollection(a.collection_id)
    if (a.parent_folder_id) {
      const parent = await findFolder(a.parent_folder_id)
      if (parent.collectionId !== c.id) fail('parent_folder_id belongs to another collection.')
    }
    const f = await api().createFolder({ workspaceId: c.workspaceId, collectionId: c.id, parentFolderId: a.parent_folder_id ?? null, name: a.name })
    await refresh(c.workspaceId, c.id)
    await logEdit(c.workspaceId, `Created folder ${q(f.name)} in ${q(c.name)}`)
    return done({ created: { id: f.id, name: f.name, collection_id: c.id, parent_folder_id: f.parentFolderId } })
  },

  async create_request(a) {
    const c = await findCollection(a.collection_id)
    if (a.folder_id && (await findFolder(a.folder_id)).collectionId !== c.id) fail('folder_id belongs to another collection.')
    const s = serializeDraft(applyFields(newDraft({ name: a.name, method: a.method, url: a.url }), a))
    const r = await api().createRequest({ workspaceId: c.workspaceId, collectionId: c.id, folderId: a.folder_id ?? null, ...s })
    await refresh(c.workspaceId, c.id)
    await logEdit(c.workspaceId, `Created request ${q(r.name)} in ${q(c.name)}`, r)
    return done({ created: requestOut(r, parseDocument(r)) })
  },

  async update_request(a) {
    const r = await findRequest(a.request_id)
    const s = serializeDraft(applyFields(parseDocument(r), a))
    const updated = await api().updateRequest({ requestId: r.id, ...s, expectedVersion: r.version })
    await refresh(r.workspaceId, r.collectionId)
    await logEdit(r.workspaceId, `Edited request ${q(updated.name)}: ${changedParts(a, ['request_id'])}`, updated)
    return done({ updated: requestOut(updated, parseDocument(updated)) })
  },

  async move_request(a) {
    const r = await findRequest(a.request_id)
    const c = await findCollection(a.collection_id)
    if (c.workspaceId !== r.workspaceId) fail('Requests can only move within their workspace.')
    const folderId = a.folder_id ?? null
    if (folderId && (await findFolder(folderId)).collectionId !== c.id) fail('folder_id belongs to another collection.')
    const siblings = (await treeOf(c.workspaceId)).requests.filter((x) => x.collectionId === c.id && x.folderId === folderId && x.id !== r.id)
    const moved = await api().moveRequest({ requestId: r.id, targetCollectionId: c.id, targetFolderId: folderId, targetIndex: siblings.length })
    if (r.workspaceId === app.workspaceId) await app.reloadCollectionsById([r.collectionId, c.id])
    await logEdit(r.workspaceId, `Moved request ${q(r.name)} to ${q(c.name)}${folderId ? ` / ${q((await findFolder(folderId)).name)}` : ''}`, moved)
    return done({ moved: { id: moved.id, collection_id: moved.collectionId, folder_id: moved.folderId } })
  },

  async rename(a) {
    switch (a.kind) {
      case 'collection': {
        const c = await findCollection(a.id)
        await api().renameCollection(c.id, a.name)
        await refresh(c.workspaceId)
        await logEdit(c.workspaceId, `Renamed collection ${q(c.name)} to ${q(a.name)}`)
        break
      }
      case 'folder': {
        const f = await findFolder(a.id)
        await api().renameFolder(f.id, a.name)
        await refresh(f.workspaceId, f.collectionId)
        await logEdit(f.workspaceId, `Renamed folder ${q(f.name)} to ${q(a.name)}`)
        break
      }
      case 'request': {
        const r = await findRequest(a.id)
        await api().renameRequest(r.id, a.name)
        await refresh(r.workspaceId, r.collectionId)
        await logEdit(r.workspaceId, `Renamed request ${q(r.name)} to ${q(a.name)}`, { ...r, name: a.name })
        break
      }
      case 'environment': {
        const e = await findEnvironment(a.id)
        await api().renameEnvironment(e.id, a.name)
        if (e.workspaceId === app.workspaceId) await app.reloadEnvironments()
        await logEdit(e.workspaceId, `Renamed environment ${q(e.name)} to ${q(a.name)}`)
        break
      }
    }
    return done({ renamed: { kind: a.kind, id: a.id, name: a.name } })
  },

  async delete(a) {
    switch (a.kind) {
      case 'collection': {
        const c = await findCollection(a.id)
        await api().deleteCollection(c.id)
        await refresh(c.workspaceId)
        await logEdit(c.workspaceId, `Deleted collection ${q(c.name)}`)
        break
      }
      case 'folder': {
        const f = await findFolder(a.id)
        await api().deleteFolder(f.id)
        await refresh(f.workspaceId, f.collectionId)
        await logEdit(f.workspaceId, `Deleted folder ${q(f.name)} and its contents`)
        break
      }
      case 'request': {
        const r = await findRequest(a.id)
        await api().deleteRequest(r.id)
        await refresh(r.workspaceId, r.collectionId)
        await logEdit(r.workspaceId, `Deleted request ${q(r.name)}`, r)
        break
      }
      case 'environment': {
        const e = await findEnvironment(a.id)
        await api().deleteEnvironment(e.id)
        if (e.workspaceId === app.workspaceId) await app.reloadEnvironments()
        await logEdit(e.workspaceId, `Deleted environment ${q(e.name)}`)
        break
      }
    }
    return done({ deleted: { kind: a.kind, id: a.id } })
  },

  async get_example(a) {
    const r = await findRequest(a.request_id)
    return done(exampleOut(r, pickExample(readExamples(r.documentJson), a.example)))
  },

  async create_example(a) {
    const r = await findRequest(a.request_id)
    const example = editedExample(blankExample(a.name, parseDocument(r)), r, { ...a, name: undefined })
    let index = -1
    const updated = await writeExamples(r, (list) => {
      index = list.length
      return [...list, example]
    })
    await logEdit(r.workspaceId, `Added example ${q(a.name)} to ${q(r.name)}`, updated)
    return done({ created: exampleOut(updated, index) })
  },

  async update_example(a) {
    const r = await findRequest(a.request_id)
    const index = pickExample(readExamples(r.documentJson), a.example)
    const before = exampleName(readExamples(r.documentJson)[index])
    const updated = await writeExamples(r, (list) => {
      list[index] = editedExample(list[index], r, a)
      return list
    })
    await logEdit(r.workspaceId, `Edited example ${q(before)} of ${q(r.name)}: ${changedParts(a, ['request_id', 'example'])}`, updated)
    return done({ updated: exampleOut(updated, index) })
  },

  async delete_example(a) {
    const r = await findRequest(a.request_id)
    const index = pickExample(readExamples(r.documentJson), a.example)
    const name = exampleName(readExamples(r.documentJson)[index])
    const updated = await writeExamples(r, (list) => {
      list.splice(index, 1)
      return list
    })
    await logEdit(r.workspaceId, `Deleted example ${q(name)} of ${q(r.name)}`, updated)
    return done({ deleted: { request_id: r.id, index, name }, saved_examples: exampleList(updated) })
  },

  async list_versions(a) {
    const c = await findCollection(a.collection_id)
    const list = await versionsOf(c)
    return done({ collection_id: c.id, collection: c.name, versions: list.map(versionLine), next: suggestBumps(list.map((v) => v.version)) })
  },

  async create_version(a) {
    const c = await findCollection(a.collection_id)
    if (a.version !== undefined && a.bump !== undefined) fail('Give version or bump, not both.')
    const existing = (await versionsOf(c)).map((v) => v.version)
    const version = a.version ?? suggestBumps(existing)[a.bump ?? 'patch']
    const check = validateVersion(version, existing)
    if (!check.ok) fail(check.reason)
    const created = await api().createCollectionVersion({ collectionId: c.id, version, notes: a.notes?.trim() ? a.notes : null })
    await logEdit(c.workspaceId, `Saved version ${created.version} of ${q(c.name)}`)
    return done({ created: versionLine(created) })
  },

  async get_version(a) {
    const c = await findCollection(a.collection_id)
    const v = pickVersion(await versionsOf(c), c, a.version)
    const { snapshot } = await api().getCollectionVersion(v.id)
    const t = await treeOf(c.workspaceId)
    const live = snapshotFromCollection(c, t.folders.filter((f) => f.collectionId === c.id), t.requests.filter((r) => r.collectionId === c.id))
    const diff = diffSnapshots(snapshot, live)
    const shown = snapshot.requests.slice(0, 2000)
    return done({
      ...versionLine(v),
      collection_id: c.id,
      collection_name_then: snapshot.collectionName,
      folders: snapshot.folders.map((f) => snapshotFolderPath(snapshot.folders, f.id)),
      requests: shown.map((r) => ({ name: r.name, method: r.method, url: r.url, folder: snapshotFolderPath(snapshot.folders, r.folderId) || null })),
      ...(snapshot.requests.length > shown.length ? { requests_note: `only the first ${shown.length} of ${snapshot.requests.length} are listed` } : {}),
      changes_since: diff.identical
        ? 'none: the live collection matches this version'
        : {
            summary: diff.summary,
            requests: diff.requests.slice(0, 500).map((r) => ({ path: r.path, status: r.status, ...(r.changes.length ? { changed: r.changes.map((x) => x.field) } : {}) })),
            folders_added: diff.foldersAdded,
            folders_removed: diff.foldersRemoved,
            folders_renamed: diff.foldersRenamed,
          },
    })
  },

  async restore_version(a) {
    const c = await findCollection(a.collection_id)
    const v = pickVersion(await versionsOf(c), c, a.version)
    const inWindow = c.workspaceId === app.workspaceId
    // A replace gives every folder/request a new id: remember the layout and the clean open tabs to carry them over.
    const before = { folders: app.foldersOf(c.id).slice(), requests: app.requestsOf(c.id).slice() }
    const openIds = inWindow ? tabsStore.tabs.filter((t) => t.requestId && !t.example && !t.dirty && before.requests.some((r) => r.id === t.requestId)).map((t) => t.requestId!) : []
    const result = await api().restoreCollectionVersion(v.id, a.mode)
    await refresh(c.workspaceId)
    if (inWindow && a.mode === 'replace') {
      const map = mapRestored(before, { folders: app.foldersOf(c.id), requests: app.requestsOf(c.id) })
      expandedStore.replace(remapExpandedKeys(expandedStore.keys, map.folders, new Set(before.folders.map((f) => f.id))))
      for (const oldId of openIds) {
        const req = app.requestById(map.requests.get(oldId))
        if (req) tabsStore.openRequest(req)
      }
    }
    await logEdit(
      c.workspaceId,
      a.mode === 'copy' ? `Restored version ${v.version} of ${q(c.name)} as ${q(result.name)}` : `Replaced ${q(c.name)} with version ${v.version}`,
    )
    return done({ restored: { version: v.version, mode: a.mode, collection_id: result.id, collection: result.name } })
  },

  async list_environments(a) {
    const ws = workspaceOf(a.workspace_id)
    const envs = await api().listEnvironments(ws)
    const out = await Promise.all(
      envs.map(async (e) => ({
        id: e.id,
        name: e.name,
        active: ws === app.workspaceId && e.id === app.activeEnvironmentId,
        variables: (await api().listEnvironmentVariables(e.id)).map((v) =>
          v.isSecret ? { key: v.key, secret: true, value_set: !v.secretMissing } : { key: v.key, value: v.value ?? '' },
        ),
      })),
    )
    return done({ workspace_id: ws, environments: out })
  },

  async create_environment(a) {
    const ws = workspaceOf(a.workspace_id)
    const e = await api().createEnvironment(ws, a.name)
    if (ws === app.workspaceId) await app.reloadEnvironments()
    await logEdit(ws, `Created environment ${q(e.name)}`)
    return done({ created: { id: e.id, name: e.name, workspace_id: ws } })
  },

  async set_variable(a) {
    const env = await findEnvironment(a.environment_id)
    const existing = (await api().listEnvironmentVariables(env.id)).find((v) => v.key === a.key)
    const isSecret = a.secret ?? existing?.isSecret ?? false
    await api().upsertEnvironmentVariable({ environmentId: env.id, key: a.key, value: a.value, isSecret, variableId: existing?.id })
    if (env.workspaceId === app.workspaceId) await app.refreshEnvVariables()
    await logEdit(env.workspaceId, `${existing ? 'Changed' : 'Added'} ${isSecret ? 'secret ' : ''}variable ${q(a.key)} in ${q(env.name)}`)
    return done({ set: { environment_id: env.id, key: a.key, secret: isSecret, created: !existing } })
  },

  async delete_variable(a) {
    const env = await findEnvironment(a.environment_id)
    const v = (await api().listEnvironmentVariables(env.id)).find((x) => x.key === a.key) ?? fail(`No variable "${a.key}" in "${env.name}".`)
    await api().deleteEnvironmentVariable(v.id)
    if (env.workspaceId === app.workspaceId) await app.refreshEnvVariables()
    await logEdit(env.workspaceId, `Deleted variable ${q(a.key)} from ${q(env.name)}`)
    return done({ deleted: { environment_id: env.id, key: a.key } })
  },

  async set_active_environment(a) {
    const ws = workspaceOf(undefined)
    if (a.environment_id !== null && !app.environments.some((e) => e.id === a.environment_id)) {
      fail(`No environment "${a.environment_id}" in the open workspace.`)
    }
    await app.setActiveEnvironment(a.environment_id)
    return done({ workspace_id: ws, active_environment_id: a.environment_id })
  },

  async send_request(a) {
    let draft: RequestDraft
    let ctx: Parameters<typeof executeDraft>[1]
    if (a.save_as_example && !a.request_id) fail('save_as_example needs request_id: examples belong to a saved request.')
    if (a.request_id) {
      const r = await findRequest(a.request_id)
      requireOpen(r.workspaceId, 'Sending')
      draft = applyFields(parseDocument(r), a)
      ctx = { workspaceId: r.workspaceId, requestId: r.id, collectionId: r.collectionId, folderId: r.folderId }
    } else {
      if (!a.url) fail('Give request_id, or method and url for an ad-hoc request.')
      const ws = workspaceOf(undefined)
      draft = applyFields(newDraft({ name: a.name ?? 'MCP request', method: a.method ?? 'GET', url: a.url }), a)
      ctx = { workspaceId: ws }
    }
    const environment = await environmentArg(a.environment_id, ctx.workspaceId)
    if (environment !== undefined) ctx.environment = environment
    ctx.source = 'mcp'
    const outcome = await executeDraft(draft, ctx)
    app.historyTick++
    const tests = outcome.scripts.tests.map((t) => ({ name: t.name, result: t.status, ...(t.error ? { error: t.error } : {}) }))
    const extra = {
      ...(tests.length ? { tests } : {}),
      ...(outcome.scripts.errors.length ? { script_errors: outcome.scripts.errors.map((e) => e.message) } : {}),
      ...(outcome.scripts.console.length ? { console: outcome.scripts.console.slice(0, 50).map((c) => `${c.level}: ${c.message}`) } : {}),
    }
    if (!outcome.ok) {
      const unresolved = outcome.kind === 'unresolved' ? ` Unresolved variables: ${outcome.unresolved.join(', ')}.` : ''
      return { ok: false, error: `Not sent (${outcome.kind}): ${outcome.error}.${unresolved}${Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''}` }
    }
    let saved: Data = {}
    if (a.save_as_example && ctx.requestId) {
      // Like "Save as example": the request as sent (templates unresolved) plus the response.
      try {
        const { example, note } = exampleFromResponse({ name: a.save_as_example, request: draft, response: outcome.response })
        let index = -1
        const stored = await writeExamples(await findRequest(ctx.requestId), (list) => {
          index = list.length
          return [...list, example]
        })
        await logEdit(stored.workspaceId, `Saved the response as example ${q(a.save_as_example)} of ${q(stored.name)}`, stored)
        saved = { saved_example: { index, name: a.save_as_example, ...(note ? { note } : {}) } }
      } catch (e) {
        saved = { saved_example_error: e instanceof Error ? e.message : String(e) }
      }
    }
    return done({ response: responseOut(outcome.response), ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}), ...extra, ...saved })
  },

  async run_collection(a) {
    const c = await findCollection(a.collection_id)
    requireOpen(c.workspaceId, 'Running')
    const folder = a.folder_id ? await findFolder(a.folder_id) : null
    if (folder && folder.collectionId !== c.id) fail('folder_id belongs to another collection.')
    const items = collectRunItems(app.foldersOf(c.id), app.requestsOf(c.id), folder?.id ?? null)
    if (items.length === 0) fail('There are no requests to run there.')
    const session = runsStore.start({
      workspaceId: c.workspaceId,
      target: { collectionId: c.id, folderId: folder?.id ?? null },
      label: folder?.name ?? c.name,
      items,
      options: { delayMs: 0, stopOnFailure: a.stop_on_failure ?? false, iterations: a.iterations ?? 1 },
      environment: await environmentArg(a.environment_id, c.workspaceId),
      source: 'mcp',
    })
    await session.finished
    const s = summarize(session.state)
    return done({
      run: folder?.name ?? c.name,
      summary: s,
      stopped: session.state.stopped,
      results: session.state.rows.map((row) => ({
        request: row.item.name,
        request_id: row.item.request.id,
        iteration: row.iteration + 1,
        result: row.status,
        status: row.statusCode,
        time_ms: row.durationMs,
        ...(row.reason ? { reason: row.reason } : {}),
        ...(row.tests.length ? { tests: row.tests.map((t) => ({ name: t.name, result: t.status, ...(t.error ? { error: t.error } : {}) })) } : {}),
      })),
    })
  },

  async list_history(a) {
    const ws = workspaceOf(a.workspace_id)
    const entries = await api().listHistory(ws, a.limit ?? 20)
    return done({
      workspace_id: ws,
      history: entries.map((h) => ({
        id: h.id,
        when: new Date(h.createdAt * 1000).toISOString(),
        method: h.method,
        url: h.url,
        status: h.statusCode,
        ok: h.ok,
        ...(h.errorMessage ? { error: h.errorMessage } : {}),
        time_ms: h.durationMs,
        request_id: h.requestId,
        request_name: h.requestName,
        ...(h.kind === 'edit' ? { kind: 'edit', detail: h.detail } : {}),
        ...(h.source === 'mcp' ? { by: 'AI assistant' } : {}),
      })),
    })
  },

  async import_postman(a) {
    const ws = workspaceOf(a.workspace_id)
    const res = await api().importPostmanCollection(ws, a.collection_json)
    await refresh(ws)
    await logEdit(ws, `Imported collection ${q(res.collection.name)} (${res.requests.length} request${res.requests.length === 1 ? '' : 's'})`)
    return done({ imported: { collection_id: res.collection.id, name: res.collection.name, folders: res.folders.length, requests: res.requests.length } })
  },

  async open_in_app(a) {
    const r = await findRequest(a.request_id)
    if (r.workspaceId !== app.workspaceId) await app.selectWorkspace(r.workspaceId)
    const fresh = app.requestById(r.id) ?? r
    tabsStore.openRequest(fresh)
    return done({ opened: { id: r.id, name: r.name, workspace_id: r.workspaceId } })
  },
}

/** Runs one tool call from main. Arguments are validated again here (the renderer trusts no input). */
export async function runTool(tool: string, args: unknown): Promise<McpCallResult> {
  if (!Object.hasOwn(MCP_TOOLS, tool)) return { ok: false, error: `Unknown tool "${tool}".` }
  const name = tool as McpToolName
  const parsed = MCP_TOOLS[name].input.safeParse(args ?? {})
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` }
  try {
    return await (tools[name] as Impl<McpToolName>)(parsed.data as never)
  } catch (e) {
    return { ok: false, error: e instanceof ToolError ? e.message : errorInfo(e).message }
  }
}
