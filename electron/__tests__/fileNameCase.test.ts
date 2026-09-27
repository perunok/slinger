/**
 * Windows and macOS file systems ignore case, Linux (where CI runs) does not. Two files whose import names differ only by
 * case (`RightPanel.svelte` next to `rightPanel.svelte.ts`, imported as './rightPanel.svelte') build on Linux and break the
 * Windows/macOS release builds, so the whole source tree is checked here.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const DIRS = ['src', 'shared', 'electron', 'e2e', 'scripts', 'test']
const SKIP = new Set(['node_modules', 'dist', 'dist-electron', 'release', 'test-results'])
const SCRIPT_EXT = /\.(ts|js|mjs|cjs)$/

/** Names an import can use for a file: its full name, and for scripts the name without the last extension. */
const importNames = (file: string) => (SCRIPT_EXT.test(file) ? [file, file.replace(SCRIPT_EXT, '')] : [file])

function collisions(dir: string, out: string[][]) {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const byLower = new Map<string, Set<string>>()
  for (const name of entries) {
    if (SKIP.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      collisions(full, out)
      continue
    }
    for (const n of importNames(name)) {
      const set = byLower.get(n.toLowerCase()) ?? new Set<string>()
      set.add(name)
      byLower.set(n.toLowerCase(), set)
    }
  }
  for (const files of byLower.values()) if (files.size > 1) out.push([...files].map((f) => relative(ROOT, join(dir, f))).sort())
}

describe('file names', () => {
  it('no two files in a folder are the same import name ignoring case (breaks Windows/macOS builds)', () => {
    const found: string[][] = []
    for (const d of DIRS) collisions(join(ROOT, d), found)
    expect(found).toEqual([])
  })
})
