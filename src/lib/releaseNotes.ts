/**
 * Release notes in the app: which CHANGELOG.md sections to show (Help > Release Notes shows every released version,
 * What's new the versions since the last one this installation ran) and when What's new opens by itself.
 * Persisted as JSON in `localStorage['slinger.whatsNew']`: `{ seen }`, the last version whose start was seen.
 */
import type { ChangelogEntry } from '../../shared/changelog.mjs'
import { compareSemver, parseSemver } from './semver'

export const WHATS_NEW_STORAGE_KEY = 'slinger.whatsNew'
/**
 * Keys every installation that has run Slinger before has written (workspace, appearance, update check). Without a
 * stored `seen`, one of them means "updated from a version before What's new existed", none means "fresh install".
 */
export const EXISTING_INSTALL_KEYS = ['slinger.workspace', 'slinger.appearance', 'slinger.updates', 'slinger.theme'] as const

const isStable = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && parseSemver(v)?.prerelease.length === 0

/** Released sections only (an "unreleased" one is still being written), newest first as in the file. */
export function releasedEntries(entries: readonly ChangelogEntry[]): ChangelogEntry[] {
  return entries.filter((e) => e.date !== null && !!parseSemver(e.version))
}

/** The released sections newer than `after` up to and including `current` (`after` null: `current` alone). */
export function entriesSince(entries: readonly ChangelogEntry[], after: string | null, current: string): ChangelogEntry[] {
  return releasedEntries(entries).filter((e) => compareSemver(e.version, current) <= 0 && (after === null ? compareSemver(e.version, current) === 0 : compareSemver(e.version, after) > 0))
}

/** One Markdown document: a `## version · date` heading per section, then its notes. */
export function entriesToMarkdown(entries: readonly ChangelogEntry[]): string {
  return entries.map((e) => `## ${e.version}${e.date ? ` · ${e.date}` : ''}\n\n${e.body || '_No notes._'}`).join('\n\n')
}

/** The stored last-seen version, or null (missing, corrupt, not a stable version). */
export function loadSeenVersion(raw: string | null): string | null {
  try {
    const o: unknown = raw ? JSON.parse(raw) : null
    const seen = o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>).seen : null
    return isStable(seen) ? seen : null
  } catch {
    return null
  }
}

export interface WhatsNewDecision {
  /** Open What's new for the versions after `after` (null: the current version only). */
  show: boolean
  after: string | null
  /** Store `current` as seen. */
  record: boolean
}

/**
 * At startup: show What's new on the first start of a new version, never on a fresh install, a downgrade, a
 * development build (pre-release version) or when there are no notes for it.
 */
export function decideWhatsNew(seen: string | null, current: string | null, existingInstall: boolean): WhatsNewDecision {
  const none: WhatsNewDecision = { show: false, after: null, record: false }
  if (!isStable(current)) return none
  if (seen === null) return { show: existingInstall, after: null, record: true }
  const cmp = compareSemver(current, seen)
  if (cmp === 0) return none
  return { show: cmp > 0, after: cmp > 0 ? seen : null, record: true }
}
