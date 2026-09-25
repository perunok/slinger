import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { invalidInput, ioError, notFound } from '../lib/errors'
import { assertUuid, newId } from '../lib/ids'

const PAGE = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Slinger Desktop</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f0e8;color:#1f2933;font-family:"Segoe UI",sans-serif;padding:24px}main{width:min(420px,100%);background:#fffdf8;border:1px solid #d9d0bf;border-radius:16px;padding:24px}h1{margin:0 0 12px;font-size:24px}p{margin:0;color:#52606d;line-height:1.5}</style></head><body><main><h1>Authorization received</h1><p>${message}</p></main></body></html>`

/** Listener lifetime if nobody ever calls wait(): prevents leaked loopback servers. */
export const CALLBACK_MAX_LIFETIME_MS = 10 * 60_000
const MAX_PARAMS = 50
const MAX_PARAM_LENGTH = 8192

interface Pending {
  server: Server
  result: Promise<Record<string, string>>
  expiry: NodeJS.Timeout
  close(): void
}

/**
 * One-shot loopback HTTP listener for browser sign-in redirects. prepare() binds
 * 127.0.0.1 on a random port and returns the redirect URL; wait() resolves with the query
 * parameters of the first GET to that URL (or rejects on timeout).
 */
export class BrowserAuthCallbacks {
  private readonly pending = new Map<string, Pending>()

  async prepare(): Promise<{ callbackId: string; redirectUrl: string }> {
    const callbackId = newId()
    const path = `/auth/callback/${callbackId}`
    let resolveResult!: (v: Record<string, string>) => void
    let rejectResult!: (e: Error) => void
    const result = new Promise<Record<string, string>>((res, rej) => {
      resolveResult = res
      rejectResult = rej
    })
    result.catch(() => {}) // rejection is surfaced through wait(); avoid unhandled-rejection noise

    const server = createServer((req, res) => {
      const respond = (status: number, message: string) => {
        res.writeHead(status, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          Connection: 'close',
        })
        res.end(PAGE(message))
      }
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        return respond(400, 'The desktop app could not read this authorization request.')
      }
      if (req.method !== 'GET' || url.pathname !== path) {
        return respond(404, 'This callback URL is not active anymore. Return to the desktop app and try again.')
      }
      const params: Record<string, string> = {}
      let count = 0
      for (const [k, v] of url.searchParams) {
        if (++count > MAX_PARAMS) break
        params[k] = v.slice(0, MAX_PARAM_LENGTH)
      }
      respond(200, 'The browser confirmed your sign-in. You can return to Slinger.')
      resolveResult(params)
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', (e) => reject(ioError(`Could not start auth callback listener: ${e.message}`)))
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port

    const stopListening = () => {
      server.close()
      server.closeAllConnections()
    }
    const close = () => {
      clearTimeout(expiry)
      stopListening()
      this.pending.delete(callbackId)
    }
    const expiry = setTimeout(() => {
      rejectResult(ioError('Browser auth callback expired'))
      close()
    }, CALLBACK_MAX_LIFETIME_MS)
    expiry.unref()
    this.pending.set(callbackId, { server, result, expiry, close })
    // Stop listening once the redirect arrived; the result stays available to wait() until expiry.
    void result.then(() => setTimeout(stopListening, 250).unref(), () => {})

    return { callbackId, redirectUrl: `http://127.0.0.1:${port}${path}` }
  }

  async wait(callbackId: string, timeoutMs: number): Promise<Record<string, string>> {
    const id = assertUuid(callbackId, 'callbackId')
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw invalidInput('timeoutMs must be a positive number')
    const entry = this.pending.get(id)
    if (!entry) throw notFound('browser auth callback')
    const timeout = Math.min(timeoutMs, CALLBACK_MAX_LIFETIME_MS)
    let timer!: NodeJS.Timeout
    try {
      return await Promise.race([
        entry.result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(ioError('Timed out waiting for browser authorization')), timeout)
        }),
      ])
    } finally {
      clearTimeout(timer)
      entry.close()
    }
  }

  /** Closes every listener (app shutdown). */
  closeAll(): void {
    for (const p of [...this.pending.values()]) p.close()
  }
}
