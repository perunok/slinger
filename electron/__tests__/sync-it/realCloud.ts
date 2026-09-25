/** Helpers around a REAL slinger-admin server started by scripts/sync-it-server.mjs. */
import { startSyncItServer, type SyncItServer } from '../../../scripts/sync-it-server.mjs'
import type { Device } from '../sync/harness'

export interface Json {
  [k: string]: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class RealCloud {
  private constructor(readonly server: SyncItServer) {}

  static async start(): Promise<RealCloud> {
    return new RealCloud(await startSyncItServer())
  }
  get baseUrl(): string {
    return this.server.baseUrl
  }
  stop(): Promise<void> {
    return this.server.stop()
  }

  async call(method: string, path: string, opts: { token?: string; body?: unknown; form?: Record<string, string> } = {}): Promise<{ status: number; json: Json; text: string }> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    let body: string | undefined
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(opts.form).toString()
    } else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    const res = await fetch(this.baseUrl + path, { method, headers, body })
    const text = await res.text()
    let json: Json = {}
    try {
      json = JSON.parse(text) as Json
    } catch {
      /* html */
    }
    return { status: res.status, json, text }
  }

  /** Approves a pending device code the way a browser user would (POST /device). */
  async approveDevice(userCode: string, email: string, password: string): Promise<void> {
    const res = await this.call('POST', '/device', { form: { user_code: userCode, email, password } })
    if (res.status !== 200) throw new Error(`device approval failed (${res.status}): ${res.text.slice(0, 300)}`)
  }

  /** Raw API tokens through the same device flow (for the test's own admin/owner/member calls). */
  async login(email: string, password: string): Promise<string> {
    const start = await this.call('POST', '/v1/auth/device/start', { body: { client_name: 'sync-it', device_name: 'sync-it' } })
    await this.approveDevice(start.json.user_code as string, email, password)
    const poll = await this.call('POST', '/v1/auth/device/poll', { body: { device_code: start.json.device_code } })
    if (poll.json.status !== 'approved') throw new Error(`login failed: ${poll.text}`)
    return poll.json.access_token as string
  }

  async adminToken(): Promise<string> {
    return this.login(this.server.adminEmail, this.server.adminPassword)
  }

  async createUser(adminToken: string, email: string, password: string): Promise<string> {
    const res = await this.call('POST', '/v1/admin/users', { token: adminToken, body: { email, display_name: email.split('@')[0], password } })
    if (res.status >= 300) throw new Error(`createUser failed: ${res.text}`)
    return res.json.user.id as string
  }

  /** Owner invites `email`; the invitee accepts. Returns the membership row id. */
  async addMember(wsId: string, ownerToken: string, email: string, password: string, role: 'editor' | 'viewer' | 'admin'): Promise<{ memberId: string; userId: string }> {
    const inv = await this.call('POST', `/v1/workspaces/${wsId}/invites`, { token: ownerToken, body: { email, role } })
    if (inv.status >= 300) throw new Error(`invite failed: ${inv.text}`)
    const userToken = await this.login(email, password)
    const acc = await this.call('POST', `/v1/invites/${inv.json.invite.id}/accept`, { token: userToken, body: { invite_token: inv.json.invite_token } })
    if (acc.status >= 300) throw new Error(`accept failed: ${acc.text}`)
    return this.member(wsId, ownerToken, email)
  }

  async member(wsId: string, ownerToken: string, email: string): Promise<{ memberId: string; userId: string }> {
    const list = await this.call('GET', `/v1/workspaces/${wsId}/members`, { token: ownerToken })
    const m = (list.json.items as Json[]).find((x) => x.email === email)!
    return { memberId: m.id as string, userId: m.user_id as string }
  }

  async setRole(wsId: string, ownerToken: string, email: string, role: 'editor' | 'viewer'): Promise<void> {
    const list = await this.call('GET', `/v1/workspaces/${wsId}/members`, { token: ownerToken })
    const m = (list.json.items as Json[]).find((x) => x.email === email)!
    const res = await this.call('PATCH', `/v1/workspaces/${wsId}/members/${m.id}`, { token: ownerToken, body: { role, version: m.version } })
    if (res.status >= 300) throw new Error(`setRole failed: ${res.text}`)
  }

  async removeMember(wsId: string, ownerToken: string, email: string): Promise<void> {
    const { memberId } = await this.member(wsId, ownerToken, email)
    const res = await this.call('DELETE', `/v1/workspaces/${wsId}/members/${memberId}`, { token: ownerToken })
    if (res.status >= 300) throw new Error(`removeMember failed: ${res.text}`)
  }

  /** Every current entity of a workspace via the snapshot endpoint (what a fresh device would download). */
  async snapshotAll(wsId: string, token: string): Promise<Array<{ resource_type: string; resource_id: string; version: number; payload: Json }>> {
    const reg = await this.call('POST', '/v1/sync/clients/register', { token, body: { client_name: 'sync-it', device_name: 'snapshot' } })
    const clientId = reg.json.client.client_id as string
    const out: Array<{ resource_type: string; resource_id: string; version: number; payload: Json }> = []
    let cursor = ''
    for (;;) {
      const res = await this.call('GET', `/v1/workspaces/${wsId}/sync/snapshot?client_id=${clientId}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { token })
      if (res.status !== 200) throw new Error(`snapshot failed: ${res.text}`)
      out.push(...(res.json.entities as typeof out))
      if (!res.json.next_cursor) return out
      cursor = res.json.next_cursor as string
    }
  }
}

/** Signs a desktop device in through the REAL device flow (startCloudSignIn -> browser approval -> poll in main). */
export async function signInDevice(dev: Device, cloud: RealCloud, email: string, password: string): Promise<void> {
  const start = await dev.api.startCloudSignIn()
  await cloud.approveDevice(start.userCode, email, password)
  const end = Date.now() + 20_000
  while (!dev.events.some((e) => e.type === 'signInResult')) {
    if (Date.now() > end) throw new Error('sign-in did not complete')
    dev.timers.advance(start.intervalSec * 1000)
    await new Promise((r) => setTimeout(r, 25))
  }
  const result = dev.events.find((e) => e.type === 'signInResult')
  if (result?.type !== 'signInResult' || result.result !== 'approved') throw new Error(`sign-in failed: ${JSON.stringify(result)}`)
}
