import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudApiError } from './types'
import { CloudClient } from './client'
import { joinUrl } from './endpoints'
import { saveTokens, loadTokens } from './session'
import { installFakeSlinger, res } from './testUtils'

const BASE = 'https://x.test/'
let exec: ReturnType<typeof vi.fn>
let signedOut: ReturnType<typeof vi.fn>
let client: CloudClient

beforeEach(async () => {
  exec = vi.fn()
  installFakeSlinger(exec)
  signedOut = vi.fn()
  client = new CloudClient({ baseUrl: BASE, workspaceId: 'w1', onSignedOut: signedOut })
  await saveTokens(BASE, { accessToken: 'A1', refreshToken: 'R1' })
})

const sentAuth = (i: number) =>
  (exec.mock.calls[i][0].headers as { key: string; value: string }[]).find((h) => h.key === 'Authorization')?.value

describe('CloudClient', () => {
  it('joins urls regardless of slashes', () => {
    expect(joinUrl('https://a.b//', '/v1/x')).toBe('https://a.b/v1/x')
    expect(joinUrl('https://a.b', 'v1/x')).toBe('https://a.b/v1/x')
  })

  it('parses success and sends bearer + normalized url', async () => {
    exec.mockResolvedValueOnce(res(200, { user: { id: '1', email: 'a@b.c' } }))
    expect((await client.me()).email).toBe('a@b.c')
    expect(exec.mock.calls[0][0].url).toBe('https://x.test/v1/me')
    expect(sentAuth(0)).toBe('Bearer A1')
  })

  it('maps non-2xx to CloudApiError', async () => {
    exec.mockResolvedValueOnce(res(409, { error: { code: 'slug_taken', message: 'Slug taken' } }))
    await expect(client.createWorkspace('n')).rejects.toMatchObject({ status: 409, code: 'slug_taken', message: 'Slug taken' })
  })

  it('refreshes once on 401 and retries', async () => {
    exec
      .mockResolvedValueOnce(res(401, { error: 'expired' }))
      .mockResolvedValueOnce(res(200, { access_token: 'A2', refresh_token: 'R2' }))
      .mockResolvedValueOnce(res(200, { items: [{ id: 'r', name: 'R' }] }))
    expect(await client.listWorkspaces()).toHaveLength(1)
    expect(sentAuth(2)).toBe('Bearer A2')
    expect(await loadTokens(BASE)).toEqual({ accessToken: 'A2', refreshToken: 'R2' })
  })

  it('does not loop: second 401 after refresh throws', async () => {
    exec
      .mockResolvedValueOnce(res(401))
      .mockResolvedValueOnce(res(200, { access_token: 'A2', refresh_token: 'R2' }))
      .mockResolvedValueOnce(res(401))
    await expect(client.me()).rejects.toBeInstanceOf(CloudApiError)
    expect(exec).toHaveBeenCalledTimes(3)
  })

  it('signs out when refresh fails', async () => {
    exec.mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(401, { error: 'bad refresh' }))
    await expect(client.me()).rejects.toMatchObject({ status: 401 })
    expect(signedOut).toHaveBeenCalled()
    expect(await loadTokens(BASE)).toBeNull()
  })

  it('wraps transport failures', async () => {
    exec.mockRejectedValueOnce(new Error('boom'))
    await expect(client.me()).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })
})
