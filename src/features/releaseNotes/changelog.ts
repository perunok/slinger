/**
 * CHANGELOG.md, bundled at build time (works offline). Imported only by the lazily loaded Release notes dialog and the
 * What's new check after a version change, so it never weighs on startup.
 */
import text from '../../../CHANGELOG.md?raw'
import { parseChangelog, type ChangelogEntry } from '../../../shared/changelog.mjs'

export const CHANGELOG: readonly ChangelogEntry[] = parseChangelog(text)
