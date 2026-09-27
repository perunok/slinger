/**
 * Component tests: the OAuth 2.0 part of the Authorization tab against the browser mock backend (tokens simulated).
 */
import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { parseDocument, serializeDraft } from '../../lib/request'
import AuthPanel from '../requests/AuthPanel.svelte'
import { tabsStore } from '../requests/tabs.svelte'

let backend: ReturnType<typeof createMockBackend>
beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  toast.clear()
  await app.init()
  await app.setActiveEnvironment(app.environments.find((e) => e.name === 'Local')!.id)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const editorOf = (label: string) => EditorView.findFromDOM(screen.getByRole('textbox', { name: label }).closest('.cm-editor') as HTMLElement)!
const typeInto = (label: string, text: string) => {
  const v = editorOf(label)
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
}

function openOAuthTab(over: Record<string, string> = {}) {
  const tab = tabsStore.openRequest(app.requests.find((r) => r.name === 'Get user')!)
  tab.draft.auth.kind = 'oauth2'
  Object.assign(tab.draft.auth.oauth2, {
    grantType: 'client_credentials',
    accessTokenUrl: '{{baseUrl}}/token',
    clientId: 'app',
    clientSecret: '{{apiToken}}',
    ...over,
  })
  return tab
}

describe('OAuth 2.0 panel', () => {
  it('is offered as an auth type and shows the fields of the chosen grant', async () => {
    const tab = tabsStore.openRequest(app.requests.find((r) => r.name === 'Get user')!)
    render(AuthPanel, { tab })
    await fireEvent.change(screen.getByLabelText('Authorization type'), { target: { value: 'oauth2' } })
    expect(tab.draft.auth.kind).toBe('oauth2')
    // Default grant: authorization code with PKCE.
    expect(screen.getByRole('textbox', { name: 'Auth URL' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Redirect URI' })).toBeInTheDocument()
    await fireEvent.change(screen.getByLabelText('Grant type'), { target: { value: 'password_credentials' } })
    expect(tab.draft.auth.oauth2.grantType).toBe('password_credentials')
    expect(screen.queryByRole('textbox', { name: 'Auth URL' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Username' })).toBeInTheDocument()
    typeInto('Client ID', 'my-client')
    expect(tab.draft.auth.oauth2.clientId).toBe('my-client')
    expect(screen.getByText(/only in your OS keychain/)).toBeInTheDocument()
  })

  it('gets a token (resolving variables and revealing only needed secrets), then reveals, refreshes and clears it', async () => {
    const tab = openOAuthTab()
    const reveal = vi.spyOn(backend, 'revealEnvironmentVariable')
    const get = vi.spyOn(backend, 'getOAuth2Token')
    render(AuthPanel, { tab })
    await waitFor(() => expect(screen.getByTestId('oauth2-status')).toHaveTextContent('No access token yet.'))
    expect(reveal).not.toHaveBeenCalled() // the status lookup needs no secret

    await fireEvent.click(screen.getByRole('button', { name: 'Get New Access Token' }))
    await waitFor(() => expect(screen.getByTestId('oauth2-status')).toHaveTextContent(/Valid until .*refreshable/))
    expect(get.mock.calls[0]![0]).toMatchObject({ accessTokenUrl: 'https://mock.slinger.local/token', clientSecret: 'sk_live_demo_123', grantType: 'client_credentials' })
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(toast.items.some((t) => t.title === 'Access token received')).toBe(true)
    // Nothing about the token went into the request document.
    const tokenKey = (await backend.getOAuth2TokenStatus(get.mock.calls[0]![0])).tokenKey
    const token = await backend.revealOAuth2Token(tokenKey)
    expect(serializeDraft(tab.draft).documentJson).not.toContain(token)
    expect(screen.getByTestId('oauth2-status')).not.toHaveTextContent(token)

    await fireEvent.click(screen.getByRole('button', { name: 'Reveal' }))
    await waitFor(() => expect(screen.getByTestId('oauth2-revealed')).toHaveValue(token))
    await fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByTestId('oauth2-revealed')).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(toast.items.some((t) => t.title === 'Access token refreshed')).toBe(true))
    expect(await backend.revealOAuth2Token(tokenKey)).not.toBe(token)

    await fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    await waitFor(() => expect(screen.getByTestId('oauth2-status')).toHaveTextContent('No access token yet.'))
  })

  it('shows token errors inline and unresolved variables before asking main', async () => {
    const tab = openOAuthTab({ clientSecret: 'wrong' })
    render(AuthPanel, { tab })
    await fireEvent.click(screen.getByRole('button', { name: 'Get New Access Token' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('invalid_client'))

    tab.draft.auth.oauth2.accessTokenUrl = '{{nope}}/token'
    const get = vi.spyOn(backend, 'getOAuth2Token')
    await fireEvent.click(screen.getByRole('button', { name: 'Get New Access Token' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('{{nope}}'))
    expect(get).not.toHaveBeenCalled()
  })

  it('can cancel a browser sign-in', async () => {
    backend.setLatency(1)
    const tab = openOAuthTab({ grantType: 'authorization_code_with_pkce', authUrl: '{{baseUrl}}/authorize' })
    render(AuthPanel, { tab })
    await fireEvent.click(screen.getByRole('button', { name: 'Get New Access Token' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Waiting for you to sign in'))
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('oauth2-status')).toHaveTextContent('No access token yet.')
  })

  it('explains that the implicit grant is not supported and keeps its settings', () => {
    const r = app.requests.find((x) => x.name === 'Get user')!
    const documentJson = JSON.stringify({ ...JSON.parse(r.documentJson), auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'implicit' }, { key: 'clientId', value: 'c' }] } })
    const tab = tabsStore.openRequest({ ...r, documentJson })
    render(AuthPanel, { tab })
    expect(screen.getByTestId('oauth2-unsupported')).toHaveTextContent('Authorization Code (With PKCE)')
    expect(screen.queryByRole('button', { name: 'Get New Access Token' })).toBeNull()
    expect(parseDocument({ ...r, documentJson: serializeDraft(tab.draft).documentJson }).auth.oauth2).toMatchObject({ grantType: 'implicit', clientId: 'c' })
  })
})
