/**
 * Main-process side of pm.sendRequest: runs a request a script asked for with the app's own HTTP engine
 * (executeHttp: same body building, auth, timeouts, redirects, response decoding) and the session's file grants
 * (form-data / file bodies may only use files the user picked in this session).
 *
 * Deliberately NOT HttpService.execute: these requests are not written to request history (Postman does not show
 * them there either). The only trace is one console line per call, with the session's secret values redacted.
 */
import { toErrorPayload } from '../lib/errors'
import { MAX_RESPONSE_BODY_CHARS, type SendRequestCall, type SendRequestOutcome } from '../scripts/job'
import type { FileAccess } from './fileGrants'
import { executeHttp, normalizeUrl } from './httpExecutor'

export interface ScriptHttpOptions {
  files?: FileAccess
  /** Replaces secret values with `{{name}}` (ScriptService.redact for the run's session). */
  redact(text: string): string
}

const USERINFO_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/?#\s@]*@/g

/** Masks `user:password@` in every URL of a text (fetch errors quote the URL). */
export const maskUserinfo = (text: string): string => text.replace(USERINFO_RE, '$1***@')

/** The URL as shown in the script console: credentials in the authority are masked, then secrets redacted. */
export function consoleUrl(url: string, redact: (text: string) => string): string {
  const shown = redact(maskUserinfo(normalizeUrl(url)))
  return shown.length > 2000 ? `${shown.slice(0, 2000)}…` : shown
}

export async function runScriptSendRequest(call: SendRequestCall, signal: AbortSignal, options: ScriptHttpOptions): Promise<SendRequestOutcome> {
  const started = performance.now()
  const shown = consoleUrl(call.url, options.redact)
  try {
    const res = await executeHttp(
      { method: call.method, url: call.url, headers: call.headers, auth: call.auth, body: call.body, timeoutMs: call.timeoutMs, workspaceId: '' },
      { signal, files: options.files },
    )
    // Binary bodies: bytes as Latin-1 characters (what a string-based sandbox can hold without loss).
    const text = res.bodyText ?? Buffer.from(res.bodyBase64 ?? '', 'base64').toString('latin1')
    const truncated = text.length > MAX_RESPONSE_BODY_CHARS
    return {
      ok: true,
      response: {
        code: res.status,
        status: res.statusText,
        headers: res.headers,
        body: truncated ? text.slice(0, MAX_RESPONSE_BODY_CHARS) : text,
        truncated,
        responseTime: res.durationMs,
        size: res.bodyByteLength,
      },
      logLine: `→ ${call.method} ${shown} ${res.status} (${res.durationMs} ms)`,
    }
  } catch (err) {
    const message = options.redact(maskUserinfo(toErrorPayload(err).message))
    const ms = Math.max(0, Math.round(performance.now() - started))
    return { ok: false, error: message, logLine: `→ ${call.method} ${shown} failed: ${message} (${ms} ms)` }
  }
}
