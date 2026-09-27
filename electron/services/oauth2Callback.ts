import { createServer, type Server } from 'node:http'
import { invalidInput, ioError } from '../lib/errors'
import { CALLBACK_PAGE_HEADERS, callbackPage } from './authCallback'

/** Where an authorization-code redirect is received: the exact host/port/path of the configured redirect URI. */
export interface LoopbackRedirect {
  /** The redirect URI exactly as configured (sent as `redirect_uri`, which must match the registration byte for byte). */
  uri: string
  /** Addresses to bind: 127.0.0.1 and/or ::1. */
  addresses: string[]
  port: number
  path: string
}

const LOOPBACK_HOSTS: Record<string, string[]> = {
  '127.0.0.1': ['127.0.0.1'],
  '[::1]': ['::1'],
  // Browsers may resolve localhost to either family; ::1 is best effort (see listenAll).
  localhost: ['127.0.0.1', '::1'],
}

/**
 * Accepts only `http://127.0.0.1|localhost|[::1][:port]/path` redirect URIs: a desktop app can only receive a redirect
 * on a loopback listener (RFC 8252 section 7.3). Anything else, such as Postman's `https://oauth.pstmn.io/v1/callback`,
 * is refused with an explanation.
 */
export function parseLoopbackRedirect(uri: string): LoopbackRedirect {
  const raw = uri.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalidInput(`The redirect URI "${raw}" is not a valid URL`)
  }
  const addresses = LOOPBACK_HOSTS[url.hostname.toLowerCase()]
  if (url.protocol !== 'http:' || !addresses) {
    throw invalidInput(
      `Slinger cannot receive the redirect at "${raw}": a desktop app can only receive it on this computer. Register a loopback ` +
        'redirect URI with the provider, such as http://127.0.0.1:47125/oauth2/callback, and enter the same URI here.',
      { reason: 'redirect_not_loopback' },
    )
  }
  if (url.username || url.password) throw invalidInput('The redirect URI must not contain a user name or password')
  const port = url.port ? Number(url.port) : 80
  return { uri: raw, addresses, port, path: url.pathname || '/' }
}

export interface AuthorizationCallback {
  /** Resolves with the authorization code of the first redirect to the path, or rejects with the provider's error. */
  code: Promise<string>
  close(): void
}

const MAX_TEXT = 500

/** Starts listening on the redirect URI's address; resolves once bound (port in use and similar are io_error). */
export async function startAuthorizationCallback(redirect: LoopbackRedirect, expectedState: string): Promise<AuthorizationCallback> {
  let settled = false
  let resolveCode!: (code: string) => void
  let rejectCode!: (e: Error) => void
  const code = new Promise<string>((res, rej) => {
    resolveCode = res
    rejectCode = rej
  })
  code.catch(() => {}) // surfaced through the awaiting caller

  const servers: Server[] = []
  const close = () => {
    for (const s of servers) {
      s.close()
      s.closeAllConnections()
    }
  }

  const handler: Parameters<typeof createServer>[1] = (req, res) => {
    const respond = (status: number, heading: string, message: string) => {
      res.writeHead(status, CALLBACK_PAGE_HEADERS)
      res.end(callbackPage(heading, message))
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return respond(400, 'Authorization failed', 'Slinger could not read this redirect.')
    }
    if (req.method !== 'GET' || url.pathname !== redirect.path || settled) {
      return respond(404, 'Not found', 'This redirect is not expected (anymore). Return to Slinger and try again.')
    }
    const param = (name: string) => (url.searchParams.get(name) ?? '').slice(0, MAX_TEXT)
    settled = true
    // Stop listening once the redirect arrived (after the page is written).
    setTimeout(close, 250).unref()
    const error = param('error')
    if (error) {
      const description = param('error_description')
      respond(200, 'Authorization failed', `The authorization server answered: ${error}${description ? ` (${description})` : ''}. Return to Slinger.`)
      return rejectCode(
        invalidInput(`The authorization server refused: ${error}${description ? ` (${description})` : ''}`, { oauthError: error }),
      )
    }
    if (param('state') !== expectedState) {
      respond(400, 'Authorization failed', 'The state parameter does not match this sign-in. Return to Slinger and try again.')
      return rejectCode(invalidInput('The authorization response was rejected: its state does not match (possible forged redirect)', { reason: 'state_mismatch' }))
    }
    const value = url.searchParams.get('code')
    if (!value) {
      respond(400, 'Authorization failed', 'The redirect did not contain an authorization code. Return to Slinger.')
      return rejectCode(invalidInput('The authorization response did not contain a code'))
    }
    respond(200, 'Authorization received', 'Slinger received the authorization. You can close this tab and return to the app.')
    resolveCode(value)
  }

  try {
    await listenAll(redirect, handler, servers)
  } catch (err) {
    close()
    throw err
  }
  return { code, close }
}

async function listenAll(redirect: LoopbackRedirect, handler: Parameters<typeof createServer>[1], servers: Server[]): Promise<void> {
  for (const [i, address] of redirect.addresses.entries()) {
    const server = createServer(handler)
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(redirect.port, address, () => {
          server.off('error', reject)
          resolve()
        })
      })
      servers.push(server)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      // `localhost`: a machine without IPv6 still works on 127.0.0.1.
      if (i > 0 && (e.code === 'EADDRNOTAVAIL' || e.code === 'EAFNOSUPPORT')) continue
      const where = `${address.includes(':') ? `[${address}]` : address}:${redirect.port}`
      if (e.code === 'EADDRINUSE') {
        throw ioError(`Port ${redirect.port} is already in use (${where}): close the other program or sign-in, or register another loopback redirect URI`, {
          reason: 'port_in_use',
        })
      }
      if (e.code === 'EACCES') throw ioError(`Not allowed to listen on ${where}: use a port above 1024 in the redirect URI`)
      throw ioError(`Could not listen for the redirect on ${where}: ${e.message}`)
    }
  }
}
