import { cpSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Unpackaged dev builds used to name the profile "slinger" (package.json `name`), packaged builds
 * "Slinger" (productName). package.json now sets productName so both use "Slinger". This moves an
 * existing lowercase dev profile over, once: only when the new location has no database yet and
 * the old one does. Never overwrites anything. Returns what happened (for logging and tests).
 */
export function migrateLegacyDataDir(legacyDir: string, targetDir: string): 'none' | 'moved' | 'copied' {
  try {
    if (legacyDir === targetDir || !existsSync(join(legacyDir, 'slinger.db'))) return 'none'
    // Case-insensitive filesystems (macOS, Windows): both names are the same directory.
    if (existsSync(targetDir) && statSync(legacyDir).ino !== 0 && statSync(legacyDir).ino === statSync(targetDir).ino) return 'none'
    if (existsSync(join(targetDir, 'slinger.db'))) return 'none'
    if (!existsSync(targetDir)) {
      renameSync(legacyDir, targetDir)
      return 'moved'
    }
    cpSync(legacyDir, targetDir, { recursive: true, force: false, errorOnExist: false })
    return 'copied'
  } catch (err) {
    console.warn('[slinger] could not migrate the legacy data directory:', err instanceof Error ? err.message : err)
    return 'none'
  }
}
