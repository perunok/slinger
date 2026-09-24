import { errorInfo } from '../../lib/ipc'
/**
 * The single typed cloud HTTP client. Requests go through window.slinger.cloudFetch
 * (main-process transport, avoids CORS). That IPC never records history and cannot read local files.
 */
import { api } from '../../lib/ipc'
import type { CloudFetchInput } from '../../../shared/types'
import { endpoints, joinUrl } from './endpoints'
import { clearTokens, loadTokens, saveTokens } from './session'
import {
  CloudApiError,
  type CloudUser,
  type CloudWorkspace,
  type DevicePollResponse,
  type DeviceStartResponse,
  type TokenResponse,
} from './types'

export interface ClientOptions {
  baseUrl: string
  /** Called after a failed refresh cleared the stored tokens. */
  onSignedOut?: () => void
}

interface ReqOpts {
  body?: unknown
  auth?: boolean
}

function errorFrom(status: number, text: string | null): CloudApiError {
  let message = `Request failed (HTTP ${status})`
  let code: string | undefined
  try {
    const j = JSON.parse(text ?? '') as { error?: unknown; message?: unknown; code?: unknown }
    const e = j.error
    if (typeof e === 'string') message = e
    else if (e && typeof e === 'object') {
      const o = e as { message?: unknown; code?: unknown }
      if (typeof o.message === 'string') message = o.message
      if (typeof o.code === 'string') code = o.code
    } else if (typeof j.message === 'string') message = j.message
    if (!code && typeof j.code === 'string') code = j.code
  } catch {
    /* non-JSON body */
  }
  return new CloudApiError(status, message, code)
}

export class CloudClient {
  #refreshing: Promise<boolean> | null = null
  constructor(private readonly opts: ClientOptions) {}

  async #send(method: string, path: string, body: unknown, token?: string) {
    const headers = [{ key: 'Accept', value: 'application/json' }]
    if (body !== undefined) headers.push({ key: 'Content-Type', value: 'application/json' })
    if (token) headers.push({ key: 'Authorization', value: `Bearer ${token}` })
    const input: CloudFetchInput = {
      method,
      url: joinUrl(this.opts.baseUrl, path),
      headers,
      body: body === undefined ? null : { content: JSON.stringify(body), contentType: 'application/json' },
    }
    try {
      return await api().cloudFetch(input)
    } catch (e) {
      throw new CloudApiError(0, errorInfo(e).message || 'Network error', 'network_error')
    }
  }

  async #parse<T>(res: { status: number; bodyText: string | null }): Promise<T> {
    if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.bodyText)
    if (!res.bodyText) return undefined as T
    try {
      return JSON.parse(res.bodyText) as T
    } catch {
      throw new CloudApiError(res.status, 'Invalid JSON response from cloud API', 'invalid_json')
    }
  }

  /** Refreshes once (deduped). Returns false when the session is gone. */
  #refresh(): Promise<boolean> {
    this.#refreshing ??= this.#doRefresh().finally(() => (this.#refreshing = null))
    return this.#refreshing
  }
  async #doRefresh(): Promise<boolean> {
    const { baseUrl } = this.opts
    const tokens = await loadTokens(baseUrl)
    if (!tokens) return false
    try {
      const res = await this.#send('POST', endpoints.refresh, { refresh_token: tokens.refreshToken })
      const t = await this.#parse<TokenResponse>(res)
      await saveTokens(baseUrl, {
        accessToken: t.access_token,
        refreshToken: t.refresh_token || tokens.refreshToken,
      })
      return true
    } catch (e) {
      if (e instanceof CloudApiError && e.status !== 0) {
        await clearTokens(baseUrl)
        this.opts.onSignedOut?.()
        return false
      }
      throw e // transient network failure: keep the session
    }
  }

  async request<T>(method: string, path: string, { body, auth = true }: ReqOpts = {}): Promise<T> {
    if (!auth) return this.#parse<T>(await this.#send(method, path, body))
    const tokens = await loadTokens(this.opts.baseUrl)
    if (!tokens) throw new CloudApiError(401, 'Not signed in', 'unauthenticated')
    const res = await this.#send(method, path, body, tokens.accessToken)
    if (res.status !== 401) return this.#parse<T>(res)
    if (!(await this.#refresh())) throw errorFrom(401, res.bodyText)
    const fresh = await loadTokens(this.opts.baseUrl)
    return this.#parse<T>(await this.#send(method, path, body, fresh?.accessToken))
  }

  deviceStart(deviceName: string) {
    return this.request<DeviceStartResponse>('POST', endpoints.deviceStart, {
      auth: false,
      body: { client_name: 'slinger-desktop', device_name: deviceName },
    })
  }
  devicePoll(deviceCode: string) {
    return this.request<DevicePollResponse>('POST', endpoints.devicePoll, {
      auth: false,
      body: { device_code: deviceCode },
    })
  }
  async me(): Promise<CloudUser> {
    return (await this.request<{ user: CloudUser }>('GET', endpoints.me)).user
  }
  async listWorkspaces(): Promise<CloudWorkspace[]> {
    return (await this.request<{ items: CloudWorkspace[] }>('GET', endpoints.workspaces)).items ?? []
  }
  /** The server derives a unique slug (min 3 chars, must be free) when none is sent. */
  async createWorkspace(name: string): Promise<CloudWorkspace> {
    return (await this.request<{ workspace: CloudWorkspace }>('POST', endpoints.workspaces, { body: { name } }))
      .workspace
  }
  /** Best effort server-side revoke; the caller clears local tokens regardless. */
  async logout(refreshToken: string): Promise<void> {
    await this.request('POST', endpoints.logout, { auth: false, body: { refresh_token: refreshToken } })
  }
}
