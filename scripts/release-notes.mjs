#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section of one version: the GitHub release body (release.yml passes it as `body_path`), which
 * the in-app update notice then shows. Fails when the section is missing, undated ("unreleased"), empty or still the
 * placeholder, so a release never goes out with the auto-generated "What's Changed" list instead.
 *
 *   node scripts/release-notes.mjs 0.27.0                 # to stdout
 *   node scripts/release-notes.mjs v0.27.0 --out notes.md # to a file
 *   node scripts/release-notes.mjs 0.27.0 --file other/CHANGELOG.md
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { changelogSection, releaseNotesProblem } from '../shared/changelog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The release notes of `version` from the changelog text; throws with the reason when they cannot be published.
 * @param {string} text
 * @param {string} version
 */
export function releaseNotes(text, version) {
  const v = String(version).trim().replace(/^v/, '')
  const entry = changelogSection(text, v)
  const problem = releaseNotesProblem(entry, v)
  if (problem) throw new Error(problem)
  return `${entry.body}\n`
}

function main(argv) {
  const args = [...argv]
  let file = resolve(ROOT, 'CHANGELOG.md')
  let out = null
  let version = null
  while (args.length) {
    const a = args.shift()
    if (a === '--file') file = resolve(args.shift() ?? '')
    else if (a === '--out') out = resolve(args.shift() ?? '')
    else if (!version) version = a
    else throw new Error(`unexpected argument "${a}"`)
  }
  if (!version) throw new Error('usage: node scripts/release-notes.mjs <version> [--file CHANGELOG.md] [--out notes.md]')
  const notes = releaseNotes(readFileSync(file, 'utf8'), version)
  if (out) writeFileSync(out, notes)
  else process.stdout.write(notes)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    console.error(`release-notes: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
