import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearTokens, loadTokens, saveTokens } from './session'
import { installFakeSlinger } from './testUtils'

afterEach(() => vi.restoreAllMocks())

describe('session store', () => {
  it('keeps tokens in the secure store, never localStorage', async () => {
    const { fake } = installFakeSlinger()
    const set = vi.spyOn(Storage.prototype, 'setItem')
    await saveTokens('https://x.test', { accessToken: 'a', refreshToken: 'r' })
    expect(set).not.toHaveBeenCalled()
    expect(fake.secureStoreSet).toHaveBeenCalledOnce()
    expect(await loadTokens('https://x.test/')).toEqual({ accessToken: 'a', refreshToken: 'r' })
    await clearTokens('https://x.test')
    expect(await loadTokens('https://x.test')).toBeNull()
  })
})
