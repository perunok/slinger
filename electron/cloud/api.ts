/** Typed cloud API calls used by sync (paths and shapes: slinger-admin server routes + docs/SYNC_DESIGN.md section 14). */
import type { CloudRole } from '../../shared/types'
import type { PullResponse, PushResponse, SnapshotResponse, WireOp } from '../sync/types'
import type { CloudAuth } from './auth'
import { CloudApiError } from './errors'
import type { CloudHttp } from './http'

export interface RemoteWorkspaceInfo {
  id: string
  name: string
  slug: string
  role: CloudRole | null
}
export interface RegisterResult {
  clientId: string
  protocolVersion: number
  features: string[]
}
export interface PublishResult {
  workspace: RemoteWorkspaceInfo
  role: CloudRole
  clientId: string
  checkpoint: number
}

/** What the sync engine needs from the cloud. Implemented by CloudApi over HTTP; tests may stub it. */
export interface CloudGateway {
  registerClient(deviceName: string, clientVersion: string): Promise<RegisterResult>
  listWorkspaces(): Promise<RemoteWorkspaceInfo[]>
  getWorkspace(id: string): Promise<RemoteWorkspaceInfo>
  publish(name: string, clientId: string, deviceName: string): Promise<PublishResult>
  push(workspaceId: string, clientId: string, baseCheckpoint: number, operations: WireOp[]): Promise<PushResponse>
  pull(workspaceId: string, clientId: string, afterCheckpoint: number, limit: number): Promise<PullResponse>
  snapshot(workspaceId: string, clientId: string, cursor: string | null, limit: number): Promise<SnapshotResponse>
}

interface WorkspaceWire {
  id: string
  name: string
  slug: string
  role?: CloudRole
}

export class CloudApi implements CloudGateway {
  constructor(
    private readonly http: CloudHttp,
    private readonly auth: CloudAuth,
  ) {}

  /** Authenticated call; network outcomes feed the session's `offline` flag. */
  private async call<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | number | undefined>; timeoutMs?: number } = {}): Promise<T> {
    try {
      const out = await this.auth.withToken((token) => this.http.request<T>(method, this.auth.baseUrl(), path, { ...opts, token }))
      this.auth.setOffline(false)
      return out
    } catch (err) {
      if (err instanceof CloudApiError && err.isNetwork) this.auth.setOffline(true)
      throw err
    }
  }

  async registerClient(deviceName: string, clientVersion: string): Promise<RegisterResult> {
    const res = await this.call<{ client: { client_id: string }; protocol_version?: number; features?: string[] }>('POST', '/v1/sync/clients/register', {
      body: { client_name: 'slinger-desktop', client_version: clientVersion, device_name: deviceName, platform: process.platform },
    })
    return { clientId: res.client.client_id, protocolVersion: res.protocol_version ?? 1, features: res.features ?? [] }
  }

  async listWorkspaces(): Promise<RemoteWorkspaceInfo[]> {
    const out: RemoteWorkspaceInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 50; page++) {
      const res = await this.call<{ items: WorkspaceWire[]; page?: { next_cursor: string | null; has_more: boolean } }>('GET', '/v1/workspaces', {
        query: { limit: 100, cursor },
      })
      for (const w of res.items ?? []) out.push({ id: w.id, name: w.name, slug: w.slug, role: w.role ?? null })
      if (!res.page?.has_more || !res.page.next_cursor) break
      cursor = res.page.next_cursor
    }
    return out
  }

  async getWorkspace(id: string): Promise<RemoteWorkspaceInfo> {
    const res = await this.call<{ workspace: WorkspaceWire; membership: { role: CloudRole } | null }>('GET', `/v1/workspaces/${encodeURIComponent(id)}`)
    return { id: res.workspace.id, name: res.workspace.name, slug: res.workspace.slug, role: res.membership?.role ?? null }
  }

  async publish(name: string, clientId: string, deviceName: string): Promise<PublishResult> {
    const res = await this.call<{ workspace: WorkspaceWire; membership: { role: CloudRole } | null; sync_bootstrap: { client_id: string; checkpoint: number } }>(
      'POST', '/v1/workspaces/publish',
      { body: { local_workspace: { name }, publish_mode: 'create', client: { client_id: clientId, device_name: deviceName } } },
    )
    return {
      workspace: { id: res.workspace.id, name: res.workspace.name, slug: res.workspace.slug, role: res.membership?.role ?? 'owner' },
      role: res.membership?.role ?? 'owner',
      clientId: res.sync_bootstrap.client_id,
      checkpoint: res.sync_bootstrap.checkpoint,
    }
  }

  push(workspaceId: string, clientId: string, baseCheckpoint: number, operations: WireOp[]): Promise<PushResponse> {
    return this.call<PushResponse>('POST', `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/push`, {
      body: { client_id: clientId, base_checkpoint: baseCheckpoint, operations },
    })
  }

  pull(workspaceId: string, clientId: string, afterCheckpoint: number, limit: number): Promise<PullResponse> {
    return this.call<PullResponse>('GET', `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/pull`, {
      query: { client_id: clientId, after_checkpoint: afterCheckpoint, limit },
    })
  }

  snapshot(workspaceId: string, clientId: string, cursor: string | null, limit: number): Promise<SnapshotResponse> {
    return this.call<SnapshotResponse>('GET', `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/snapshot`, {
      query: { client_id: clientId, cursor: cursor || undefined, limit },
    })
  }
}
