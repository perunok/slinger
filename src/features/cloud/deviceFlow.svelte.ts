import { errorInfo } from '../../lib/ipc'
/** Device-authorization polling state machine. One 1s timer; fully stopped on cancel/dispose. */
import { CloudApiError, type DevicePollResponse, type DeviceStartResponse, type Tokens } from './types'

export type DevicePhase = 'idle' | 'starting' | 'waiting' | 'approved' | 'expired' | 'denied' | 'cancelled' | 'error'

export interface DeviceFlowDeps {
  start: () => Promise<DeviceStartResponse>
  poll: (deviceCode: string) => Promise<DevicePollResponse>
  onApproved: (tokens: Tokens) => Promise<void>
}

export class DeviceFlow {
  phase = $state<DevicePhase>('idle')
  info = $state<DeviceStartResponse | null>(null)
  remaining = $state(0)
  error = $state<string | null>(null)
  #timer: ReturnType<typeof setInterval> | null = null
  #run = 0
  #deadline = 0
  #lastPoll = 0
  #interval = 5
  #polling = false

  constructor(private readonly deps: DeviceFlowDeps) {}

  get active() {
    return this.phase === 'starting' || this.phase === 'waiting'
  }

  async begin() {
    if (this.active) return
    const run = ++this.#run
    this.phase = 'starting'
    this.error = null
    this.info = null
    try {
      const info = await this.deps.start()
      if (run !== this.#run) return
      this.info = info
      this.#interval = Math.max(1, info.interval || 5)
      this.#deadline = Date.now() + info.expires_in * 1000
      this.#lastPoll = Date.now()
      this.remaining = info.expires_in
      this.phase = 'waiting'
      this.#timer = setInterval(() => void this.#tick(run), 1000)
    } catch (e) {
      if (run !== this.#run) return
      this.#fail(e)
    }
  }

  cancel() {
    if (!this.active) return
    this.#stop()
    this.phase = 'cancelled'
  }

  /** Stop all timers without changing the visible phase (component teardown). */
  dispose() {
    this.#stop()
  }

  #stop() {
    this.#run++
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.#polling = false
  }

  #fail(e: unknown) {
    this.#stop()
    this.phase = 'error'
    this.error = errorInfo(e).message
  }

  async #tick(run: number) {
    if (run !== this.#run || this.phase !== 'waiting') return
    const left = Math.ceil((this.#deadline - Date.now()) / 1000)
    this.remaining = Math.max(0, left)
    if (left <= 0) {
      this.#stop()
      this.phase = 'expired'
      return
    }
    if (this.#polling || Date.now() - this.#lastPoll < this.#interval * 1000) return
    this.#polling = true
    this.#lastPoll = Date.now()
    try {
      const res = await this.deps.poll(this.info!.device_code)
      if (run !== this.#run) return
      if (res.status === 'approved') {
        this.#stop()
        this.phase = 'approved'
        try {
          await this.deps.onApproved({ accessToken: res.access_token, refreshToken: res.refresh_token })
        } catch (e) {
          this.phase = 'error'
          this.error = errorInfo(e).message
        }
      } else if (res.status === 'expired' || res.status === 'denied') {
        this.#stop()
        this.phase = res.status
      }
    } catch (e) {
      if (run !== this.#run) return
      const code = e instanceof CloudApiError ? e.code : undefined
      if (code === 'slow_down') this.#interval += 5
      else if (code === 'expired_token') {
        this.#stop()
        this.phase = 'expired'
      } else if (code === 'access_denied') {
        this.#stop()
        this.phase = 'denied'
      } else if (code !== 'authorization_pending' && !(e instanceof CloudApiError && e.status === 0)) this.#fail(e)
      // network hiccups and "pending" style errors: keep polling until the deadline
    } finally {
      if (run === this.#run) this.#polling = false
    }
  }
}
