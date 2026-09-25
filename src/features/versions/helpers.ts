/** Pure helpers for the versions feature. */
import type { ApiFolder, ApiRequest, CollectionSnapshot } from '../../../shared/types'
import { buildTree, type TreeNode } from '../../lib/tree'
import { parseSemver, validateVersion } from '../../lib/semver'

export function formatCreated(createdAtSeconds: number): string {
  return new Date(createdAtSeconds * 1000).toLocaleString()
}

export function isPrerelease(version: string): boolean {
  return (parseSemver(version)?.prerelease.length ?? 0) > 0
}

export function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function methodColor(method: string): string {
  const m = method.toLowerCase()
  return ['get', 'post', 'put', 'patch', 'delete'].includes(m) ? `var(--m-${m})` : 'var(--m-other)'
}

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
