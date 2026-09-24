import { vi } from 'vitest'
import type { HttpResponseData } from '../../../shared/types'

export function res(status: number, body?: unknown): HttpResponseData {
  return {
    status,
    statusText: '',
    durationMs: 0,
    headers: [],
    bodyText: body === undefined ? null : JSON.stringify(body),
    bodyBase64: null,
    bodyByteLength: 0,
  }
}

/** Minimal window.slinger fake with an in-memory secure store. */
export function installFakeSlinger(exec = vi.fn()) {
  const store = new Map<string, string>()
  const fake = {
    executeHttpRequest: exec,
    secureStoreGet: vi.fn(async (k: string) => store.get(k) ?? null),
    secureStoreSet: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    secureStoreDelete: vi.fn(async (k: string) => void store.delete(k)),
    openExternalUrl: vi.fn(async () => undefined),
  }
  ;(window as unknown as { slinger: unknown }).slinger = fake
  return { fake, store, exec }
}
