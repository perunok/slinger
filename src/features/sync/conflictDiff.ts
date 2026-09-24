/**
 * Builds the side-by-side view model of a conflict from `SyncConflict.groups` (display strings).
 *
 * Request content comes in two tiers:
 *  - full: when a group carries `localDetail` / `remoteDetail` (JSON text of the wire fields
 *    `{name, method, url, document_json}`; an optional, additive extension of SyncConflictGroup) every field is
 *    compared: name, method, URL, headers, body, authorization...
 *  - summary: the contract's own `local`/`remote` text for group `content`, "<name> - <METHOD> <url> [details #hash]",
 *    which allows comparing name, method and URL, and headers/body/auth only as a fingerprint.
 * Anything else is compared as plain text. `null` means the entity does not exist on that side.
 */
import type { SyncConflict, SyncConflictGroup } from '../../../shared/types'
import { FIELDS, render, type Rendered } from '../../lib/versionDiff'

export type LineOp = 'same' | 'del' | 'add'
export interface DiffLine {
  op: LineOp
  text: string
}

/** One compared field: `local`/`remote` are display text ('' when empty, null when that side is deleted). */
export interface DiffRow {
  key: string
  label: string
  local: string | null
  remote: string | null
  changed: boolean
  /** Line-level diff, only for multi-line values. */
  localLines: DiffLine[] | null
  remoteLines: DiffLine[] | null
}

/** SyncConflictGroup plus the optional full-detail texts a newer engine may provide (see file header). */
export type DetailedGroup = SyncConflictGroup & { baseDetail?: string | null; localDetail?: string | null; remoteDetail?: string | null }

export interface GroupDiff {
  group: SyncConflictGroup['group']
  label: string
  conflicting: boolean
  rows: DiffRow[]
  /** Explains a limited comparison. */
  note?: string
}

const FIELD_LABEL: Record<(typeof FIELDS)[number], string> = {
  name: 'Name',
  method: 'Method',
  url: 'URL',
  body: 'Body',
  headers: 'Headers',
  auth: 'Authorization',
  params: 'Disabled params',
  description: 'Description',
  other: 'Other settings',
}
/** Always shown for a request, even when equal, so the reader has context. */
const ALWAYS = new Set<string>(['name', 'method', 'url'])

/** Line diff by longest common subsequence; inputs are small (a header table, a body). */
export function lineDiff(a: string, b: string): { left: DiffLine[]; right: DiffLine[] } {
  const x = a === '' ? [] : a.split('\n')
  const y = b === '' ? [] : b.split('\n')
  if (x.length * y.length > 250_000) {
    // Too large for the quadratic table: treat as fully different.
    return { left: x.map((text) => ({ op: 'del' as const, text })), right: y.map((text) => ({ op: 'add' as const, text })) }
  }
  const n = x.length
  const m = y.length
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
  const left: DiffLine[] = []
  const right: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      left.push({ op: 'same', text: x[i] })
      right.push({ op: 'same', text: y[j] })
      i++
      j++
    } else if (t[i + 1][j] >= t[i][j + 1]) left.push({ op: 'del', text: x[i++] })
    else right.push({ op: 'add', text: y[j++] })
  }
  while (i < n) left.push({ op: 'del', text: x[i++] })
  while (j < m) right.push({ op: 'add', text: y[j++] })
  return { left, right }
}

interface RequestFields {
  name: string
  method: string
  url: string
  documentJson: string
}

/** Parses the `content` group text into request fields; null when it is not request-shaped. */
export function parseRequestContent(text: string | null): RequestFields | null {
  if (text === null) return null
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x : '')
  if ('document_json' in o || 'documentJson' in o) {
    const doc = o.document_json ?? o.documentJson
    return { name: str(o.name), method: str(o.method), url: str(o.url), documentJson: typeof doc === 'string' ? doc : JSON.stringify(doc ?? {}) }
  }
  if ('headers' in o || 'header' in o || 'body' in o || 'auth' in o || 'url' in o) {
    return { name: str(o.name), method: str(o.method), url: typeof o.url === 'string' ? o.url : '', documentJson: text }
  }
  return null
}

function multi(s: string | null): boolean {
  return s !== null && s.includes('\n')
}

function row(key: string, label: string, local: string | null, remote: string | null): DiffRow {
  const changed = local !== remote
  const lines = changed && local !== null && remote !== null && (multi(local) || multi(remote)) ? lineDiff(local, remote) : null
  return { key, label, local, remote, changed, localLines: lines?.left ?? null, remoteLines: lines?.right ?? null }
}

function requestRows(local: string | null, remote: string | null): DiffRow[] | null {
  const l = parseRequestContent(local)
  const r = parseRequestContent(remote)
  if ((local !== null && !l) || (remote !== null && !r)) return null
  if (!l && !r) return null
  const rl: Rendered | null = l ? render(l) : null
  const rr: Rendered | null = r ? render(r) : null
  const rows: DiffRow[] = []
  for (const f of FIELDS) {
    const a = rl ? rl[f] : null
    const b = rr ? rr[f] : null
    if (a === b && !ALWAYS.has(f) && (a ?? '') === '') continue
    if (a === b && !ALWAYS.has(f)) {
      // Equal, non-empty: keep for context only for the main sections.
      if (f === 'headers' || f === 'body' || f === 'auth') rows.push(row(f, FIELD_LABEL[f], a, b))
      continue
    }
    rows.push(row(f, FIELD_LABEL[f], a, b))
  }
  return rows
}

const SUMMARY = /^(.*) - ([^\s]+) (.*) \[details #([0-9a-f]+)\]$/s

/** Parses "<name> - <METHOD> <url> [details #hash]" (the contract's request `content` display text). */
export function parseContentSummary(text: string | null): { name: string; method: string; url: string; hash: string } | null {
  if (text === null) return null
  const m = SUMMARY.exec(text)
  return m ? { name: m[1], method: m[2], url: m[3], hash: m[4] } : null
}

function summaryRows(local: string | null, remote: string | null): DiffRow[] | null {
  const l = parseContentSummary(local)
  const r = parseContentSummary(remote)
  if ((local !== null && !l) || (remote !== null && !r) || (!l && !r)) return null
  return [
    row('name', 'Name', l?.name ?? null, r?.name ?? null),
    row('method', 'Method', l?.method ?? null, r?.method ?? null),
    row('url', 'URL', l?.url ?? null, r?.url ?? null),
    row('details', 'Headers, body, authorization, settings', l ? `fingerprint #${l.hash}` : null, r ? `fingerprint #${r.hash}` : null),
  ]
}

export function buildGroupDiffs(c: { entityType: SyncConflict['entityType']; groups: DetailedGroup[] }): GroupDiff[] {
  return c.groups.map((g) => {
    let rows: DiffRow[] | null = null
    let note: string | undefined
    if (c.entityType === 'request' && g.group === 'content') {
      if (g.localDetail !== undefined || g.remoteDetail !== undefined) rows = requestRows(g.localDetail ?? null, g.remoteDetail ?? null)
      rows ??= requestRows(g.local, g.remote)
      if (!rows) {
        rows = summaryRows(g.local, g.remote)
        if (rows?.find((x) => x.key === 'details')?.changed) note = 'Headers, body and authorization differ (compared by fingerprint only). Open the request in its tab to inspect them.'
      }
    }
    rows ??= [row(g.group, g.label, g.local, g.remote)]
    return { group: g.group, label: g.label, conflicting: g.conflicting, rows, note }
  })
}

/** Groups whose value differs between the sides and therefore need a choice when merging. */
export function conflictingGroups(c: { groups: Array<Pick<SyncConflictGroup, 'group' | 'conflicting'>> }): SyncConflictGroup['group'][] {
  return c.groups.filter((g) => g.conflicting).map((g) => g.group)
}

export function displayValue(v: string | null, deletedLabel: string): string {
  return v === null ? deletedLabel : v === '' ? '(empty)' : v
}
