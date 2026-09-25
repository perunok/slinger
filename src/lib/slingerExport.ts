/**
 * Builds the `info._slinger` version-history block of an exported collection (format: shared/slingerExport.ts).
 * Pure: the caller loads the versions (and their snapshots) and passes them in.
 */
import {
  SLINGER_EXPORT_FORMAT_VERSION,
  type SlingerExportBlock,
  type SlingerExportedVersion,
} from '../../shared/slingerExport'
import type { CollectionSnapshot, CollectionVersion } from '../../shared/types'
import { compareSemver, parseSemver, sortVersionsDesc } from './semver'

export type VersionForExport = CollectionVersion & { snapshot?: CollectionSnapshot | null }

/** ISO-8601 UTC for an epoch-seconds timestamp ("2026-09-25T10:00:00.000Z"). */
export const isoFromSeconds = (seconds: number): string => new Date(Math.round(seconds) * 1000).toISOString()

/** The highest semver among `versions` (pre-releases count), or null when there are none. */
export function latestVersion(versions: readonly { version: string }[]): string | null {
  return sortVersionsDesc(versions.filter((v) => parseSemver(v.version)))[0]?.version ?? null
}

export interface SlingerBlockInput {
  collectionId: string
  versions: readonly VersionForExport[]
  /** When false only the version list (semver, notes, date, counts) is written. */
  includeSnapshots: boolean
  /** e.g. "0.3.2" (from getAppVersion). */
  appVersion: string
  now?: Date
}

export function buildSlingerBlock(input: SlingerBlockInput): SlingerExportBlock {
  const versions: SlingerExportedVersion[] = input.versions
    .filter((v) => parseSemver(v.version))
    .sort((a, b) => compareSemver(a.version, b.version))
    .map((v) => {
      const out: SlingerExportedVersion = {
        version: v.version,
        notes: v.notes ?? null,
        createdAt: isoFromSeconds(v.createdAt),
        folderCount: v.folderCount,
        requestCount: v.requestCount,
      }
      if (input.includeSnapshots) {
        if (!v.snapshot) throw new Error(`The snapshot of version ${v.version} is not loaded`)
        out.snapshot = v.snapshot
      }
      return out
    })
  return {
    formatVersion: SLINGER_EXPORT_FORMAT_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    app: `Slinger ${input.appVersion}`,
    collectionId: input.collectionId,
    includesSnapshots: input.includeSnapshots,
    versions,
  }
}
