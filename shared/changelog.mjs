/**
 * CHANGELOG.md (the curated, user-facing release notes at the repo root) as data. Plain JavaScript so the release
 * script (scripts/release-notes.mjs, run by Node in the release workflow) and the renderer (Help > Release Notes,
 * What's new) share one parser. Types: changelog.d.mts.
 *
 * Format: one `## X.Y.Z — YYYY-MM-DD` heading per version, newest first (`— unreleased` while it is being written),
 * then Markdown (`### New` / `### Improved` / `### Fixed` with short bullets) up to the next `## ` heading. Anything
 * before the first version heading (the title, an intro) is ignored.
 */

/** `## 0.26.0 — 2026-10-26` (em dash, en dash or hyphen; an optional "v"). */
const HEADING = /^##[ \t]+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[ \t]*(?:[—–-][ \t]*(.*?))?[ \t]*$/
/** The text integration replaces before a release; a section still holding it is not ready. */
export const UNRELEASED_PLACEHOLDER = '(filled in at release)'

/**
 * Every version section in file order. `date` is the heading's text after the dash, or null when it is missing or
 * "unreleased"; `body` is the Markdown under the heading, trimmed.
 * @param {string} text
 */
export function parseChangelog(text) {
  const entries = []
  let current = null
  let fence = false
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    // A "## " inside a fenced code block is not a heading.
    if (/^(```|~~~)/.test(line)) fence = !fence
    const m = fence ? null : HEADING.exec(line)
    if (m) {
      if (current) entries.push(current)
      const date = (m[2] ?? '').trim()
      current = { version: m[1], date: date && date.toLowerCase() !== 'unreleased' ? date : null, lines: [] }
    } else if (!fence && /^##[ \t]/.test(line)) {
      // Any other second-level heading ends the section without starting one.
      if (current) entries.push(current)
      current = null
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) entries.push(current)
  return entries.map(({ version, date, lines }) => ({ version, date, body: lines.join('\n').trim() }))
}

/**
 * The section of `version` ("1.2.3" or "v1.2.3"), or null.
 * @param {string} text
 * @param {string} version
 */
export function changelogSection(text, version) {
  const v = String(version).trim().replace(/^v/, '')
  return parseChangelog(text).find((e) => e.version === v) ?? null
}

/**
 * Why `entry` cannot be published as release notes, or null when it can: missing, undated ("unreleased"), empty or
 * still the placeholder.
 * @param {{ version: string, date: string | null, body: string } | null} entry
 * @param {string} version
 */
export function releaseNotesProblem(entry, version) {
  if (!entry) return `CHANGELOG.md has no "## ${version} — <date>" section`
  if (!entry.date) return `the ${version} section of CHANGELOG.md has no release date (it says "unreleased")`
  if (!entry.body) return `the ${version} section of CHANGELOG.md is empty`
  if (entry.body.includes(UNRELEASED_PLACEHOLDER)) return `the ${version} section of CHANGELOG.md still says "${UNRELEASED_PLACEHOLDER}"`
  return null
}
