/** Token store. Tokens live ONLY in the OS keychain via secureStore*; never localStorage. */
import { api } from '../../lib/ipc'
import type { Tokens } from './types'

const key = (baseUrl: string) => `slinger.cloud.tokens:${baseUrl.trim().replace(/\/+$/, '')}`

export async function loadTokens(baseUrl: string): Promise<Tokens | null> {
  const raw = await api().secureStoreGet(key(baseUrl))
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as Partial<Tokens>
    return t.accessToken && t.refreshToken ? { accessToken: t.accessToken, refreshToken: t.refreshToken } : null
  } catch {
    return null
  }
}

export function saveTokens(baseUrl: string, tokens: Tokens): Promise<void> {
  return api().secureStoreSet(key(baseUrl), JSON.stringify(tokens))
}

export function clearTokens(baseUrl: string): Promise<void> {
  return api().secureStoreDelete(key(baseUrl))
}
