/**
 * The request Settings tab's Postman `protocolProfileBehavior` keys (draft.protocolProfileBehavior), their defaults, and
 * what of them goes into the executor input. A key at its default is removed rather than stored, so a request only
 * carries what differs (and an imported request exports exactly what it came with, unless the user changed it).
 */
import type { HttpRequestInput } from '../../shared/types'
import type { RequestDraft } from './request'

/** Postman's defaults. `strictSSL` has none of its own: absent = Settings > Network > SSL certificate verification. */
export const REQUEST_SETTING_DEFAULTS = {
  followRedirects: true,
  followOriginalHttpMethod: false,
  followAuthorizationHeader: false,
  removeRefererHeaderOnRedirect: false,
} as const

export type BoolRequestSetting = keyof typeof REQUEST_SETTING_DEFAULTS

export const DEFAULT_MAX_REDIRECTS = 10
export const MAX_MAX_REDIRECTS = 1000

type Behavior = RequestDraft['protocolProfileBehavior']

export function boolSetting(ppb: Behavior, key: BoolRequestSetting): boolean {
  const v = ppb[key]
  return typeof v === 'boolean' ? v : REQUEST_SETTING_DEFAULTS[key]
}

export function setBoolSetting(draft: RequestDraft, key: BoolRequestSetting, value: boolean): void {
  const next = { ...draft.protocolProfileBehavior }
  if (value === REQUEST_SETTING_DEFAULTS[key]) delete next[key]
  else next[key] = value
  draft.protocolProfileBehavior = next
}

/** 'default' = the app setting. */
export type StrictSslChoice = 'default' | 'on' | 'off'

export function strictSslChoice(ppb: Behavior): StrictSslChoice {
  return ppb.strictSSL === true ? 'on' : ppb.strictSSL === false ? 'off' : 'default'
}

export function setStrictSsl(draft: RequestDraft, choice: StrictSslChoice): void {
  const next = { ...draft.protocolProfileBehavior }
  if (choice === 'default') delete next.strictSSL
  else next.strictSSL = choice === 'on'
  draft.protocolProfileBehavior = next
}

/** The stored maximum, or null when not set (the default applies). */
export function maxRedirectsSetting(ppb: Behavior): number | null {
  const v = ppb.maxRedirects
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null
}

/** Empty, invalid or the default value removes the key. */
export function setMaxRedirects(draft: RequestDraft, text: string): void {
  const next = { ...draft.protocolProfileBehavior }
  const n = Number(text)
  if (text.trim() === '' || !Number.isFinite(n) || n < 0 || Math.trunc(n) === DEFAULT_MAX_REDIRECTS) delete next.maxRedirects
  else next.maxRedirects = Math.min(Math.trunc(n), MAX_MAX_REDIRECTS)
  draft.protocolProfileBehavior = next
}

/** The executor input fields for these settings (only the ones set and valid; main fills the defaults). */
export function protocolInput(ppb: Behavior): Partial<HttpRequestInput> {
  const out: Partial<HttpRequestInput> = {}
  if (typeof ppb.strictSSL === 'boolean') out.strictSSL = ppb.strictSSL
  for (const key of Object.keys(REQUEST_SETTING_DEFAULTS) as BoolRequestSetting[]) {
    if (typeof ppb[key] === 'boolean') out[key] = ppb[key] as boolean
  }
  const max = maxRedirectsSetting(ppb)
  if (max !== null) out.maxRedirects = Math.min(max, MAX_MAX_REDIRECTS)
  return out
}
