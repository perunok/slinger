import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/svelte'
import { ui } from '../../app/ui.svelte'
import { app } from '../../app/state.svelte'
import { cloud } from './cloudStore.svelte'
import { saveTokens } from './session'
import CloudDialog from './CloudDialog.svelte'
import { installFakeSlinger, res } from './testUtils'

let exec: ReturnType<typeof vi.fn>
beforeEach(() => {
  localStorage.clear()
  exec = vi.fn()
  installFakeSlinger(exec)
  app.workspaces = [{ id: 'w1', name: 'Local WS' } as never]
  app.workspaceId = 'w1'
  ui.cloudOpen = true
})

describe('CloudDialog', () => {
  it('signed out: shows base URL field and sign-in button', async () => {
    render(CloudDialog)
    expect(await screen.findByLabelText('API base URL')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('signed in: shows user and workspaces', async () => {
    await saveTokens(cloud.config.apiBaseUrl, { accessToken: 'a', refreshToken: 'r' })
    exec
      .mockResolvedValueOnce(res(200, { user: { id: '1', email: 'me@x.io' } }))
      .mockResolvedValueOnce(res(200, { items: [{ id: 'r1', name: 'Remote One' }] }))
    render(CloudDialog)
    expect(await screen.findByText('me@x.io')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Remote One')).toBeInTheDocument())
    expect(screen.getByText('Not linked')).toBeInTheDocument()
    expect(screen.getByText(/not available yet/)).toBeInTheDocument()
  })
})
