/**
 * How much of a response body Slinger loads into memory (Settings > Requests > Maximum response size). Larger bodies are
 * not loaded: the response shows its status and headers and offers "Send and download to file", which streams the body
 * straight to a file in the main process. Shared by main (enforcement) and the renderer (the setting).
 *
 * The upper bound is what a response can safely take on its way to the screen: a binary body travels as base64 (+33%)
 * in one JavaScript string, and V8 strings stop at about 512 M characters.
 */
export const MB = 1024 * 1024
export const DEFAULT_MAX_RESPONSE_MB = 50
export const MIN_MAX_RESPONSE_MB = 1
export const MAX_MAX_RESPONSE_MB = 256

/** A whole number of MB within the allowed range (anything unusable: the default). */
export function clampMaxResponseMb(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n)
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX_RESPONSE_MB
  return Math.min(MAX_MAX_RESPONSE_MB, Math.max(MIN_MAX_RESPONSE_MB, Math.round(v)))
}

/** Bytes for a caller-supplied limit (HttpRequestInput.maxResponseBytes), clamped to the allowed range; absent: the default. */
export function clampMaxResponseBytes(n: number | null | undefined): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return DEFAULT_MAX_RESPONSE_MB * MB
  return Math.min(MAX_MAX_RESPONSE_MB * MB, Math.max(MIN_MAX_RESPONSE_MB * MB, Math.floor(n)))
}

/** "50 MB" (whole MB when it is one, else one decimal). */
export function formatLimit(bytes: number): string {
  const mb = bytes / MB
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}
