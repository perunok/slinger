/** App shell routing: which editor the active tab gets. */
import { render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend } from '../dev/mockBackend'
import { newMcpRequestDraft } from '../lib/mcpRequest'
import { newDraft } from '../lib/request'
import { tabsStore } from '../features/requests/tabs.svelte'
import App from './App.svelte'
import { app } from './state.svelte'

beforeEach(async () => {
  localStorage.clear()
  const backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
})

describe('App routing', () => {
  it('an MCP draft gets the MCP editor, an HTTP draft the request editor', async () => {
    render(App)
    tabsStore.newTab({ draft: newMcpRequestDraft('Demo') })
    expect(await screen.findByRole('group', { name: 'MCP server' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Transport' })).toBeInTheDocument()

    tabsStore.newTab({ draft: newDraft({ url: 'https://api.test' }) })
    await waitFor(() => expect(screen.queryByRole('group', { name: 'MCP server' })).toBeNull())
    expect(screen.getByRole('button', { name: /^Send/ })).toBeInTheDocument()

    // The MCP tab shows its badge in the tab strip.
    const tablist = screen.getByRole('tablist', { name: 'Open requests' })
    expect(tablist).toHaveTextContent(/MCP\s*Demo/)
  })
})
