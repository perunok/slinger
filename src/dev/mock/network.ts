/**
 * Settings > Network for the browser dev mode and renderer tests: kept in memory, validated like main
 * (electron/services/networkSettings.ts). Certificate files are not read: any file chosen with pickFile becomes a pretend
 * certificate. Secrets are kept only to report `hasPassword` / `hasPassphrase`; they are never returned.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { NetworkSettings } from '../../../shared/types'
import { fail, nowSec, uuid } from './util'

type NetworkApi = Pick<
  SlingerIpcApi,
  | 'getNetworkSettings'
  | 'setNetworkSettings'
  | 'addNetworkCaCertificates'
  | 'removeNetworkCaCertificate'
  | 'saveNetworkClientCertificate'
  | 'removeNetworkClientCertificate'
>

export interface MockNetworkControls {
  reset(): void
}

const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

const defaults = (): NetworkSettings => ({
  verifySsl: true,
  caCertificates: [],
  clientCertificates: [],
  proxy: { mode: 'system', url: '', username: '', hasPassword: false, bypass: [] },
})

function proxyUrl(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`)
  } catch {
    fail('invalid_input', 'The proxy URL is not valid (expected http://host:port)')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('invalid_input', 'The proxy must be an http:// or https:// URL (SOCKS proxies are not supported)')
  if (u.username || u.password) fail('invalid_input', 'Put the proxy username and password in their own fields, not in the URL')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) fail('invalid_input', 'The proxy URL must be just http://host:port')
  return `${u.protocol}//${u.host}`
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p

/** `granted`: the subset of paths chosen with pickFile in this session (mock/misc.ts grantedFiles). */
export function createNetworkApi(granted: (paths: string[]) => Promise<string[]>): { api: NetworkApi; controls: MockNetworkControls } {
  let s = defaults()
  const out = (): NetworkSettings => JSON.parse(JSON.stringify(s)) as NetworkSettings
  const mustBeGranted = async (path: string, label: string) => {
    if ((await granted([path])).length === 0) fail('invalid_input', `${label}: file not granted. Choose the file again with the file picker`, { reason: 'file_not_granted', path })
  }

  const api: NetworkApi = {
    async getNetworkSettings() {
      return out()
    },
    async setNetworkSettings(update) {
      if (update.proxy) {
        const p = update.proxy
        const next = {
          mode: p.mode ?? s.proxy.mode,
          url: p.url !== undefined ? proxyUrl(p.url) : s.proxy.url,
          username: p.username !== undefined ? p.username.trim() : s.proxy.username,
          bypass: p.bypass !== undefined ? p.bypass.map((b) => b.trim()).filter(Boolean) : s.proxy.bypass,
        }
        if (next.mode === 'custom' && !next.url) fail('invalid_input', 'Enter the proxy URL (http://host:port) to use a custom proxy')
        if (/[\r\n:]/.test(next.username)) fail('invalid_input', 'The proxy username cannot contain a colon or line breaks')
        const hasPassword = p.password === null || p.password === '' ? false : p.password !== undefined ? true : s.proxy.hasPassword
        s.proxy = { ...next, hasPassword }
      }
      if (update.verifySsl !== undefined) s.verifySsl = update.verifySsl
      return out()
    },
    async addNetworkCaCertificates(paths) {
      for (const path of paths) await mustBeGranted(path, 'CA certificate file')
      for (const path of paths) {
        if (s.caCertificates.some((c) => c.name === baseName(path))) continue
        s.caCertificates.push({ id: uuid(), name: baseName(path), subject: `Mock CA (${baseName(path)})`, expiresAt: nowSec() + 365 * 86_400, addedAt: nowSec() })
      }
      return out()
    },
    async removeNetworkCaCertificate(id) {
      if (!s.caCertificates.some((c) => c.id === id)) fail('not_found', 'CA certificate not found', { id })
      s.caCertificates = s.caCertificates.filter((c) => c.id !== id)
      return out()
    },
    async saveNetworkClientCertificate(input) {
      const existing = input.id ? s.clientCertificates.find((c) => c.id === input.id) : undefined
      if (input.id && !existing) fail('not_found', 'client certificate not found', { id: input.id })
      const host = input.host.trim().toLowerCase()
      if (!host || !HOST_RE.test(host)) fail('invalid_input', 'Enter the host name the certificate is for (e.g. api.example.com or *.example.com), without https:// or a path')
      const port = input.port ?? null
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) fail('invalid_input', 'The port must be from 1 to 65535')
      const path = async (value: string | null | undefined, stored: string | null | undefined, label: string) => {
        if (!value) return null
        if (value !== stored) await mustBeGranted(value, label)
        return value
      }
      const pfxPath = await path(input.pfxPath, existing?.pfxPath, 'PFX file')
      const crtPath = pfxPath ? null : await path(input.crtPath, existing?.crtPath, 'certificate file')
      const keyPath = pfxPath ? null : await path(input.keyPath, existing?.keyPath, 'key file')
      if (!pfxPath && !(crtPath && keyPath)) fail('invalid_input', 'Choose a certificate file and its key file, or a PFX file')
      const hasPassphrase = input.passphrase === null || input.passphrase === '' ? false : input.passphrase !== undefined ? true : (existing?.hasPassphrase ?? false)
      const cert = { id: existing?.id ?? uuid(), host, port, crtPath, keyPath, pfxPath, hasPassphrase }
      s.clientCertificates = existing ? s.clientCertificates.map((c) => (c.id === cert.id ? cert : c)) : [...s.clientCertificates, cert]
      return out()
    },
    async removeNetworkClientCertificate(id) {
      if (!s.clientCertificates.some((c) => c.id === id)) fail('not_found', 'client certificate not found', { id })
      s.clientCertificates = s.clientCertificates.filter((c) => c.id !== id)
      return out()
    },
  }
  return { api, controls: { reset: () => (s = defaults()) } }
}
