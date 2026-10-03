/**
 * "Is there a newer Slinger?" One GET to GitHub's latest-release endpoint (drafts and pre-releases are never returned
 * there). Nothing is downloaded or installed: the renderer only shows a notice linking to the release page.
 *
 * The response is untrusted: only `tag_name` (must be a semantic version) and `published_at` are read, and the link is
 * built from the version, so a tampered answer can at most name a wrong version. Pure Node (fetch injected).
 */
import type { UpdateCheckResult } from '../../shared/types'
import { invalidInput, ioError, networkError } from '../lib/errors'
import { compare, parse } from './semver'

export const RELEASES_REPO = 'perunok/slinger'
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`
export const releasePageUrl = (version: string) => `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`

/** Larger answers are refused (a release JSON is a few KB, mostly the notes). */
const MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 15_000

export interface UpdateCheckOptions {
  currentVersion: string
  fetchImpl: typeof fetch
  /** Defaults to GitHub; tests and e2e point it at a local server (SLINGER_UPDATE_FEED_URL). */
  feedUrl?: string
  now?: () => number
  timeoutMs?: number
}

export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateCheckResult> {
  const { currentVersion, fetchImpl, feedUrl = LATEST_RELEASE_API, now = Date.now, timeoutMs = TIMEOUT_MS } = options
  let res: Response
  try {
    res = await fetchImpl(feedUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Slinger/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    throw networkError(timedOut ? 'GitHub did not answer in time' : 'Could not reach GitHub to check for updates', { timedOut })
  }
  const checkedAt = Math.floor(now() / 1000)
  // No release published yet.
  if (res.status === 404) return { currentVersion, latest: null, updateAvailable: false, checkedAt }
  if (!res.ok) {
    // 403/429: GitHub's rate limit for unauthenticated calls (60 an hour per address).
    throw networkError(`GitHub answered HTTP ${res.status}`, { status: res.status })
  }
  const text = await res.text()
  if (text.length > MAX_BYTES) throw ioError('The release information from GitHub is too large')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw ioError('GitHub sent release information that is not JSON')
  }
  const release = parseRelease(body)
  if (!release) throw ioError('GitHub sent release information Slinger does not understand')
  const current = parse(currentVersion)
  return {
    currentVersion,
    latest: { version: release.version, url: releasePageUrl(release.version), publishedAt: release.publishedAt },
    updateAvailable: current !== null && compare(release.version, current) > 0,
    checkedAt,
  }
}

/** `tag_name` "v1.2.3" or "1.2.3" (a strict semantic version), plus an optional ISO `published_at`. */
export function parseRelease(body: unknown): { version: string; publishedAt: number | null } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const o = body as Record<string, unknown>
  if (o.draft === true || o.prerelease === true) return null
  if (typeof o.tag_name !== 'string') return null
  const version = o.tag_name.trim().replace(/^v/, '')
  const parsed = parse(version)
  if (!parsed || parsed.prerelease.length > 0) return null
  const ms = typeof o.published_at === 'string' ? Date.parse(o.published_at) : NaN
  return { version, publishedAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : null }
}

/**
 * Where to look: `SLINGER_UPDATE_FEED_URL` (http/https) if set; otherwise GitHub, except in automated runs (smoke test,
 * e2e, hidden window), which never call out to the internet on their own: null there means "checks are off".
 */
export function updateFeedUrl(env: NodeJS.ProcessEnv): string | null {
  const override = env.SLINGER_UPDATE_FEED_URL?.trim()
  if (override) {
    if (!/^https?:\/\//i.test(override)) throw invalidInput('SLINGER_UPDATE_FEED_URL must be an http(s) URL')
    return override
  }
  if (env.SLINGER_SMOKE_TEST || env.SLINGER_HIDE_WINDOW) return null
  return LATEST_RELEASE_API
}
