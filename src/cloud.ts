export type CloudPlatformRole = 'super_admin' | 'platform_admin' | 'user'
export type CloudWorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer'
export type CloudWorkspaceVisibility = 'private' | 'discoverable' | 'public'
export type CloudHostMode = 'shared' | 'dedicated_subdomain' | 'custom_domain' | string
export type CloudHostKind = 'shared_host' | 'dedicated_subdomain' | 'custom_domain' | string
export type CloudHostStatus = 'active' | 'pending_verification' | 'disabled' | string
export type CloudTlsStatus = 'ready' | 'pending' | 'failed' | string
export type CloudSyncResourceType =
  | 'workspace'
  | 'collection'
  | 'folder'
  | 'request'
  | 'environment'
  | 'environment_variable'
  | string
export type CloudSyncOperationKind = 'upsert' | 'delete' | string

type CloudPage = {
  next_cursor: string | null
  has_more: boolean
}

type CloudMutableResource = {
  created_at: string
  updated_at: string
  version: number
}

type CloudListResponse<T> = {
  items: T[]
  page?: CloudPage
}

export type CloudConfig = {
  apiBaseUrl: string
  deviceName: string
}

export type CloudSession = {
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresAt: number
}

export type CloudUser = {
  id: string
  email: string
  display_name: string
  platform_role: CloudPlatformRole
}

export type CloudWorkspaceMembership = {
  workspace_id: string
  role: CloudWorkspaceRole
}

export type CloudMeResponse = {
  user: CloudUser
  workspace_memberships: CloudWorkspaceMembership[]
}

export type CloudWorkspace = CloudMutableResource & {
  id: string
  slug: string
  name: string
  description?: string
  owner_user_id?: string
  visibility?: CloudWorkspaceVisibility
  default_role_for_requests?: CloudWorkspaceRole
  role?: CloudWorkspaceRole
  effective_role?: CloudWorkspaceRole
  host_mode?: CloudHostMode
}

export type CloudWorkspaceListResponse = CloudListResponse<CloudWorkspace>

export type CloudWorkspaceDetailResponse = {
  workspace: CloudWorkspace
  role?: CloudWorkspaceRole
  effective_role?: CloudWorkspaceRole
}

export type CloudWorkspaceCreateResponse = {
  workspace: CloudWorkspace
}

export type CloudWorkspaceMember = CloudMutableResource & {
  id: string
  workspace_id: string
  user_id?: string
  email: string
  display_name?: string
  role: CloudWorkspaceRole
  status: string
  joined_at?: string
}

export type CloudWorkspaceMemberListResponse = CloudListResponse<CloudWorkspaceMember>

export type CloudInvite = CloudMutableResource & {
  id: string
  workspace_id: string
  email: string
  role: CloudWorkspaceRole
  status: string
  invited_by_user_id?: string
  expires_at?: string
}

export type CloudInviteResponse = {
  invite: CloudInvite
}

export type CloudInviteAcceptResponse = {
  workspace_id: string
  membership: {
    role: CloudWorkspaceRole
  }
}

export type CloudJoinRequest = CloudMutableResource & {
  id: string
  workspace_id: string
  requester_user_id?: string
  message: string
  status: string
  requested_role: CloudWorkspaceRole
}

export type CloudJoinRequestResponse = {
  join_request: CloudJoinRequest
}

export type CloudJoinRequestApprovalResponse = {
  membership: Partial<CloudWorkspaceMember> & {
    role: CloudWorkspaceRole
  }
}

export type CloudWorkspaceMemberUpdateResponse = {
  member: Partial<CloudWorkspaceMember> & {
    id: string
    role: CloudWorkspaceRole
    version: number
    updated_at: string
  }
}

export type CloudHostBinding = CloudMutableResource & {
  id: string
  workspace_id: string
  host: string
  kind: CloudHostKind
  status: CloudHostStatus
  tls_status: CloudTlsStatus
}

export type CloudHostVerification = {
  dns_record_type: string
  dns_record_name: string
  dns_record_value: string
}

export type CloudWorkspaceHostListResponse = {
  items: CloudHostBinding[]
}

export type CloudWorkspaceHostCreateResponse = {
  host: CloudHostBinding
  verification?: CloudHostVerification
}

export type DeviceAuthStartResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export type DeviceAuthPollPendingResponse = {
  status: 'pending'
}

export type DeviceAuthPollApprovedResponse = {
  status: 'approved'
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
  user: CloudUser
}

export type DeviceAuthPollResponse = DeviceAuthPollPendingResponse | DeviceAuthPollApprovedResponse

export type RefreshSessionResponse = {
  access_token: string
  refresh_token: string
  expires_in: number
  token_type: string
}

export type SyncClientRegistrationResponse = {
  client: {
    client_id: string
    registered_at: string
  }
}

export type PublishWorkspaceResponse = {
  workspace: CloudWorkspace & {
    owner_user_id: string
  }
  membership: {
    role: CloudWorkspaceRole
  }
  sync_bootstrap: {
    client_id: string
    checkpoint: number
  }
}

export type CloudSyncOperation = {
  operation_id: string
  workspace_id?: string
  resource_type: CloudSyncResourceType
  resource_id: string
  op: CloudSyncOperationKind
  base_version?: number
  resulting_version?: number
  payload: Record<string, unknown>
  occurred_at: string
}

export type CloudSyncPushAcceptedOperation = {
  operation_id: string
  resource_id: string
  resulting_version: number
}

export type CloudSyncRejectedOperation = {
  operation_id: string
  resource_id?: string
  code?: string
  message?: string
}

export type CloudSyncPushResponse = {
  accepted: CloudSyncPushAcceptedOperation[]
  rejected: CloudSyncRejectedOperation[]
  checkpoint: number
}

export type CloudSyncPullResponse = {
  operations: CloudSyncOperation[]
  checkpoint: number
}

export type CloudRealtimeTokenResponse = {
  token: string
  expires_in: number
  channels: string[]
}

export type CloudCollabRoomTokenResponse = {
  token: string
  room_key: string
  expires_in: number
}

export type CloudDeviceFlowState = DeviceAuthStartResponse & {
  startedAt: number
}

type CloudSyncClientRegistry = Record<string, string>

const CLOUD_CONFIG_KEY = 'slinger.cloud.config.v1'
const CLOUD_SESSION_KEY = 'slinger.cloud.session.v1'
const CLOUD_SYNC_CLIENT_KEY = 'slinger.cloud.sync-client.v1'

const DEFAULT_API_BASE_URL = 'http://localhost:8787'

function defaultDeviceName(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    return `Slinger ${navigator.platform || 'Desktop'}`
  }

  return 'Slinger Desktop'
}

function syncClientRegistryKey(apiBaseUrl: string): string {
  return normalizeApiBaseUrl(apiBaseUrl) || DEFAULT_API_BASE_URL
}

export function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function defaultCloudConfig(): CloudConfig {
  return {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    deviceName: defaultDeviceName(),
  }
}

export function defaultCloudPlatform(): string {
  if (typeof navigator === 'undefined') return 'desktop'
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    'desktop'
  return platform.toLowerCase()
}

export function defaultCloudClientVersion(): string {
  return '0.1.0'
}

export function readCloudConfig(): CloudConfig {
  const fallback = defaultCloudConfig()

  try {
    const raw = localStorage.getItem(CLOUD_CONFIG_KEY)
    if (!raw) return fallback

    const parsed = JSON.parse(raw) as Partial<CloudConfig>
    return {
      apiBaseUrl: normalizeApiBaseUrl(parsed.apiBaseUrl ?? fallback.apiBaseUrl),
      deviceName: parsed.deviceName?.trim() || fallback.deviceName,
    }
  } catch {
    return fallback
  }
}

export function writeCloudConfig(config: CloudConfig): void {
  localStorage.setItem(
    CLOUD_CONFIG_KEY,
    JSON.stringify({
      apiBaseUrl: normalizeApiBaseUrl(config.apiBaseUrl),
      deviceName: config.deviceName.trim() || defaultDeviceName(),
    }),
  )
}

export function readCloudSession(): CloudSession | null {
  try {
    const raw = localStorage.getItem(CLOUD_SESSION_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as CloudSession
    if (!parsed.accessToken || !parsed.refreshToken) return null
    return parsed
  } catch {
    return null
  }
}

export function writeCloudSession(session: CloudSession): void {
  localStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify(session))
}

export function clearCloudSession(): void {
  localStorage.removeItem(CLOUD_SESSION_KEY)
}

export function isCloudSessionExpired(session: CloudSession | null, skewMs = 30_000): boolean {
  if (!session) return true
  return session.expiresAt <= Date.now() + skewMs
}

function readSyncClientRegistry(): CloudSyncClientRegistry {
  try {
    const raw = localStorage.getItem(CLOUD_SYNC_CLIENT_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw) as CloudSyncClientRegistry | string
    if (typeof parsed === 'string') {
      return {
        [DEFAULT_API_BASE_URL]: parsed,
      }
    }

    return parsed
  } catch {
    return {}
  }
}

function writeSyncClientRegistry(registry: CloudSyncClientRegistry): void {
  localStorage.setItem(CLOUD_SYNC_CLIENT_KEY, JSON.stringify(registry))
}

export function readCloudSyncClientId(apiBaseUrl: string): string | null {
  const registry = readSyncClientRegistry()
  return registry[syncClientRegistryKey(apiBaseUrl)] ?? null
}

export function writeCloudSyncClientId(apiBaseUrl: string, clientId: string): void {
  const registry = readSyncClientRegistry()
  registry[syncClientRegistryKey(apiBaseUrl)] = clientId
  writeSyncClientRegistry(registry)
}

export function clearCloudSyncClientId(apiBaseUrl?: string): void {
  if (!apiBaseUrl) {
    localStorage.removeItem(CLOUD_SYNC_CLIENT_KEY)
    return
  }

  const registry = readSyncClientRegistry()
  delete registry[syncClientRegistryKey(apiBaseUrl)]
  writeSyncClientRegistry(registry)
}

export function sessionFromTokenResponse(
  response: Pick<DeviceAuthPollApprovedResponse, 'access_token' | 'refresh_token' | 'expires_in' | 'token_type'>,
): CloudSession {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: response.token_type,
    expiresAt: Date.now() + response.expires_in * 1000,
  }
}

async function parseError(response: Response): Promise<never> {
  let message = `Request failed with status ${response.status}`

  try {
    const payload = await response.json() as {
      error?: {
        message?: string
        code?: string
      }
    }
    if (payload.error?.message) {
      message = payload.error.message
    } else if (payload.error?.code) {
      message = payload.error.code
    }
  } catch {
    // Ignore JSON parse issues and fall back to status text.
  }

  throw new Error(message)
}

async function apiRequest<T>(
  apiBaseUrl: string,
  path: string,
  options: {
    method?: string
    accessToken?: string
    body?: unknown
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`
  }

  const response = await fetch(`${normalizeApiBaseUrl(apiBaseUrl)}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  if (!response.ok) {
    await parseError(response)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return response.json() as Promise<T>
}

export async function startDeviceAuth(
  apiBaseUrl: string,
  deviceName: string,
): Promise<DeviceAuthStartResponse> {
  return apiRequest<DeviceAuthStartResponse>(apiBaseUrl, '/v1/auth/device/start', {
    method: 'POST',
    body: {
      client_name: 'slinger-desktop',
      device_name: deviceName.trim() || defaultDeviceName(),
    },
  })
}

export async function pollDeviceAuth(
  apiBaseUrl: string,
  deviceCode: string,
): Promise<DeviceAuthPollResponse> {
  return apiRequest<DeviceAuthPollResponse>(apiBaseUrl, '/v1/auth/device/poll', {
    method: 'POST',
    body: {
      device_code: deviceCode,
    },
  })
}

export async function refreshCloudSession(
  apiBaseUrl: string,
  refreshToken: string,
): Promise<RefreshSessionResponse> {
  return apiRequest<RefreshSessionResponse>(apiBaseUrl, '/v1/auth/refresh', {
    method: 'POST',
    body: {
      refresh_token: refreshToken,
    },
  })
}

export async function logoutCloudSession(
  apiBaseUrl: string,
  refreshToken: string,
): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(apiBaseUrl, '/v1/auth/logout', {
    method: 'POST',
    body: {
      refresh_token: refreshToken,
    },
  })
}

export async function getCloudMe(
  apiBaseUrl: string,
  accessToken: string,
): Promise<CloudMeResponse> {
  return apiRequest<CloudMeResponse>(apiBaseUrl, '/v1/me', {
    accessToken,
  })
}

export async function getCloudWorkspaces(
  apiBaseUrl: string,
  accessToken: string,
): Promise<CloudWorkspaceListResponse> {
  return apiRequest<CloudWorkspaceListResponse>(apiBaseUrl, '/v1/workspaces', {
    accessToken,
  })
}

export async function createCloudWorkspace(
  apiBaseUrl: string,
  accessToken: string,
  input: {
    name: string
    slug: string
    description?: string
  },
): Promise<CloudWorkspaceCreateResponse> {
  return apiRequest<CloudWorkspaceCreateResponse>(apiBaseUrl, '/v1/workspaces', {
    method: 'POST',
    accessToken,
    body: {
      name: input.name.trim(),
      slug: input.slug.trim(),
      description: input.description?.trim() || undefined,
    },
  })
}

export async function getCloudWorkspace(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
): Promise<CloudWorkspaceDetailResponse> {
  return apiRequest<CloudWorkspaceDetailResponse>(apiBaseUrl, `/v1/workspaces/${workspaceId}`, {
    accessToken,
  })
}

export async function listCloudWorkspaceMembers(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
): Promise<CloudWorkspaceMemberListResponse> {
  return apiRequest<CloudWorkspaceMemberListResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/members`,
    { accessToken },
  )
}

export async function inviteCloudWorkspaceMember(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  input: {
    email: string
    role: CloudWorkspaceRole
  },
): Promise<CloudInviteResponse> {
  return apiRequest<CloudInviteResponse>(apiBaseUrl, `/v1/workspaces/${workspaceId}/invites`, {
    method: 'POST',
    accessToken,
    body: {
      email: input.email.trim(),
      role: input.role,
    },
  })
}

export async function acceptCloudInvite(
  apiBaseUrl: string,
  accessToken: string,
  inviteId: string,
  inviteToken: string,
): Promise<CloudInviteAcceptResponse> {
  return apiRequest<CloudInviteAcceptResponse>(apiBaseUrl, `/v1/invites/${inviteId}/accept`, {
    method: 'POST',
    accessToken,
    body: {
      invite_token: inviteToken,
    },
  })
}

export async function submitCloudJoinRequest(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  input: {
    message: string
    requestedRole: CloudWorkspaceRole
  },
): Promise<CloudJoinRequestResponse> {
  return apiRequest<CloudJoinRequestResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/join-requests`,
    {
      method: 'POST',
      accessToken,
      body: {
        message: input.message.trim(),
        requested_role: input.requestedRole,
      },
    },
  )
}

export async function approveCloudJoinRequest(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  joinRequestId: string,
  input: {
    role: CloudWorkspaceRole
    version: number
  },
): Promise<CloudJoinRequestApprovalResponse> {
  return apiRequest<CloudJoinRequestApprovalResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/join-requests/${joinRequestId}/approve`,
    {
      method: 'POST',
      accessToken,
      body: input,
    },
  )
}

export async function updateCloudWorkspaceMemberRole(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  memberId: string,
  input: {
    role: CloudWorkspaceRole
    version: number
  },
): Promise<CloudWorkspaceMemberUpdateResponse> {
  return apiRequest<CloudWorkspaceMemberUpdateResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/members/${memberId}`,
    {
      method: 'PATCH',
      accessToken,
      body: input,
    },
  )
}

export async function listCloudWorkspaceHosts(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
): Promise<CloudWorkspaceHostListResponse> {
  return apiRequest<CloudWorkspaceHostListResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/hosts`,
    { accessToken },
  )
}

export async function createCloudWorkspaceHost(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  input: {
    host: string
    kind: CloudHostKind
  },
): Promise<CloudWorkspaceHostCreateResponse> {
  return apiRequest<CloudWorkspaceHostCreateResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/hosts`,
    {
      method: 'POST',
      accessToken,
      body: {
        host: input.host.trim(),
        kind: input.kind,
      },
    },
  )
}

export async function registerCloudSyncClient(
  apiBaseUrl: string,
  accessToken: string,
  input: {
    deviceName: string
    platform?: string
    clientVersion?: string
  },
): Promise<SyncClientRegistrationResponse> {
  return apiRequest<SyncClientRegistrationResponse>(apiBaseUrl, '/v1/sync/clients/register', {
    method: 'POST',
    accessToken,
    body: {
      client_name: 'slinger-desktop',
      client_version: input.clientVersion ?? defaultCloudClientVersion(),
      device_name: input.deviceName.trim() || defaultDeviceName(),
      platform: input.platform ?? defaultCloudPlatform(),
    },
  })
}

export async function publishCloudWorkspace(
  apiBaseUrl: string,
  accessToken: string,
  input: {
    workspaceName: string
    proposedSlug: string
    publishMode?: 'create' | 'attach_existing'
    clientId: string
    deviceName: string
  },
): Promise<PublishWorkspaceResponse> {
  return apiRequest<PublishWorkspaceResponse>(apiBaseUrl, '/v1/workspaces/publish', {
    method: 'POST',
    accessToken,
    body: {
      local_workspace: {
        name: input.workspaceName,
        proposed_slug: input.proposedSlug,
      },
      publish_mode: input.publishMode ?? 'create',
      client: {
        client_id: input.clientId,
        device_name: input.deviceName,
      },
    },
  })
}

export async function pushCloudWorkspaceOperations(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  input: {
    clientId: string
    baseCheckpoint: number
    operations: CloudSyncOperation[]
  },
): Promise<CloudSyncPushResponse> {
  return apiRequest<CloudSyncPushResponse>(apiBaseUrl, `/v1/workspaces/${workspaceId}/sync/push`, {
    method: 'POST',
    accessToken,
    body: {
      client_id: input.clientId,
      base_checkpoint: input.baseCheckpoint,
      operations: input.operations,
    },
  })
}

export async function pullCloudWorkspaceOperations(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  input: {
    clientId: string
    afterCheckpoint: number
  },
): Promise<CloudSyncPullResponse> {
  const search = new URLSearchParams({
    client_id: input.clientId,
    after_checkpoint: String(input.afterCheckpoint),
  })

  return apiRequest<CloudSyncPullResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/sync/pull?${search.toString()}`,
    { accessToken },
  )
}

export async function createCloudRealtimeToken(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  channels: string[],
): Promise<CloudRealtimeTokenResponse> {
  return apiRequest<CloudRealtimeTokenResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/realtime/token`,
    {
      method: 'POST',
      accessToken,
      body: {
        channels,
      },
    },
  )
}

export async function createCloudCollabRoomToken(
  apiBaseUrl: string,
  accessToken: string,
  workspaceId: string,
  roomKey: string,
): Promise<CloudCollabRoomTokenResponse> {
  return apiRequest<CloudCollabRoomTokenResponse>(
    apiBaseUrl,
    `/v1/workspaces/${workspaceId}/collab/rooms/token`,
    {
      method: 'POST',
      accessToken,
      body: {
        room_key: roomKey,
      },
    },
  )
}
