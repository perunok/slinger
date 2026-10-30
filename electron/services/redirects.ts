/**
 * Redirect handling for the HTTP executor (requests are sent with `redirect: 'manual'` and every hop is decided here),
 * following the request's Settings tab (Postman `protocolProfileBehavior`):
 *
 * - 301/302/303/307/308 with a Location (http/https) are followed while `followRedirects` is on, at most `maxRedirects` times
 *   (one more fails); any other status, a missing or unusable Location, or `followRedirects` off returns that response.
 * - 303 becomes GET without a body (HEAD stays HEAD); 301/302 do the same for any method but GET/HEAD unless
 *   `followOriginalHttpMethod`; 307/308 keep method and body.
 * - A hop to another origin drops Authorization and the auth header Slinger added (unless `followAuthorizationHeader`), and
 *   the request's own Cookie and Host headers (a cookie jar adds its cookies per hop). `removeRefererHeaderOnRedirect` drops a
 *   Referer the request set; Slinger never adds one.
 */
import type { HttpRequestInput } from '../../shared/types'

export const DEFAULT_MAX_REDIRECTS = 10
export const MAX_MAX_REDIRECTS = 1000
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

export interface RedirectPolicy {
  followRedirects: boolean
  maxRedirects: number
  followOriginalHttpMethod: boolean
  followAuthorizationHeader: boolean
  removeRefererHeaderOnRedirect: boolean
}

/** The request's redirect settings with defaults filled in. */
export function redirectPolicy(input: Partial<HttpRequestInput>): RedirectPolicy {
  const max = input.maxRedirects
  return {
    followRedirects: input.followRedirects ?? true,
    maxRedirects: typeof max === 'number' && Number.isFinite(max) ? Math.min(Math.max(Math.trunc(max), 0), MAX_MAX_REDIRECTS) : DEFAULT_MAX_REDIRECTS,
    followOriginalHttpMethod: input.followOriginalHttpMethod ?? false,
    followAuthorizationHeader: input.followAuthorizationHeader ?? false,
    removeRefererHeaderOnRedirect: input.removeRefererHeaderOnRedirect ?? false,
  }
}

export type RedirectPlan =
  | { kind: 'final' }
  | { kind: 'tooMany'; max: number }
  | { kind: 'follow'; url: URL; method: string; keepBody: boolean; crossOrigin: boolean }

/**
 * What to do with a response of `status` (Location `location`) to `current`, after `followed` redirects so far.
 */
export function planRedirect(
  current: { url: URL; method: string },
  status: number,
  location: string | null,
  policy: RedirectPolicy,
  followed: number,
): RedirectPlan {
  if (!policy.followRedirects || !REDIRECT_STATUSES.has(status) || !location) return { kind: 'final' }
  let next: URL
  try {
    next = new URL(location, current.url)
  } catch {
    return { kind: 'final' }
  }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') return { kind: 'final' }
  if (followed >= policy.maxRedirects) return { kind: 'tooMany', max: policy.maxRedirects }
  const method = current.method
  const toGet =
    status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD' && !policy.followOriginalHttpMethod
  return {
    kind: 'follow',
    url: next,
    method: toGet ? 'GET' : method,
    keepBody: !toGet && status !== 303,
    crossOrigin: next.origin !== current.url.origin,
  }
}

const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']

/**
 * The headers of the next hop. `authHeaders`: the header names the executor's auth set (Authorization, an API key header).
 */
export function redirectHeaders(
  headers: Headers,
  plan: Extract<RedirectPlan, { kind: 'follow' }>,
  policy: RedirectPolicy,
  authHeaders: readonly string[],
): Headers {
  const out = new Headers(headers)
  if (!plan.keepBody) for (const h of BODY_HEADERS) out.delete(h)
  if (plan.crossOrigin) {
    out.delete('cookie')
    out.delete('host')
    if (!policy.followAuthorizationHeader) {
      out.delete('authorization')
      for (const name of authHeaders) out.delete(name)
    }
  }
  if (policy.removeRefererHeaderOnRedirect) out.delete('referer')
  return out
}

/** The Cookie header of one hop: the request's own cookies win per name over the jar's (shared/cookies.ts). */
export { mergeCookieHeader } from '../../shared/cookies'
