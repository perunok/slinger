import { describe, expect, it } from 'vitest'
import type { ChangelogEntry } from '../../shared/changelog.mjs'
import { decideWhatsNew, entriesSince, entriesToMarkdown, loadSeenVersion, releasedEntries } from './releaseNotes'

const e = (version: string, date: string | null = '2026-10-01', body = `- ${version}`): ChangelogEntry => ({ version, date, body })
const LOG = [e('0.27.0', null), e('0.26.0'), e('0.25.1'), e('0.25.0'), e('0.10.0'), e('0.9.0')]
const versions = (list: ChangelogEntry[]) => list.map((x) => x.version)

describe('which versions to show', () => {
  it('Release notes: every released version, never an unreleased one', () => {
    expect(versions(releasedEntries(LOG))).toEqual(['0.26.0', '0.25.1', '0.25.0', '0.10.0', '0.9.0'])
  })

  it('What’s new: the versions after the last seen one up to the running one (semantic order)', () => {
    expect(versions(entriesSince(LOG, '0.25.0', '0.26.0'))).toEqual(['0.26.0', '0.25.1'])
    expect(versions(entriesSince(LOG, '0.9.0', '0.10.0'))).toEqual(['0.10.0'])
    // Never past the running version, and never the unreleased one.
    expect(versions(entriesSince(LOG, '0.25.1', '0.25.1'))).toEqual([])
    expect(versions(entriesSince(LOG, '0.26.0', '0.27.0'))).toEqual([])
    // No last seen version: the running one alone.
    expect(versions(entriesSince(LOG, null, '0.25.1'))).toEqual(['0.25.1'])
  })

  it('renders one Markdown document with a heading per version', () => {
    expect(entriesToMarkdown([e('0.26.0', '2026-10-26', '### Fixed\n- A'), e('0.25.1', null, '')])).toBe(
      '## 0.26.0 · 2026-10-26\n\n### Fixed\n- A\n\n## 0.25.1\n\n_No notes._',
    )
  })
})

describe('loadSeenVersion', () => {
  it('reads a stored stable version; anything else is null', () => {
    expect(loadSeenVersion(JSON.stringify({ seen: '0.26.0' }))).toBe('0.26.0')
    for (const raw of [null, '', '{', '[]', '"0.26.0"', JSON.stringify({ seen: '0.27.0-dev' }), JSON.stringify({ seen: 42 })]) expect(loadSeenVersion(raw), String(raw)).toBeNull()
  })
})

describe('decideWhatsNew', () => {
  it('shows on the first start of a newer version, with the versions since the last seen one', () => {
    expect(decideWhatsNew('0.25.0', '0.26.0', true)).toEqual({ show: true, after: '0.25.0', record: true })
    expect(decideWhatsNew('0.9.0', '0.10.0', true)).toEqual({ show: true, after: '0.9.0', record: true })
  })

  it('says nothing on later starts of the same version', () => {
    expect(decideWhatsNew('0.26.0', '0.26.0', true)).toEqual({ show: false, after: null, record: false })
  })

  it('a fresh install records the version silently', () => {
    expect(decideWhatsNew(null, '0.26.0', false)).toEqual({ show: false, after: null, record: true })
  })

  it('an update from a version before What’s new existed shows the running version’s notes', () => {
    expect(decideWhatsNew(null, '0.27.0', true)).toEqual({ show: true, after: null, record: true })
  })

  it('a downgrade records quietly; development builds are left alone', () => {
    expect(decideWhatsNew('0.27.0', '0.26.0', true)).toEqual({ show: false, after: null, record: true })
    expect(decideWhatsNew('0.26.0', '0.0.0-dev', true)).toEqual({ show: false, after: null, record: false })
    expect(decideWhatsNew(null, null, true)).toEqual({ show: false, after: null, record: false })
  })
})
