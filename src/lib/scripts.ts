/**
 * Pre-request / test scripts in the renderer: pure helpers. Scripts are stored in Postman's `event` shape
 * (`[{ listen: 'prerequest' | 'test', script: { exec: string[], type: 'text/javascript' } }]`): inside a request
 * document under `scripts` (as the importer always did), and as `scriptsJson` text on collections and folders.
 * Editing is byte-faithful: an untouched script keeps its stored object, an edited one only replaces `exec`.
 *
 * Scripts never run here; they run in the main process (runScripts). This file only assembles their input and
 * applies their output to the outgoing draft.
 */
import type {
  ApiFolder,
  Collection,
  HttpRequestInput,
  HttpResponseData,
  ScriptConsoleEntry,
  ScriptErrorInfo,
  ScriptEventName,
  ScriptKeyValue,
  ScriptRequestData,
  ScriptResponseData,
  ScriptSource,
  ScriptTestResult,
  ScriptVariables,
} from '../../shared/types'
import { dataRows, ensureTrailingEmpty, newRow } from './kv'
import { RAW_LANGUAGES, type RawLanguage, type RequestDraft } from './request'
import type { TemplateScope, VariableInfo } from './template'

export type ScriptListen = ScriptEventName

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/** What a send produced from scripts, shown in the response area's Tests and Console tabs. */
export interface ScriptOutput {
  tests: ScriptTestResult[]
  console: ScriptConsoleEntry[]
  errors: ScriptErrorInfo[]
  /** Scripts that ran (pre-request + test). 0 means the request has no scripts at all. */
  scriptCount: number
}

export const emptyScriptOutput = (): ScriptOutput => ({ tests: [], console: [], errors: [], scriptCount: 0 })

// ---------------------------------------------------------------------------
// Postman `event` arrays
// ---------------------------------------------------------------------------

export function eventList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** `script.exec` (array of lines or a string) as one text. */
export function execText(exec: unknown): string {
  if (Array.isArray(exec)) return exec.map((l) => (typeof l === 'string' ? l : String(l ?? ''))).join('\n')
  return typeof exec === 'string' ? exec : ''
}

function entryIndex(events: unknown[], listen: ScriptListen): number {
  return events.findIndex((e) => isObj(e) && e.listen === listen)
}

/** The code shown in the editor: the first entry for `listen` (Postman writes at most one). */
export function editorCode(events: unknown, listen: ScriptListen): string {
  const list = eventList(events)
  const i = entryIndex(list, listen)
  const e = i >= 0 ? list[i] : null
  return isObj(e) && isObj(e.script) ? execText(e.script.exec) : ''
}

/** The code that runs: every enabled entry for `listen`, in order. */
export function runnableCode(events: unknown, listen: ScriptListen): string {
  return eventList(events)
    .filter((e): e is Json => isObj(e) && e.listen === listen && e.disabled !== true && isObj(e.script))
    .map((e) => execText((e.script as Json).exec))
    .filter((code) => code.trim() !== '')
    .join('\n')
}

/**
 * Returns `events` with the code for `listen` replaced. Unchanged code returns the SAME array (so an unedited
 * document serializes byte for byte); an edit replaces only `script.exec` of the existing entry; empty code
 * removes the entry; new code appends a Postman-shaped entry.
 */
export function withScript(events: unknown, listen: ScriptListen, code: string): unknown[] {
  const list = eventList(events)
  if (editorCode(list, listen) === code) return list
  const i = entryIndex(list, listen)
  const next = [...list]
  if (code === '') {
    if (i >= 0) next.splice(i, 1)
    return next
  }
  const lines = code.split('\n')
  if (i >= 0) {
    const e = list[i] as Json
    next[i] = { ...e, script: { ...(isObj(e.script) ? e.script : { type: 'text/javascript' }), exec: lines } }
  } else next.push({ listen, script: { type: 'text/javascript', exec: lines } })
  return next
}

/** Parses a stored `scriptsJson`; anything invalid counts as "no scripts". */
export function parseScriptsJson(json: string | null | undefined): unknown[] {
  if (!json) return []
  try {
    return eventList(JSON.parse(json))
  } catch {
    return []
  }
}

/** Stored text for an events array (null when there are none). */
export function scriptsJsonOf(events: unknown[]): string | null {
  return events.length === 0 ? null : JSON.stringify(events)
}

/** Number of pre-request/test entries with code (Postman import preview). */
export function countScripts(events: unknown): number {
  return eventList(events).filter((e) => isObj(e) && (e.listen === 'prerequest' || e.listen === 'test') && e.disabled !== true && isObj(e.script) && execText(e.script.exec).trim() !== '').length
}

// ---------------------------------------------------------------------------
// The chain: collection -> folders (outer to inner) -> request
// ---------------------------------------------------------------------------

/** Folders from the collection root down to `folderId` (cycle-safe). */
export function folderPath(folders: ApiFolder[], folderId: string | null): ApiFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const path: ApiFolder[] = []
  const seen = new Set<string>()
  let cur = folderId ? byId.get(folderId) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.unshift(cur)
    cur = cur.parentFolderId ? byId.get(cur.parentFolderId) : undefined
  }
  return path
}

export interface ChainContext {
  collection: Pick<Collection, 'name' | 'scriptsJson'> | null
  folders: ApiFolder[]
  folderId: string | null
  requestName: string
  /** The request document's `scripts` (the draft's, so unsaved edits run). */
  requestEvents: unknown
}

export function scriptChain(listen: ScriptListen, ctx: ChainContext): ScriptSource[] {
  const out: ScriptSource[] = []
  const add = (origin: ScriptSource['origin'], name: string, events: unknown) => {
    const code = runnableCode(events, listen)
    if (code.trim()) out.push({ origin, name, code })
  }
  if (ctx.collection) add('collection', ctx.collection.name, parseScriptsJson(ctx.collection.scriptsJson))
  for (const f of folderPath(ctx.folders, ctx.folderId)) add('folder', f.name, parseScriptsJson(f.scriptsJson))
  add('request', ctx.requestName || 'Untitled Request', ctx.requestEvents)
  return out
}

// ---------------------------------------------------------------------------
// Request / response as scripts see them
// ---------------------------------------------------------------------------

function kv(rows: { key: string; value: string; enabled: boolean }[]): ScriptKeyValue[] {
  return rows.map((r) => (r.enabled ? { key: r.key, value: r.value } : { key: r.key, value: r.value, disabled: true }))
}

/** `pm.request` for a pre-request script: the draft with templates unresolved (as in Postman). */
export function requestDataFromDraft(d: RequestDraft): ScriptRequestData {
  const headers = kv(dataRows(d.headers))
  const b = d.body
  let body: ScriptRequestData['body']
  switch (b.kind) {
    case 'raw':
      body = { mode: 'raw', raw: b.raw, language: b.rawLanguage }
      break
    case 'urlEncoded':
      body = { mode: 'urlencoded', urlencoded: kv(dataRows(b.urlEncoded)) }
      break
    case 'formData':
      body = { mode: 'formdata', formdata: kv(dataRows(b.formData).map((r) => (r.kind === 'file' ? { ...r, value: '' } : r))) }
      break
    case 'binary':
      body = { mode: 'file' }
      break
    case 'unsupported':
      body = { mode: 'other' }
      break
    default:
      body = { mode: 'none' }
  }
  return { method: d.method, url: d.url, headers, body }
}

/** `pm.request` for a test script: what was sent, with secret variables still shown as `{{name}}`. */
export function requestDataFromInput(input: HttpRequestInput): ScriptRequestData {
  const b = input.body
  let body: ScriptRequestData['body'] = { mode: 'none' }
  if (b.mode === 'raw') body = { mode: 'raw', raw: b.raw?.content ?? '' }
  else if (b.mode === 'urlEncoded') body = { mode: 'urlencoded', urlencoded: (b.urlEncoded ?? []).map((f) => ({ key: f.key, value: f.value })) }
  else if (b.mode === 'formData') body = { mode: 'formdata', formdata: (b.formData ?? []).map((f) => ({ key: f.key, value: f.value })) }
  else if (b.mode === 'binary') body = { mode: 'file' }
  return { method: input.method, url: input.url, headers: input.headers.map((h) => ({ key: h.key, value: h.value })), body }
}

const RAW_IDS = new Set(RAW_LANGUAGES.map((l) => l.id))

/** The outgoing copy of the draft after pre-request mutations (the stored request and the tab are untouched). */
export function applyRequestData(d: RequestDraft, r: ScriptRequestData): RequestDraft {
  const next: RequestDraft = {
    ...d,
    method: r.method,
    url: r.url,
    headers: ensureTrailingEmpty(r.headers.map((h) => newRow({ key: h.key, value: h.value, enabled: !h.disabled }))),
  }
  if (r.body.mode === 'raw') {
    const lang = RAW_IDS.has(r.body.language as RawLanguage) ? (r.body.language as RawLanguage) : d.body.kind === 'raw' ? d.body.rawLanguage : 'text'
    next.body = { ...d.body, kind: 'raw', raw: r.body.raw ?? '', rawLanguage: lang }
  } else if (r.body.mode === 'none' && d.body.kind !== 'none') {
    next.body = { ...d.body, kind: 'none' }
  }
  return next
}

/** Largest response body passed to test scripts (the sandbox caps at the same size). */
export const SCRIPT_BODY_LIMIT = 8 * 1024 * 1024

export function responseDataFrom(res: HttpResponseData): ScriptResponseData {
  const text = res.bodyText
  return {
    code: res.status,
    status: res.statusText,
    headers: res.headers,
    body: text === null ? null : text.length > SCRIPT_BODY_LIMIT ? text.slice(0, SCRIPT_BODY_LIMIT + 1) : text,
    responseTime: res.durationMs,
    size: res.bodyByteLength,
  }
}

// ---------------------------------------------------------------------------
// Template scope with script variables
// ---------------------------------------------------------------------------

/** How a script value appears in `{{template}}` text (strings as-is, other values as JSON). */
export function templateValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  return JSON.stringify(v)
}

/**
 * The scope used to resolve a request after its pre-request scripts: globals < collection variables <
 * environment < local variables (pm.variables), Postman's precedence. Script values are never secret.
 */
export function scopeWithScriptVariables(
  base: TemplateScope,
  layers: { globals: ScriptVariables; collection: ScriptVariables; local: ScriptVariables },
): TemplateScope {
  const map = new Map<string, VariableInfo>()
  const put = (vars: ScriptVariables) => {
    for (const key of Object.keys(vars)) if (key) map.set(key, { key, value: templateValue(vars[key]), secret: false })
  }
  put(layers.globals)
  put(layers.collection)
  for (const [k, v] of base.variables) map.set(k, v)
  put(layers.local)
  return { environmentName: base.environmentName, variables: map }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function testCounts(out: Pick<ScriptOutput, 'tests' | 'errors'> | null): { passed: number; failed: number; skipped: number; total: number } {
  const tests = out?.tests ?? []
  const passed = tests.filter((t) => t.status === 'passed').length
  const skipped = tests.filter((t) => t.status === 'skipped').length
  // A test script that crashed counts as a failure even when it recorded no test.
  const scriptErrors = (out?.errors ?? []).filter((e) => e.source.startsWith('Tests')).length
  const failed = tests.filter((t) => t.status === 'failed').length + scriptErrors
  return { passed, failed, skipped, total: passed + failed + skipped }
}
