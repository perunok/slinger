/**
 * "Is there a newer Slinger?" One GET to GitHub's latest-release endpoint (drafts and pre-releases are never returned
 * there). Nothing is downloaded or installed: the renderer only shows a notice linking to the release page.
 *
 * The response is untrusted: only `tag_name` (must be a semantic version), `published_at` and `body` (the release notes,
 * Markdown, capped at MAX_NOTES_CHARS) are read, and the link is built from the version, so a tampered answer can at most
 * name a wrong version or show wrong notes. The renderer shows the notes through its sanitising Markdown renderer
 * (DOMPurify allowlist, no remote images, links open in the system browser). Pure Node (fetch injected).
 */
import type { UpdateCheckResult } from '../../shared/types'
import { invalidInput, ioError, networkError } from '../lib/errors'
import { readLimitedBody } from '../lib/limitedBody'
import { compare, parse } from './semver'

export const RELEASES_REPO = 'perunok/slinger'
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`
export const releasePageUrl = (version: string) => `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`

/** Larger answers are refused (a release JSON is a few KB, mostly the notes). */
const MAX_BYTES = 1024 * 1024
const TIMEOUT_MS = 15_000
/** Release notes longer than this are cut at a line break (the curated notes of one version are a few KB). */
export const MAX_NOTES_CHARS = 20_000

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
  const read = await readLimitedBody(res, MAX_BYTES)
  if (!read.ok) throw ioError('The release information from GitHub is too large')
  const text = read.bytes.toString('utf8')
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
    latest: { version: release.version, url: releasePageUrl(release.version), publishedAt: release.publishedAt, notes: release.notes },
    updateAvailable: current !== null && compare(release.version, current) > 0,
    checkedAt,
  }
}

/** `tag_name` "v1.2.3" or "1.2.3" (a strict semantic version), plus an optional ISO `published_at` and Markdown `body`. */
export function parseRelease(body: unknown): { version: string; publishedAt: number | null; notes: string | null } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const o = body as Record<string, unknown>
  if (o.draft === true || o.prerelease === true) return null
  if (typeof o.tag_name !== 'string') return null
  const version = o.tag_name.trim().replace(/^v/, '')
  const parsed = parse(version)
  if (!parsed || parsed.prerelease.length > 0) return null
  const ms = typeof o.published_at === 'string' ? Date.parse(o.published_at) : NaN
  return { version, publishedAt: Number.isFinite(ms) ? Math.floor(ms / 1000) : null, notes: releaseNotesText(o.body) }
}

/** The release `body` as notes: line endings normalised, trimmed, cut at a line break past MAX_NOTES_CHARS; null when empty. */
export function releaseNotesText(body: unknown, max = MAX_NOTES_CHARS): string | null {
  if (typeof body !== 'string') return null
  // NUL and other C0 controls except tab/newline have no place in Markdown notes.
  // eslint-disable-next-line no-control-regex
  let text = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (!text) return null
  if (text.length > max) {
    const cut = text.lastIndexOf('\n', max)
    text = `${text.slice(0, cut > max / 2 ? cut : max).trimEnd()}\n\n…`
  }
  return text
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
