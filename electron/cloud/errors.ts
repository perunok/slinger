/** Failure of a cloud API call. `kind: 'network'` = no HTTP answer (offline, DNS, timeout). */
export class CloudApiError extends Error {
  readonly kind: 'network' | 'http'
  readonly status: number
  readonly code: string
  readonly retryAfterMs: number | null
  readonly details: Record<string, unknown> | undefined

  constructor(init: { kind: 'network' | 'http'; status: number; code: string; message: string; retryAfterMs?: number | null; details?: Record<string, unknown> }) {
    super(init.message)
    this.name = 'CloudApiError'
    this.kind = init.kind
    this.status = init.status
    this.code = init.code
    this.retryAfterMs = init.retryAfterMs ?? null
    this.details = init.details
  }

  get isNetwork(): boolean {
    return this.kind === 'network'
  }
  get isTransient(): boolean {
    return this.kind === 'network' || this.status >= 500 || this.status === 429 || this.status === 408
  }
}

export const isCloudApiError = (e: unknown): e is CloudApiError => e instanceof CloudApiError

/** The server speaks an older sync protocol than this app needs (design S11). */
export class ServerUnsupportedError extends Error {
  constructor(message = 'This Slinger cloud server is too old for collection sync. Ask its administrator to update it.') {
    super(message)
    this.name = 'ServerUnsupportedError'
  }
}
