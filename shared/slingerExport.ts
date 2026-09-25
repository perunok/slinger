/**
 * Slinger's namespaced block inside an exported Postman v2.1 collection: `info._slinger`.
 *
 * The Postman v2.1 schema does not forbid extra properties on `info`, so the file stays a valid Postman
 * collection; Postman ignores the block (and drops it when the collection is re-exported from Postman).
 * Slinger reads it on import to restore the collection's version history. Written by the renderer
 * (src/lib/slingerExport.ts), validated and applied by the main process (electron/services/versionHistory.ts).
 *
 * Never contains environment values or secrets: a snapshot holds only folders, requests, scripts and
 * descriptions (the same content as the collection itself).
 */
import type { CollectionSnapshot } from './types'

/** Bumped only for incompatible changes; an importer ignores blocks with a newer major format. */
export const SLINGER_EXPORT_FORMAT_VERSION = 1

/** Limits enforced on import (the whole file is additionally capped at 50 MB). */
export const SLINGER_IMPORT_LIMITS = {
  versions: 500,
  notesChars: 10_000,
  /** Same cap as the cloud sync limit for one version snapshot. */
  snapshotBytes: 8_000_000,
  foldersPerSnapshot: 10_000,
  requestsPerSnapshot: 50_000,
} as const

export interface SlingerExportedVersion {
  /** Semantic version (no leading "v"), e.g. "1.2.0" or "2.0.0-beta.1". */
  version: string
  notes: string | null
  /** ISO-8601 UTC timestamp with whole seconds (Slinger stores seconds). */
  createdAt: string
  folderCount: number
  requestCount: number
  /** The version's frozen content. Omitted when the export was made without snapshots. */
  snapshot?: CollectionSnapshot
}

export interface SlingerExportBlock {
  formatVersion: typeof SLINGER_EXPORT_FORMAT_VERSION
  /** ISO-8601 UTC time of the export. */
  exportedAt: string
  /** "Slinger x.y.z". */
  app: string
  /** Id of the exported collection on the exporting device (informational). */
  collectionId: string
  /** False when the user unticked "Include version history snapshots": `versions` then carry metadata only. */
  includesSnapshots: boolean
  /** Oldest semver first. */
  versions: SlingerExportedVersion[]
}

/** What an import did with a file's `info._slinger` block (absent when the file had none). */
export interface VersionHistoryImportResult {
  restored: number
  skipped: number
  /** Human-readable notes: renamed or skipped versions, or why the block was ignored. */
  notes: string[]
}
