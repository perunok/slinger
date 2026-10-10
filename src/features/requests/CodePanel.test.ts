import { render, screen } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { newMcpDraft, newMcpRequestDraft } from '../../lib/mcpRequest'
import { newDraft } from '../../lib/request'
import CodePanel from './CodePanel.svelte'
import { tabsStore } from './tabs.svelte'

beforeEach(async () => {
  localStorage.clear()
  const backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  await app.init()
})


describe('CodePanel', () => {
  it('offers the HTTP languages for an HTTP request', () => {
    render(CodePanel, { tab: tabsStore.newTab({ draft: newDraft({ name: 'H', url: 'https://api.example.com/x' }) }) })
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
    expect(screen.queryByText('MCP Inspector CLI')).toBeNull()
    expect(document.body).toHaveTextContent("curl 'https://api.example.com/x'")
  })

  it('shows only the MCP Inspector CLI command for an MCP request', () => {
    const draft = { ...newMcpRequestDraft('Weather'), url: 'https://mcp.example.com/mcp', mcp: newMcpDraft({ tool: 'echo', arguments: '{"text":"hi"}' }) }
    render(CodePanel, { tab: tabsStore.newTab({ draft }) })
    expect(screen.queryByLabelText('Language')).toBeNull()
    expect(screen.getByTestId('snippet-mcp-lang')).toHaveTextContent('MCP Inspector CLI')
    expect(document.body).toHaveTextContent('npx @modelcontextprotocol/inspector --cli https://mcp.example.com/mcp')
    expect(document.body).toHaveTextContent('--tool-arg text=hi')
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
  })

  it('explains what is missing instead of a snippet', () => {
    const draft = { ...newMcpRequestDraft('Local'), mcp: newMcpDraft({ transport: 'stdio' }) }
    render(CodePanel, { tab: tabsStore.newTab({ draft }) })
    expect(screen.getByText('Enter the command that starts the MCP server.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy/i })).toBeDisabled()
  })
})
