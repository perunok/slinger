import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { invalidInput } from '../lib/errors'

/** Resolves a renderer-supplied path to the real path it was granted under, or throws invalid_input. */
export interface FileAccess {
  resolve(path: string | undefined, label: string): Promise<string>
}

/**
 * In-memory allowlist of local files the user actually chose in a native dialog (`pickFile`).
 * The renderer is untrusted: request bodies may only reference granted files. Grants are keyed by
 * real path (symlinks resolved) both when granted and when checked, so `..` traversal, a symlink
 * that points at a different file, or a granted file swapped for a symlink after the fact never
 * match. Grants live only in memory and vanish on app restart.
 */
export class FileGrants implements FileAccess {
  private readonly granted = new Set<string>()

  /** Called by the main process right after a dialog returned `path`. Returns the real path. */
  async grant(path: string): Promise<string> {
    if (!isAbsolute(path)) throw invalidInput('file path must be absolute')
    const real = await realpath(path)
    if (!(await stat(real)).isFile()) throw invalidInput('not a regular file')
    this.granted.add(real)
    return real
  }

  async resolve(path: string | undefined, label: string): Promise<string> {
    const denied = () =>
      invalidInput(`${label}: file not granted. Choose the file again with the file picker`, { reason: 'file_not_granted', path })
    if (!path || !isAbsolute(path)) throw invalidInput(`${label} must be an absolute file path`)
    let real: string
    try {
      real = await realpath(path)
    } catch {
      throw denied() // missing files look the same as ungranted ones: no probing of the filesystem
    }
    if (!this.granted.has(real)) throw denied()
    return real
  }

  /** The subset of `paths` that are currently granted (used by the renderer to flag stale saved paths). */
  async filterGranted(paths: string[]): Promise<string[]> {
    const out: string[] = []
    for (const p of paths) {
      try {
        await this.resolve(p, 'file')
        out.push(p)
      } catch {
        /* not granted */
      }
    }
    return out
  }
}
