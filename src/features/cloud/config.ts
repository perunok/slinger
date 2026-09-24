/**
 * Non-secret cloud config, kept in localStorage:
 *  - `slinger.cloud.config`: { apiBaseUrl, deviceName }
 *  - `slinger.cloud.links`:  { [apiBaseUrl]: { [localWorkspaceId]: { remoteId, remoteName } } }
 * Tokens are NOT stored here (see session.ts).
 */
import type { CloudConfig, WorkspaceLink } from './types'

const CONFIG_KEY = 'slinger.cloud.config'
const LINKS_KEY = 'slinger.cloud.links'
export const DEFAULT_BASE_URL = 'https://api.slinger.app'

type LinkMap = Record<string, Record<string, WorkspaceLink>>

function read<T>(k: string): T | null {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function write(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

export const normalizeBaseUrl = (u: string) => u.trim().replace(/\/+$/, '')

export function isValidBaseUrl(u: string): boolean {
  try {
    const p = new URL(u.trim()).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

export function loadConfig(): CloudConfig {
  const c = read<Partial<CloudConfig>>(CONFIG_KEY)
  return {
    apiBaseUrl: normalizeBaseUrl(c?.apiBaseUrl || DEFAULT_BASE_URL),
    deviceName: c?.deviceName?.trim() || 'Slinger Desktop',
  }
}
export function saveConfig(c: CloudConfig) {
  write(CONFIG_KEY, { apiBaseUrl: normalizeBaseUrl(c.apiBaseUrl), deviceName: c.deviceName.trim() })
}

export function getLink(baseUrl: string, localId: string): WorkspaceLink | null {
  return read<LinkMap>(LINKS_KEY)?.[normalizeBaseUrl(baseUrl)]?.[localId] ?? null
}
export function setLink(baseUrl: string, localId: string, link: WorkspaceLink | null) {
  const all = read<LinkMap>(LINKS_KEY) ?? {}
  const b = normalizeBaseUrl(baseUrl)
  const forBase = { ...(all[b] ?? {}) }
  if (link) forBase[localId] = link
  else delete forBase[localId]
  write(LINKS_KEY, { ...all, [b]: forBase })
}
