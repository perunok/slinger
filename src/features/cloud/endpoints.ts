/**
 * The ONLY place cloud API paths live (matches slinger-admin server/openapi.yaml).
 * All paths are relative to the configured API base URL.
 */
export const endpoints = {
  deviceStart: '/v1/auth/device/start',
  devicePoll: '/v1/auth/device/poll',
  refresh: '/v1/auth/refresh',
  logout: '/v1/auth/logout',
  me: '/v1/me',
  workspaces: '/v1/workspaces',
  workspace: (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`,
} as const

/** Joins base URL and path without doubled or missing slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
