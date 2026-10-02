import { describe, expect, it } from 'vitest'
import { CHECK_INTERVAL_MS, DEFAULT_UPDATE_PREFS, isCheckDue, isNewer, loadUpdatePrefs, shouldNotify, type UpdatePrefs } from './updates'

const rel = (version: string) => ({ version, url: `https://github.com/perunok/slinger/releases/tag/v${version}`, publishedAt: 1 })
const prefs = (p: Partial<UpdatePrefs> = {}): UpdatePrefs => ({ ...DEFAULT_UPDATE_PREFS, ...p })

describe('loadUpdatePrefs', () => {
  it('defaults to automatic checks, never checked', () => {
    expect(loadUpdatePrefs(null)).toEqual({ auto: true, lastCheckedAt: null, latest: null, notified: null })
    for (const junk of ['{', '[]', '42', 'null', '"x"']) expect(loadUpdatePrefs(junk), junk).toEqual(DEFAULT_UPDATE_PREFS)
  })

  it('round-trips valid fields and drops invalid ones one by one', () => {
    const stored = { auto: false, lastCheckedAt: 1_790_000_000, latest: rel('0.10.0'), notified: '0.10.0' }
    expect(loadUpdatePrefs(JSON.stringify(stored))).toEqual(stored)
    expect(
      loadUpdatePrefs(
        JSON.stringify({
          auto: 'no',
          lastCheckedAt: 'yesterday',
          // Only github.com release pages of this project, only stable versions.
          latest: { version: '0.10.0', url: 'https://evil.example/', publishedAt: 1 },
          notified: '1.0.0-rc.1',
        }),
      ),
    ).toEqual(DEFAULT_UPDATE_PREFS)
    expect(loadUpdatePrefs(JSON.stringify({ latest: { ...rel('0.10.0'), publishedAt: 'soon' } })).latest).toEqual({ ...rel('0.10.0'), publishedAt: null })
  })
})

describe('isCheckDue', () => {
  const now = 1_790_000_000_000
  it('is due when never checked or a day has passed; never when off', () => {
    expect(isCheckDue(prefs(), now)).toBe(true)
    expect(isCheckDue(prefs({ lastCheckedAt: now / 1000 - 60 }), now)).toBe(false)
    expect(isCheckDue(prefs({ lastCheckedAt: (now - CHECK_INTERVAL_MS) / 1000 }), now)).toBe(true)
    expect(isCheckDue(prefs({ auto: false }), now)).toBe(false)
  })

  it('re-checks when the clock went backwards (last check "in the future")', () => {
    expect(isCheckDue(prefs({ lastCheckedAt: now / 1000 + 3600 }), now)).toBe(true)
  })
})

describe('isNewer / shouldNotify', () => {
  it('compares semantic versions', () => {
    expect(isNewer(rel('0.10.0'), '0.9.0')).toBe(true)
    expect(isNewer(rel('0.9.0'), '0.9.0')).toBe(false)
    expect(isNewer(rel('0.9.0'), '0.10.0')).toBe(false)
    expect(isNewer(null, '0.9.0')).toBe(false)
    expect(isNewer(rel('1.0.0'), null)).toBe(false)
    expect(isNewer(rel('1.0.0'), 'dev')).toBe(false)
  })

  it('notifies once per version, and again for a later one', () => {
    expect(shouldNotify(prefs(), rel('0.10.0'), '0.9.0')).toBe(true)
    expect(shouldNotify(prefs({ notified: '0.10.0' }), rel('0.10.0'), '0.9.0')).toBe(false)
    expect(shouldNotify(prefs({ notified: '0.10.0' }), rel('0.11.0'), '0.9.0')).toBe(true)
    expect(shouldNotify(prefs(), rel('0.9.0'), '0.9.0')).toBe(false)
  })
})
