/**
 * Export file names that keep the real collection / environment name (spaces, case, Amharic, emoji...) and
 * only change what no desktop OS accepts in a file name:
 *
 * - `/ \ : * ? " < > |`, control characters and bidi controls become "_" (tabs/newlines become a space);
 * - leading dots/spaces and trailing dots/spaces are trimmed (hidden files, Windows strips them);
 * - Windows device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9, also before a dot) get a "_" appended;
 * - the name is cut to 150 characters on a grapheme boundary, and the whole file name to 240 UTF-8 bytes
 *   (ext4 allows 255 bytes; Amharic letters take 3 bytes each).
 *
 * Examples: `enat uat v1.2.0.slinger_collection.json`, `Prod.slinger_environment.json`.
 */

export const COLLECTION_EXPORT_EXT = '.slinger_collection.json'
export const ENVIRONMENT_EXPORT_EXT = '.slinger_environment.json'

/** `accept` for import file pickers: Slinger and Postman exports, and any other .json. */
export const IMPORT_FILE_ACCEPT = [
  COLLECTION_EXPORT_EXT,
  ENVIRONMENT_EXPORT_EXT,
  '.postman_collection.json',
  '.postman_environment.json',
  '.json',
  'application/json',
].join(',')

export const MAX_STEM_CHARS = 150
export const MAX_FILE_NAME_BYTES = 240

// eslint-disable-next-line no-control-regex
const INVALID = /[/\\:*?"<>|\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length

/** User-perceived characters (so an emoji or a letter with its combining marks is never split); code points as a fallback. */
function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } })
    .Segmenter
  if (Seg) return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s), (x) => x.segment)
  return Array.from(s)
}

const trimEnds = (s: string) => s.replace(/^[\s.]+/u, '').replace(/[\s.]+$/u, '')

/** A safe file-name stem (no extension) for `name`; `fallback` when nothing usable is left. */
export function sanitizeFileStem(name: string, fallback: string): string {
  let stem = trimEnds(
    String(name ?? '')
      .normalize('NFC')
      .replace(/[\t\n\r]+/g, ' ')
      .replace(INVALID, '_'),
  )
  const chars = graphemes(stem)
  if (chars.length > MAX_STEM_CHARS) stem = trimEnds(chars.slice(0, MAX_STEM_CHARS).join(''))
  if (!stem) return fallback
  // Windows treats "NUL", "nul.txt" and "NUL .json" alike: guard the part before the first dot.
  const first = stem.split('.')[0]!.trimEnd()
  if (WINDOWS_RESERVED.test(first)) stem = `${first}_${stem.slice(first.length)}`
  return stem
}

/** Joins stem + suffix, dropping trailing characters of the stem until the name fits MAX_FILE_NAME_BYTES. */
function fit(stem: string, suffix: string): string {
  if (utf8Bytes(stem + suffix) <= MAX_FILE_NAME_BYTES) return stem + suffix
  const chars = graphemes(stem)
  while (chars.length > 1 && utf8Bytes(chars.join('') + suffix) > MAX_FILE_NAME_BYTES) chars.pop()
  return trimEnds(chars.join('')) + suffix
}

/** `<collection name> v<latest version>.slinger_collection.json`, or without the version when there is none. */
export function collectionExportFileName(name: string, latestVersion: string | null | undefined): string {
  // Semver labels only contain [0-9A-Za-z.-], but sanitise anyway: the label may come from a synced device.
  const version = latestVersion ? sanitizeFileStem(latestVersion, '') : ''
  return fit(sanitizeFileStem(name, 'collection'), `${version ? ` v${version}` : ''}${COLLECTION_EXPORT_EXT}`)
}

/** `<environment name>.slinger_environment.json`. */
export function environmentExportFileName(name: string): string {
  return fit(sanitizeFileStem(name, 'environment'), ENVIRONMENT_EXPORT_EXT)
}
