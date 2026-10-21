/** Pure helpers for the versions feature. */
import type { ApiFolder, ApiRequest, CollectionSnapshot, CollectionVersionAuthor } from '../../../shared/types'
import { buildTree, type TreeNode } from '../../lib/tree'
import { parseSemver, validateVersion } from '../../lib/semver'

export function formatCreated(createdAtSeconds: number): string {
  return new Date(createdAtSeconds * 1000).toLocaleString()
}

/** Seconds from "now" up to which a date reads as relative ("3 h ago"); older ones show the calendar date. */
const RELATIVE_DAYS = 7

/**
 * Compact "when" for lists: "just now", "5 min ago", "3 h ago", "2 d ago", then the calendar date ("14 Mar 2026").
 * `now` is epoch seconds (a parameter, so tests and the 15 s UI tick stay deterministic).
 */
export function formatWhen(createdAtSeconds: number, now: number = Math.floor(Date.now() / 1000)): string {
  const s = Math.max(0, now - createdAtSeconds)
  if (s < 10) return 'just now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < RELATIVE_DAYS) return `${d} d ago`
  return new Date(createdAtSeconds * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Whether the author is the signed-in cloud user (`sync.session.user.id`). Never true for an unknown author or id. */
export function isYou(createdBy: CollectionVersionAuthor | null, userId: string | null | undefined): boolean {
  return !!createdBy && createdBy.id != null && !!userId && createdBy.id === userId
}

/** "Ana Silva", "Ana Silva (you)"; null when the author is unknown. */
export function authorLabel(createdBy: CollectionVersionAuthor | null, userId?: string | null): string | null {
  if (!createdBy) return null
  return isYou(createdBy, userId) ? `${createdBy.name} (you)` : createdBy.name
}

/** One line under a list row: "Ana Silva · 3 h ago", or just "3 h ago" when the author is unknown. */
export function listByline(v: { createdBy: CollectionVersionAuthor | null; createdAt: number }, userId?: string | null, now?: number): string {
  const who = authorLabel(v.createdBy, userId)
  const when = formatWhen(v.createdAt, now)
  return who ? `${who} · ${when}` : when
}

/** Detail header: "Created by Ana Silva (you) · 14.03.2026, 10:00:00", or "Created 14.03.2026, 10:00:00" for an unknown author. */
export function detailByline(v: { createdBy: CollectionVersionAuthor | null; createdAt: number }, userId?: string | null): string {
  const who = authorLabel(v.createdBy, userId)
  return `Created${who ? ` by ${who}` : ''} · ${formatCreated(v.createdAt)}`
}

/** Compare heading for one side: "v1.0.0 · Ana Silva (you), 14.03.2026, 10:00:00"; unknown author: date only. */
export function compareSide(v: { version: string; createdBy: CollectionVersionAuthor | null; createdAt: number }, userId?: string | null): string {
  const who = authorLabel(v.createdBy, userId)
  return `v${v.version} · ${who ? `${who}, ` : ''}${formatCreated(v.createdAt)}`
}

export function isPrerelease(version: string): boolean {
  return (parseSemver(version)?.prerelease.length ?? 0) > 0
}

export function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Re-exported for the versions views; the colours live in requests/method.ts. */
export { methodColor } from '../requests/method'

export interface CreateFormState {
  valid: boolean
  /** Reason to show; null when valid or when nothing has been typed yet. */
  reason: string | null
}

export function createFormState(text: string, existing: string[]): CreateFormState {
  const r = validateVersion(text, existing)
  if (r.ok) return { valid: true, reason: null }
  return { valid: false, reason: text === '' ? null : r.reason }
}

export function copyName(collectionName: string, version: string): string {
  return `${collectionName} (v${version})`
}

/** Builds the folder/request tree of a snapshot with the shared tree builder. */
export function snapshotTree(snapshot: CollectionSnapshot): TreeNode[] {
  const folders = snapshot.folders.map(
    (f): ApiFolder => ({ ...f, workspaceId: '', collectionId: '', createdAt: 0, updatedAt: 0, version: 0 }),
  )
  const requests = snapshot.requests.map(
    (r): ApiRequest => ({ ...r, workspaceId: '', collectionId: '', createdAt: 0, updatedAt: 0, version: 0 }),
  )
  return buildTree(folders, requests)
}
