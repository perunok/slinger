import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceFlow } from './deviceFlow.svelte'

const info = { device_code: 'dc', user_code: 'ABCD', verification_uri: 'https://v', expires_in: 20, interval: 2 }

function make(poll = vi.fn()) {
  const onApproved = vi.fn(async () => undefined)
  const flow = new DeviceFlow({ start: async () => info, poll, onApproved })
  return { flow, poll, onApproved }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DeviceFlow', () => {
  it('polls at the interval until approved', async () => {
    const { flow, poll, onApproved } = make(
      vi.fn().mockResolvedValueOnce({ status: 'pending' }).mockResolvedValueOnce({ status: 'approved', access_token: 'a', refresh_token: 'r' }),
    )
    await flow.begin()
    expect(flow.phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(2000)
    expect(poll).toHaveBeenCalledTimes(1)
    expect(flow.remaining).toBe(18)
    await vi.advanceTimersByTimeAsync(2000)
    expect(flow.phase).toBe('approved')
    expect(onApproved).toHaveBeenCalledWith({ accessToken: 'a', refreshToken: 'r' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(poll).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires at the deadline', async () => {
    const { flow } = make(vi.fn().mockResolvedValue({ status: 'pending' }))
    await flow.begin()
    await vi.advanceTimersByTimeAsync(21000)
    expect(flow.phase).toBe('expired')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancel and dispose stop all timers', async () => {
    const { flow, poll } = make(vi.fn().mockResolvedValue({ status: 'pending' }))
    await flow.begin()
    flow.cancel()
    expect(flow.phase).toBe('cancelled')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10000)
    expect(poll).not.toHaveBeenCalled()
    await flow.begin()
    flow.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
