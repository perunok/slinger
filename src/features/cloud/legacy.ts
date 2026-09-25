/**
 * One-time cleanup of the pre-sync renderer storage. Before sync existed the renderer kept the cloud
 * server config (`slinger.cloud.config`) and workspace links (`slinger.cloud.links`, names only: nothing was
 * ever uploaded) in localStorage. Config moves to the main process; links are NOT converted (linking is a
 * merge that needs consent) but remembered as a dismissible hint.
 */
import type { CloudConfig } from '../../../shared/types'
import { DEFAULT_BASE_URL } from './url'

const CONFIG_KEY = 'slinger.cloud.config'
const LINKS_KEY = 'slinger.cloud.links'
const HINTS_KEY = 'slinger.cloud.legacyHints'

export interface LegacyHint {
  localWorkspaceId: string
  remoteName: string
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function remove(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* hints just will not persist */
  }
}

export function parseLegacyLinks(raw: unknown): LegacyHint[] {
  const out: LegacyHint[] = []
  if (!raw || typeof raw !== 'object') return out
  for (const byWorkspace of Object.values(raw as Record<string, unknown>)) {
    if (!byWorkspace || typeof byWorkspace !== 'object') continue
    for (const [localWorkspaceId, link] of Object.entries(byWorkspace as Record<string, unknown>)) {
      const name = (link as { remoteName?: unknown } | null)?.remoteName
      if (typeof name === 'string' && name) out.push({ localWorkspaceId, remoteName: name })
    }
  }
  return out
}

export interface LegacyResult {
  /** Config to copy to the main process (only when it differs from the defaults). */
  config: CloudConfig | null
  hints: LegacyHint[]
}

/**
 * Reads and removes the legacy keys. `current` is the main-process config: the legacy config is only
 * offered when that one is still the default. Hints persist under their own key until dismissed.
 */
export function collectLegacy(current: CloudConfig | null): LegacyResult {
  const cfg = read<Partial<CloudConfig>>(CONFIG_KEY)
  const links = parseLegacyLinks(read(LINKS_KEY))
  const stillDefault = !current || (current.apiBaseUrl === DEFAULT_BASE_URL && current.deviceName === 'Slinger Desktop')
  let config: CloudConfig | null = null
  if (cfg && typeof cfg.apiBaseUrl === 'string' && stillDefault) {
    const candidate = { apiBaseUrl: cfg.apiBaseUrl.trim().replace(/\/+$/, ''), deviceName: (cfg.deviceName ?? '').trim() || 'Slinger Desktop' }
    if (candidate.apiBaseUrl && (candidate.apiBaseUrl !== DEFAULT_BASE_URL || candidate.deviceName !== 'Slinger Desktop')) config = candidate
  }
  remove(CONFIG_KEY)
  remove(LINKS_KEY)
  const saved = read<LegacyHint[]>(HINTS_KEY) ?? []
  const hints = [...saved, ...links.filter((l) => !saved.some((s) => s.localWorkspaceId === l.localWorkspaceId))]
  if (links.length > 0) write(HINTS_KEY, hints)
  return { config, hints }
}

export function dismissLegacyHint(localWorkspaceId: string): void {
  const rest = (read<LegacyHint[]>(HINTS_KEY) ?? []).filter((h) => h.localWorkspaceId !== localWorkspaceId)
  if (rest.length === 0) remove(HINTS_KEY)
  else write(HINTS_KEY, rest)
}
