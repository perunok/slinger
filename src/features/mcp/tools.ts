/**
 * MCP tool implementations (shared/mcp.ts declares them; main forwards calls here). They use the same model and actions as
 * the UI: requests are edited through RequestDraft (parseDocument / serializeDraft), sends go through executeDraft, runs
 * through the runner store, and every write refreshes the stores so the window shows it at once.
 *
 * Results are JSON (as text for the LLM, and as structured content). Secret variable values are never read: only
 * `maskedValue` is available to the renderer anyway, and literal credentials inside requests are masked.
 */
import { MCP_BODY_LIMIT, MCP_TOOLS, type McpCallResult, type McpToolArgs, type McpToolName } from '../../../shared/mcp'
import type { ApiFolder, ApiRequest, Collection, HttpResponseData } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { api, errorInfo } from '../../lib/ipc'
import { readExamples } from '../../lib/examples'
import { dataRows, newRow, type KvRow } from '../../lib/kv'
import { emptyBody, newDraft, parseDocument, serializeDraft, type RawLanguage, type RequestDraft } from '../../lib/request'
import { editorCode, withScript } from '../../lib/scripts'
import { buildUrlFromParams, mergeParamsFromUrl } from '../../lib/urlParams'
import { executeDraft } from '../requests/execute'
import { tabsStore } from '../requests/tabs.svelte'
import { collectRunItems, summarize } from '../runner/runner'
import { runsStore } from '../runner/runs.svelte'

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
    saved_examples: readExamples(r.documentJson).map((e) => String((e as { name?: unknown }).name ?? 'Example')),
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
    return done({ created: { id: f.id, name: f.name, collection_id: c.id, parent_folder_id: f.parentFolderId } })
  },

  async create_request(a) {
    const c = await findCollection(a.collection_id)
    if (a.folder_id && (await findFolder(a.folder_id)).collectionId !== c.id) fail('folder_id belongs to another collection.')
    const s = serializeDraft(applyFields(newDraft({ name: a.name, method: a.method, url: a.url }), a))
    const r = await api().createRequest({ workspaceId: c.workspaceId, collectionId: c.id, folderId: a.folder_id ?? null, ...s })
    await refresh(c.workspaceId, c.id)
    return done({ created: requestOut(r, parseDocument(r)) })
  },

  async update_request(a) {
    const r = await findRequest(a.request_id)
    const s = serializeDraft(applyFields(parseDocument(r), a))
    const updated = await api().updateRequest({ requestId: r.id, ...s, expectedVersion: r.version })
    await refresh(r.workspaceId, r.collectionId)
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
    return done({ moved: { id: moved.id, collection_id: moved.collectionId, folder_id: moved.folderId } })
  },

  async rename(a) {
    switch (a.kind) {
      case 'collection': {
        const c = await findCollection(a.id)
        await api().renameCollection(c.id, a.name)
        await refresh(c.workspaceId)
        break
      }
      case 'folder': {
        const f = await findFolder(a.id)
        await api().renameFolder(f.id, a.name)
        await refresh(f.workspaceId, f.collectionId)
        break
      }
      case 'request': {
        const r = await findRequest(a.id)
        await api().renameRequest(r.id, a.name)
        await refresh(r.workspaceId, r.collectionId)
        break
      }
      case 'environment': {
        const e = await findEnvironment(a.id)
        await api().renameEnvironment(e.id, a.name)
        if (e.workspaceId === app.workspaceId) await app.reloadEnvironments()
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
        break
      }
      case 'folder': {
        const f = await findFolder(a.id)
        await api().deleteFolder(f.id)
        await refresh(f.workspaceId, f.collectionId)
        break
      }
      case 'request': {
        const r = await findRequest(a.id)
        await api().deleteRequest(r.id)
        await refresh(r.workspaceId, r.collectionId)
        break
      }
      case 'environment': {
        const e = await findEnvironment(a.id)
        await api().deleteEnvironment(e.id)
        if (e.workspaceId === app.workspaceId) await app.reloadEnvironments()
        break
      }
    }
    return done({ deleted: { kind: a.kind, id: a.id } })
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
    return done({ created: { id: e.id, name: e.name, workspace_id: ws } })
  },

  async set_variable(a) {
    const env = await findEnvironment(a.environment_id)
    const existing = (await api().listEnvironmentVariables(env.id)).find((v) => v.key === a.key)
    const isSecret = a.secret ?? existing?.isSecret ?? false
    await api().upsertEnvironmentVariable({ environmentId: env.id, key: a.key, value: a.value, isSecret, variableId: existing?.id })
    if (env.workspaceId === app.workspaceId) await app.refreshEnvVariables()
    return done({ set: { environment_id: env.id, key: a.key, secret: isSecret, created: !existing } })
  },

  async delete_variable(a) {
    const env = await findEnvironment(a.environment_id)
    const v = (await api().listEnvironmentVariables(env.id)).find((x) => x.key === a.key) ?? fail(`No variable "${a.key}" in "${env.name}".`)
    await api().deleteEnvironmentVariable(v.id)
    if (env.workspaceId === app.workspaceId) await app.refreshEnvVariables()
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
    return done({ response: responseOut(outcome.response), ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}), ...extra })
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
      })),
    })
  },

  async import_postman(a) {
    const ws = workspaceOf(a.workspace_id)
    const res = await api().importPostmanCollection(ws, a.collection_json)
    await refresh(ws)
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
