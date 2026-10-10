import { render, screen } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../../app/state.svelte'
import { createMockBackend } from '../../../dev/mockBackend'
import { newMcpDraft, newMcpRequestDraft } from '../../../lib/mcpRequest'
import { tabsStore } from '../../requests/tabs.svelte'
import InfoView from './InfoView.svelte'

beforeEach(async () => {
  localStorage.clear()
  const backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
})

describe('InfoView of an MCP request', () => {
  it('shows the transport and the server URL', () => {
    const draft = { ...newMcpRequestDraft('Weather'), url: '{{base}}/mcp' }
    render(InfoView, { tab: tabsStore.newTab({ draft }) })
    const info = screen.getByTestId('panel-info')
    expect(info).toHaveTextContent(/Method\s*MCP/)
    expect(info).toHaveTextContent(/Transport\s*Streamable HTTP/)
    expect(info).toHaveTextContent(/Server\s*\{\{base\}\}\/mcp/)
    expect(info).not.toHaveTextContent(/URL/)
  })

  it('shows the command line of a stdio server', () => {
    const draft = { ...newMcpRequestDraft('Local'), mcp: newMcpDraft({ transport: 'stdio', command: 'node', args: ['server.mjs', '--demo'] }) }
    render(InfoView, { tab: tabsStore.newTab({ draft }) })
    const info = screen.getByTestId('panel-info')
    expect(info).toHaveTextContent(/Transport\s*Command \(stdio\)/)
    expect(info).toHaveTextContent(/Command\s*node server\.mjs --demo/)
  })
})
