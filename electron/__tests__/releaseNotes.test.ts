import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { changelogSection, parseChangelog, releaseNotesProblem, UNRELEASED_PLACEHOLDER } from '../../shared/changelog.mjs'
import { releaseNotes } from '../../scripts/release-notes.mjs'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/release-notes.mjs')
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

const SAMPLE = `# Release notes

Intro text that is not a version.

## 1.2.0 — unreleased

- ${UNRELEASED_PLACEHOLDER}

## 1.1.0 — 2026-10-26

### New
- Thing one.

\`\`\`text
## 9.9.9 — not a heading inside a code block
\`\`\`

## v1.0.1 – 2026-10-20

### Fixed
- Thing two.

## 1.0.0 - 2026-10-01
## Unrelated heading
ignored
`

describe('parseChangelog', () => {
  it('reads every version section in file order, with its date (null while unreleased) and trimmed body', () => {
    const entries = parseChangelog(SAMPLE)
    expect(entries.map((e) => [e.version, e.date])).toEqual([
      ['1.2.0', null],
      ['1.1.0', '2026-10-26'],
      ['1.0.1', '2026-10-20'],
      ['1.0.0', '2026-10-01'],
    ])
    expect(entries[1]!.body).toBe('### New\n- Thing one.\n\n```text\n## 9.9.9 — not a heading inside a code block\n```')
    expect(entries[2]!.body).toBe('### Fixed\n- Thing two.')
    // An empty section, ended by a heading that is not a version.
    expect(entries[3]!.body).toBe('')
  })

  it('handles CRLF line endings', () => {
    expect(parseChangelog('## 1.0.0 — 2026-01-01\r\n\r\n- A\r\n').map((e) => e.body)).toEqual(['- A'])
  })

  it('finds one section, with or without the "v"', () => {
    expect(changelogSection(SAMPLE, 'v1.0.1')?.body).toBe('### Fixed\n- Thing two.')
    expect(changelogSection(SAMPLE, '3.0.0')).toBeNull()
  })

  it('says why a section cannot be published', () => {
    expect(releaseNotesProblem(changelogSection(SAMPLE, '1.1.0'), '1.1.0')).toBeNull()
    expect(releaseNotesProblem(changelogSection(SAMPLE, '3.0.0'), '3.0.0')).toMatch(/no "## 3.0.0/)
    expect(releaseNotesProblem(changelogSection(SAMPLE, '1.2.0'), '1.2.0')).toMatch(/unreleased/)
    expect(releaseNotesProblem(changelogSection(SAMPLE, '1.0.0'), '1.0.0')).toMatch(/empty/)
    expect(releaseNotesProblem({ version: '1.2.0', date: '2026-11-01', body: `- ${UNRELEASED_PLACEHOLDER}` }, '1.2.0')).toMatch(/still says/)
  })
})

describe('the repository CHANGELOG.md', () => {
  const text = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  const entries = parseChangelog(text)

  it('lists versions newest first, each once, every released one dated and filled in', () => {
    const versions = entries.map((e) => e.version)
    expect(new Set(versions).size).toBe(versions.length)
    const sorted = [...versions].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    expect(versions).toEqual(sorted)
    for (const e of entries.filter((x) => x.date)) {
      expect(e.date, e.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(releaseNotesProblem(e, e.version), e.version).toBeNull()
    }
  })

  it('has notes for the version in package.json', () => {
    expect(changelogSection(text, PACKAGE_VERSION), PACKAGE_VERSION).not.toBeNull()
  })
})

describe('scripts/release-notes.mjs', () => {
  it('returns the section body for the release', () => {
    expect(releaseNotes(SAMPLE, 'v1.1.0')).toBe(`${changelogSection(SAMPLE, '1.1.0')!.body}\n`)
    expect(() => releaseNotes(SAMPLE, '1.2.0')).toThrow(/unreleased/)
  })

  it('prints the section, writes it with --out, and fails with the reason', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slinger-notes-'))
    const file = join(dir, 'CHANGELOG.md')
    writeFileSync(file, SAMPLE)
    expect(execFileSync(process.execPath, [SCRIPT, 'v1.0.1', '--file', file], { encoding: 'utf8' })).toBe('### Fixed\n- Thing two.\n')
    const out = join(dir, 'notes.md')
    execFileSync(process.execPath, [SCRIPT, '1.1.0', '--file', file, '--out', out])
    expect(readFileSync(out, 'utf8')).toMatch(/^### New\n- Thing one\./)
    for (const v of ['1.2.0', '3.0.0']) {
      const r = spawnSync(process.execPath, [SCRIPT, v, '--file', file], { encoding: 'utf8' })
      expect(r.status, v).toBe(1)
      expect(r.stderr, v).toMatch(/^release-notes: /)
      expect(r.stdout, v).toBe('')
    }
    expect(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).stderr).toMatch(/usage/)
  })
})
