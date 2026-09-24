/**
 * The ONLY place cloud API paths live. The backend is being rewritten: adjust here.
 * All paths are relative to the configured API base URL.
 */
export const endpoints = {
  deviceStart: '/v1/account/device/start',
  devicePoll: '/v1/account/device/poll',
  refresh: '/v1/account/refresh',
  logout: '/v1/account/logout',
  me: '/v1/account/me',
  workspaces: '/v1/workspaces',
  workspace: (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`,
} as const

/** Joins base URL and path without doubled or missing slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.trim().replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}
