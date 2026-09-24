/** Wire types (snake_case, as sent by the cloud API) and shared cloud types. */

export interface CloudUser {
  id: string
  email: string
  display_name?: string
}
export interface CloudWorkspace {
  id: string
  slug?: string
  name: string
  role?: string
}
export interface DeviceStartResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}
export interface TokenResponse {
  access_token: string
  refresh_token: string
}
export type DevicePollResponse =
  | { status: 'pending' | 'expired' | 'denied' }
  | ({ status: 'approved' } & TokenResponse)

export interface Tokens {
  accessToken: string
  refreshToken: string
}
export interface CloudConfig {
  apiBaseUrl: string
  deviceName: string
}
export interface WorkspaceLink {
  remoteId: string
  remoteName: string
}

export class CloudApiError extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'CloudApiError'
    this.status = status
    this.code = code
  }
}
