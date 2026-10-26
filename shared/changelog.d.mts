export interface ChangelogEntry {
  /** Semantic version without the leading "v". */
  version: string
  /** The heading's date text (e.g. "2026-10-26"), or null for an unreleased section. */
  date: string | null
  /** Markdown under the heading, trimmed. */
  body: string
}
export const UNRELEASED_PLACEHOLDER: string
export function parseChangelog(text: string): ChangelogEntry[]
export function changelogSection(text: string, version: string): ChangelogEntry | null
export function releaseNotesProblem(entry: ChangelogEntry | null, version: string): string | null
