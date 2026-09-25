import { existsSync, statSync } from 'node:fs'
import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { invalidInput, ioError } from '../lib/errors'

export const MAX_EXPORT_BYTES = 256 * 1024 * 1024
/** ext4/most Linux file systems allow 255 BYTES per name (an Amharic letter is 3 bytes); Windows/macOS 255 UTF-16 units. */
export const MAX_FILE_NAME_BYTES = 255
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i

/**
 * Cuts `name` to MAX_FILE_NAME_BYTES of UTF-8 on a code-point boundary, keeping a (compound) extension such
 * as ".slinger_collection.json" intact.
 */
function fitFileName(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= MAX_FILE_NAME_BYTES) return name
  const ext = /(\.[A-Za-z0-9_-]{1,32}){1,3}$/.exec(name)?.[0] ?? ''
  const chars = Array.from(name.slice(0, name.length - ext.length))
  while (chars.length > 0 && Buffer.byteLength(chars.join('') + ext, 'utf8') > MAX_FILE_NAME_BYTES) chars.pop()
  return chars.join('').replace(/[. ]+$/, '') + ext
}

/**
 * Reduces an arbitrary string to a safe single path segment: takes the part after the last
 * "/" or "\", drops control characters, replaces reserved characters, and rejects names that
 * are empty, dots-only or Windows device names.
 */
export function sanitizeFileName(fileName: unknown): string {
  if (typeof fileName !== 'string') throw invalidInput('export file name is required')
  // basename() alone would not split backslashes on POSIX, so split on both explicitly.
  const last = fileName.split(/[\\/]/).pop() ?? ''
  const cleaned = basename(
    last
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      // Lone surrogates cannot be encoded in a file name; bidi controls can disguise an extension.
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      .replace(/[<>:"|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
      .trim()
      .replace(/[. ]+$/, ''),
  )
  if (!cleaned || cleaned === '.' || cleaned === '..' || /^\.+$/.test(cleaned)) {
    throw invalidInput('export file name is not valid')
  }
  if (WINDOWS_RESERVED.test(cleaned)) throw invalidInput('export file name is reserved')
  const fitted = fitFileName(cleaned)
  if (!fitted || /^\.+$/.test(fitted)) throw invalidInput('export file name is not valid')
  return fitted
}

export function defaultExportDirectory(): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir()
  const downloads = join(home, 'Downloads')
  return existsSync(downloads) && statSync(downloads).isDirectory() ? downloads : home
}

/**
 * Writes export files only inside one directory (the user's chosen folder, else Downloads/home).
 * The renderer only ever supplies a file name, never a path.
 */
export class ExportFiles {
  private directory: string

  constructor(initialDirectory: string = defaultExportDirectory()) {
    this.directory = resolve(initialDirectory)
  }

  get exportDirectory(): string {
    return this.directory
  }

  setDirectory(dir: string): void {
    const resolved = resolve(dir)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) throw invalidInput('export directory does not exist')
    this.directory = resolved
  }

  pathFor(fileName: string): string {
    return join(this.directory, sanitizeFileName(fileName))
  }

  async write(fileName: string, contents: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
    if (typeof contents !== 'string') throw invalidInput('export contents must be a string')
    if (encoding !== 'utf8' && encoding !== 'base64') throw invalidInput('unsupported export encoding')
    let data: Buffer
    if (encoding === 'base64') {
      // Strict: Buffer.from(..., 'base64') silently skips junk, which would write a corrupt file.
      if (contents.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(contents)) throw invalidInput('export contents are not valid base64')
      if ((contents.length / 4) * 3 > MAX_EXPORT_BYTES + 3) throw invalidInput('export is too large')
      data = Buffer.from(contents, 'base64')
    } else {
      if (Buffer.byteLength(contents, 'utf8') > MAX_EXPORT_BYTES) throw invalidInput('export is too large')
      data = Buffer.from(contents, 'utf8')
    }
    if (data.length > MAX_EXPORT_BYTES) throw invalidInput('export is too large')
    const target = this.pathFor(fileName)
    try {
      await mkdir(this.directory, { recursive: true })
      // Never write through a symlink that could point outside the export directory.
      const existing = await lstat(target).catch(() => null)
      if (existing?.isSymbolicLink()) throw invalidInput('refusing to overwrite a symbolic link')
      if (existing?.isDirectory()) throw invalidInput('a folder with that name already exists')
      await writeFile(target, data)
    } catch (err) {
      if (err instanceof Error && err.name === 'IpcError') throw err
      throw ioError(`Could not write export file: ${err instanceof Error ? err.message : String(err)}`)
    }
    return target
  }
}
