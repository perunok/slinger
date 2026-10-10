/**
 * Component tests of the MCP request editor (McpRequestView + McpBar, McpCallPanel, McpConnectionPanel, McpServerPanel,
 * McpTrustDialog) against the mock backend's Demo MCP server, plus the pure helpers those components export.
 */
import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { dataRows, newRow } from '../../lib/kv'
import { newMcpRequestDraft, type McpDraft } from '../../lib/mcpRequest'
import { tabsStore, type RequestTab } from '../requests/tabs.svelte'
import { mcpConnections } from './connections.svelte'
import { formatArgs, splitArgs } from './McpBar.svelte'
import { argumentsForTool, expandTemplate, matchTemplate, templateVars } from './McpCallPanel.svelte'
import McpRequestView, { mcpResultViewOf, mcpSectionOf, tabResultViewOf, tabSectionOf } from './McpRequestView.svelte'

let backend: ReturnType<typeof createMockBackend>
beforeEach(async () => {
  localStorage.clear()
  await mcpConnections.reset()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  toast.clear()
  await app.init()
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await mcpConnections.reset()
})

const editorOf = (name: string | RegExp) => EditorView.findFromDOM(screen.getByRole('textbox', { name }).closest('.cm-editor') as HTMLElement)!
const typeInto = (name: string | RegExp, text: string) => {
  const v = editorOf(name)
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
}
const mcpOf = (tab: RequestTab) => tab.draft.mcp as McpDraft

function openMcp(init: (draft: ReturnType<typeof newMcpRequestDraft>) => void = () => {}): RequestTab {
  const draft = newMcpRequestDraft('Weather')
  draft.url = 'https://demo.example/mcp'
  init(draft)
  const tab = tabsStore.newTab({ draft })
  render(McpRequestView, { tab })
  return tab
}

async function connect() {
  await fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await waitFor(() => expect(screen.getByRole('img', { name: 'Connected' })).toBeInTheDocument())
  const list = screen.getByTestId('mcp-capability-list')
  await waitFor(() => expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0))
  return list
}

describe('McpRequestView', () => {
  it('renders an MCP draft: name, transport, server URL, the Call section and an empty result', () => {
    openMcp()
    expect(screen.getByRole('textbox', { name: 'Request name' })).toHaveValue('Weather')
    expect(screen.getByRole('combobox', { name: 'Transport' })).toHaveValue('http')
    expect(editorOf('Server URL').state.doc.toString()).toBe('https://demo.example/mcp')
    expect(screen.getByRole('tab', { name: 'Call' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('img', { name: 'Not connected' })).toBeInTheDocument()
    expect(screen.getByTestId('mcp-list-empty')).toHaveTextContent('Connect to see what the server offers.')
    expect(screen.getByRole('button', { name: /Run/ })).toBeInTheDocument()
    // No HTTP-only controls.
    expect(screen.queryByRole('combobox', { name: 'HTTP method' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Body' })).toBeNull()
  })

  it('edits mark the tab dirty and the server URL lands in the draft', async () => {
    const tab = openMcp()
    typeInto('Server URL', 'https://{{host}}/mcp')
    expect(tab.draft.url).toBe('https://{{host}}/mcp')
    expect(tab.dirty).toBe(true)
  })

  it('switching the transport to a command shows command and arguments, and the environment in Connection', async () => {
    const tab = openMcp()
    await fireEvent.change(screen.getByRole('combobox', { name: 'Transport' }), { target: { value: 'stdio' } })
    expect(mcpOf(tab).transport).toBe('stdio')
    expect(screen.queryByRole('textbox', { name: 'Server URL' })).toBeNull()
    typeInto('Command', 'npx')
    typeInto('Arguments', '-y "my server" {{flag}}')
    expect(mcpOf(tab).command).toBe('npx')
    expect(mcpOf(tab).args).toEqual(['-y', 'my server', '{{flag}}'])

    await fireEvent.click(screen.getByRole('tab', { name: 'Connection' }))
    expect(tab.section).toBe('headers')
    expect(screen.getByRole('textbox', { name: 'Working directory' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Authorization type' })).toBeNull()

    await fireEvent.change(screen.getByRole('combobox', { name: 'Transport' }), { target: { value: 'sse' } })
    expect(mcpOf(tab).transport).toBe('sse')
    expect(screen.getByRole('combobox', { name: 'Authorization type' })).toBeInTheDocument()
  })

  it('Connect lists what the server offers, with counts, and shows the server info', async () => {
    openMcp()
    const list = await connect()
    expect(within(list).getByRole('button', { name: /get_weather|Get weather/i })).toBeInTheDocument()
    expect(screen.getByTestId('mcp-' + tabsStore.tabs[0].id + '-kind-tools-badge').textContent).toMatch(/^\d+$/)

    await fireEvent.click(within(list).getByRole('tab', { name: /Prompts/ }))
    expect(within(list).getByRole('button', { name: /greet/i })).toBeInTheDocument()

    await fireEvent.click(screen.getByRole('tab', { name: /^Server/ }))
    expect(screen.getByTestId('mcp-server-name')).toHaveTextContent('demo-mcp-server')
    expect(screen.getByTestId('mcp-server-capabilities')).toHaveTextContent('tools')

    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    await waitFor(() => expect(screen.getByRole('img', { name: 'Not connected' })).toBeInTheDocument())
    expect(screen.getByTestId('mcp-server-empty')).toBeInTheDocument()
  })

  it('reloads a list when the server says it changed', async () => {
    openMcp()
    await connect()
    const list = vi.spyOn(backend, 'mcpClientList')
    backend.mcpClient.notify('notifications/prompts/list_changed')
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.any(String), 'prompts'))
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('closing the tab closes its connection; switching away keeps it', async () => {
    const tab = openMcp()
    await connect()
    const key = `tab:${tab.id}`
    cleanup() // another tab became active: the view unmounts, the tab stays
    await Promise.resolve()
    expect(mcpConnections.isConnected(key)).toBe(true)

    render(McpRequestView, { tab })
    tabsStore.closeNow([tab.id])
    cleanup()
    await waitFor(() => expect(mcpConnections.isConnected(key)).toBe(false))
    await waitFor(() => expect(backend.mcpClient.sessions()).toEqual([]))
  })

  it('a connect failure shows why', async () => {
    openMcp((d) => (d.url = 'https://down.invalid/mcp'))
    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(screen.getByTestId('mcp-connect-error')).toHaveTextContent(/Could not connect/))
    expect(screen.getByRole('img', { name: 'Connection failed' })).toBeInTheDocument()
  })

  it('selecting a tool sets the operation and tool and shows its form; prompts and templates fill their fields', async () => {
    const tab = openMcp((d) => {
      d.mcp!.operation = 'prompts/get'
      d.mcp!.prompt = 'greet'
    })
    const list = await connect()
    await fireEvent.click(within(list).getByRole('tab', { name: /Tools/ }))
    await fireEvent.click(within(list).getByRole('button', { name: /get_weather|Get weather/i }))
    expect(mcpOf(tab).operation).toBe('tools/call')
    expect(mcpOf(tab).tool).toBe('get_weather')
    expect(screen.getByRole('textbox', { name: 'Tool' })).toHaveValue('get_weather')
    expect(within(screen.getByTestId('mcp-selected')).getByRole('heading')).toBeInTheDocument()
    // The JSON toggle swaps the generated form for the raw arguments.
    await fireEvent.click(screen.getByRole('button', { name: 'JSON' }))
    expect(editorOf('Tool arguments (JSON)').state.doc.toString()).toBe(mcpOf(tab).arguments)

    await fireEvent.click(within(list).getByRole('tab', { name: /Prompts/ }))
    await fireEvent.click(within(list).getByRole('button', { name: /greet/i }))
    expect(mcpOf(tab).operation).toBe('prompts/get')
    expect(mcpOf(tab).prompt).toBe('greet')
    expect(dataRows(mcpOf(tab).promptArguments).map((r) => r.key)).toContain('name')

    await fireEvent.click(within(list).getByRole('tab', { name: /Templates/ }))
    await fireEvent.click(within(list).getByRole('button', { name: /users/i }))
    expect(mcpOf(tab).operation).toBe('resources/read')
    typeInto('id', '{{userId}}')
    expect(mcpOf(tab).uri).toBe('demo://users/{{userId}}')
    expect(tab.dirty).toBe(true)
  })

  it('clicking another tool keeps the arguments typed so far', async () => {
    const tab = openMcp((d) => {
      d.mcp!.tool = 'echo'
      d.mcp!.arguments = '{"text": "keep me"}'
    })
    const list = await connect()
    await fireEvent.click(within(list).getByRole('button', { name: /get_weather|Get weather/i }))
    expect(mcpOf(tab).tool).toBe('get_weather')
    expect(mcpOf(tab).arguments).toBe('{"text": "keep me"}')
    await fireEvent.click(within(list).getByRole('button', { name: /^echo/i }))
    expect(mcpOf(tab).arguments).toBe('{"text": "keep me"}')
  })

  it('a list the server fails to give does not hide the others', async () => {
    const real = backend.mcpClientList.bind(backend)
    vi.spyOn(backend, 'mcpClientList').mockImplementation(async (id, kind) => {
      if (kind === 'resourceTemplates') throw { name: 'IpcError', code: 'network_error', message: 'Method not found' }
      return real(id, kind)
    })
    openMcp()
    const list = await connect()
    expect(within(list).getByRole('button', { name: /get_weather|Get weather/i })).toBeInTheDocument()
    expect(screen.getByTestId('mcp-list-error')).toHaveTextContent('Templates: Method not found')
  })

  it('a Run that fails after one that worked shows the new error with its JSON-RPC code', async () => {
    const tab = openMcp((d) => {
      d.mcp!.tool = 'echo'
      d.mcp!.arguments = '{"text": "first"}'
    })
    await fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => expect(screen.getByTestId('mcp-status-chip')).toHaveTextContent('OK'))
    mcpOf(tab).operation = 'resources/read'
    mcpOf(tab).uri = 'demo://nope'
    await fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => expect(screen.getByTestId('mcp-status-chip')).toHaveTextContent('Error'))
    const alert = screen.getByTestId('mcp-error')
    expect(alert).toHaveTextContent('The server returned an error')
    expect(alert).toHaveTextContent('Resource demo://nope not found')
    expect(alert).toHaveTextContent('JSON-RPC error -32602')
  })

  it('Run is the tab send (button and Ctrl+Enter)', async () => {
    const tab = openMcp()
    const send = vi.spyOn(tabsStore, 'send').mockResolvedValue(null)
    await fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    expect(send).toHaveBeenCalledWith(tab)
    await fireEvent.keyDown(screen.getByRole('textbox', { name: 'Request name' }), { key: 'Enter', ctrlKey: true })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('runs the selected tool and shows the result', async () => {
    const tab = openMcp((d) => {
      d.mcp!.tool = 'echo'
      d.mcp!.arguments = '{"text": "hello from the test"}'
    })
    await fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    await waitFor(() => expect(tab.response?.data.mcp?.ok).toBe(true))
    expect(tab.response!.data.bodyText).toContain('hello from the test')
  })

  it('a command that is not allowed yet asks first; Allow records it and connects', async () => {
    const tab = openMcp((d) => {
      d.mcp!.transport = 'stdio'
      d.mcp!.command = 'node'
      d.mcp!.args = ['server.js', '--port', '1']
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const dialog = await screen.findByRole('dialog', { name: /Allow Slinger to run this command/ })
    expect(within(dialog).getByTestId('trust-command')).toHaveTextContent('node')
    expect(within(dialog).getByTestId('trust-args')).toHaveTextContent('server.js--port1')
    expect(within(dialog).getByTestId('trust-cwd')).toHaveTextContent('your home directory')
    // Cancel: nothing is allowed.
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(backend.mcpClient.trusted()).toEqual([])

    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Allow and connect' }))
    await waitFor(() => expect(screen.getByRole('img', { name: 'Connected' })).toBeInTheDocument())
    expect(backend.mcpClient.trusted()).toMatchObject([{ command: 'node', args: ['server.js', '--port', '1'], cwd: '', env: [] }])
    expect(mcpConnections.isConnected(`tab:${tab.id}`)).toBe(true)
  })

  it('the Allow dialog lists the environment (secret values hidden) and allows exactly it', async () => {
    await app.setActiveEnvironment(app.environments.find((e) => e.name === 'Local')!.id)
    const tab = openMcp((d) => {
      d.mcp!.transport = 'stdio'
      d.mcp!.command = 'node'
      d.mcp!.args = ['server.js']
      d.mcp!.env = [newRow({ key: 'DEBUG', value: '1' }), newRow({ key: 'TOKEN', value: '{{apiToken}}' })]
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    const dialog = await screen.findByRole('dialog', { name: /Allow Slinger/ })
    const env = within(dialog).getByTestId('trust-env')
    expect(env).toHaveTextContent('DEBUG=1')
    expect(env).toHaveTextContent('TOKEN=')
    expect(env).not.toHaveTextContent('sk_live_demo_123')
    expect(dialog).toHaveTextContent('environment variables change')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Allow and connect' }))
    await waitFor(() => expect(mcpConnections.isConnected(`tab:${tab.id}`)).toBe(true))
    expect(backend.mcpClient.trusted()).toMatchObject([
      { command: 'node', env: [{ key: 'DEBUG', value: '1' }, { key: 'TOKEN', value: 'sk_live_demo_123' }] },
    ])

    // A new environment variable is a new command: asked again.
    await fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
    mcpOf(tab).env = [...mcpOf(tab).env, newRow({ key: 'NODE_OPTIONS', value: '--require=./evil.js' })]
    await fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(within(await screen.findByRole('dialog', { name: /Allow Slinger/ })).getByTestId('trust-env')).toHaveTextContent('NODE_OPTIONS=--require=./evil.js')
  })

  it('a Run refused for an unallowed command asks too, then runs again', async () => {
    const tab = openMcp((d) => {
      d.mcp!.transport = 'stdio'
      d.mcp!.command = 'demo-server'
      d.mcp!.tool = 'echo'
      d.mcp!.arguments = '{"text": "hi"}'
    })
    const send = vi.spyOn(tabsStore, 'send')
    await fireEvent.click(screen.getByRole('button', { name: /Run/ }))
    const dialog = await screen.findByRole('dialog', { name: /Allow Slinger/ })
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Allow and connect' }))
    await waitFor(() => expect(tab.response?.data.mcp?.ok).toBe(true))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('a send started outside the editor (the global Ctrl+Enter) asks too', async () => {
    const tab = openMcp((d) => {
      d.mcp!.transport = 'stdio'
      d.mcp!.command = 'demo-server'
      d.mcp!.tool = 'echo'
      d.mcp!.arguments = '{"text": "hi"}'
    })
    await tabsStore.send(tab)
    const dialog = await screen.findByRole('dialog', { name: /Allow Slinger/ })
    expect(tab.untrustedCommand).toBeNull()
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Allow and connect' }))
    await waitFor(() => expect(tab.response?.data.mcp?.ok).toBe(true))
  })
})

describe('MCP editor helpers', () => {
  it('splits and formats command arguments', () => {
    expect(splitArgs('-y  @scope/pkg "a b" \'c d\' e\\ f {{x}}')).toEqual(['-y', '@scope/pkg', 'a b', 'c d', 'e f', '{{x}}'])
    expect(splitArgs('"" x')).toEqual(['', 'x'])
    for (const args of [['a', 'b c', 'say "hi"', 'back\\slash', ''], [], ['{{v}}']]) expect(splitArgs(formatArgs(args))).toEqual(args)
  })

  it('fills and reads URI templates', () => {
    expect(templateVars('demo://users/{id}/posts{?limit,offset}')).toEqual(['id', 'limit', 'offset'])
    expect(expandTemplate('demo://users/{id}{?limit}', { id: '7', limit: '' })).toBe('demo://users/7')
    expect(expandTemplate('demo://users/{id}{?limit,page}', { id: '7', limit: '5', page: '2' })).toBe('demo://users/7?limit=5&page=2')
    expect(matchTemplate('demo://users/{id}', 'demo://users/{{userId}}')).toEqual({ id: '{{userId}}' })
    expect(matchTemplate('demo://users/{id}', 'demo://readme')).toBeNull()
    expect(matchTemplate('file:///{+path}', 'file:///a/b.txt')).toEqual({ path: 'a/b.txt' })
  })

  it('keeps the arguments when another tool is selected (empty becomes {})', () => {
    expect(argumentsForTool('')).toBe('{}')
    expect(argumentsForTool('  ')).toBe('{}')
    expect(argumentsForTool('{"city": "Oslo", "text": "x"}')).toBe('{"city": "Oslo", "text": "x"}')
    expect(argumentsForTool('{"n": {{n}}}')).toBe('{"n": {{n}}}')
  })

  it('maps MCP sections and result views onto the tab state', () => {
    for (const s of ['call', 'connection', 'server', 'scripts', 'docs'] as const) expect(mcpSectionOf(tabSectionOf(s))).toBe(s)
    expect(mcpSectionOf('body')).toBe('call')
    expect(mcpSectionOf('auth')).toBe('connection')
    for (const v of ['result', 'json', 'messages', 'logs', 'tests', 'console'] as const) expect(mcpResultViewOf(tabResultViewOf(v))).toBe(v)
    expect(mcpResultViewOf('preview')).toBe('result')
  })
})
