/**
 * Mock of the MCP server half of SlingerIpcApi. There is no HTTP endpoint in the browser: `controls.call(tool, args)`
 * plays the LLM client (window.__slingerMock.mcp.call), delivering the call to the app exactly as main would.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { MCP_DEFAULT_PORT, type McpCall, type McpCallResult, type McpClientId, type McpClientStatus, type McpSettings, type McpStatus } from '../../../shared/mcp'

type McpApi = Pick<
  SlingerIpcApi,
  'getMcpStatus' | 'setMcpSettings' | 'revealMcpToken' | 'regenerateMcpToken' | 'mcpRespond' | 'onMcpCall' | 'mcpHostReady' | 'listMcpClients' | 'connectMcpClient' | 'disconnectMcpClient'
>

export interface MockMcpControls {
  /** Calls a tool as an MCP client would; resolves with what the app answered. */
  call(tool: string, args?: unknown): Promise<McpCallResult>
  /** The next setMcpSettings that enables the server reports this port as taken. */
  failNextStart(): void
  /** The next Connect fails with this message (e.g. an assistant config with comments). */
  failNextConnect(message: string): void
}

export function createMcpApi(): { api: McpApi; controls: MockMcpControls } {
  let settings: McpSettings = { enabled: false, port: MCP_DEFAULT_PORT }
  let token = 'slg_mock-token-0000000000000000000000000000000'
  let generation = 0
  let error: string | null = null
  let failStart = false
  let calls = 0
  let lastCallAt: number | null = null
  const listeners = new Set<(call: McpCall) => void>()
  let connectFailure: string | null = null
  const after: Record<McpClientId, string> = {
    'claude-desktop': 'Quit Claude Desktop completely and open it again.',
    'claude-code': 'Start a new Claude Code session (claude) to use it.',
    cursor: 'Cursor picks it up by itself; if not, restart Cursor.',
    vscode: 'In VS Code, start "slinger" from the MCP servers list (Copilot Chat, agent mode).',
    windsurf: 'Refresh the MCP servers in Windsurf (or restart it).',
  }
  const clients: McpClientStatus[] = [
    { id: 'claude-desktop', name: 'Claude Desktop', installed: true, state: 'not-connected', configPath: '/home/ana/.config/Claude/claude_desktop_config.json', afterConnect: after['claude-desktop'] },
    { id: 'claude-code', name: 'Claude Code', installed: true, state: 'not-connected', configPath: '/home/ana/.local/bin/claude', afterConnect: after['claude-code'] },
    { id: 'cursor', name: 'Cursor', installed: true, state: 'connected', configPath: '/home/ana/.cursor/mcp.json', afterConnect: after.cursor },
    { id: 'vscode', name: 'VS Code', installed: false, state: 'not-connected', configPath: '/home/ana/.config/Code/User/mcp.json', afterConnect: after.vscode },
    { id: 'windsurf', name: 'Windsurf', installed: false, state: 'not-connected', configPath: '/home/ana/.codeium/windsurf/mcp_config.json', afterConnect: after.windsurf },
  ]
  const listClients = () => clients.map((c) => ({ ...c }))
  const pending = new Map<string, (r: McpCallResult) => void>()

  const status = (): McpStatus => {
    const url = `http://127.0.0.1:${settings.port}/mcp`
    return {
      ...settings,
      running: settings.enabled && error === null,
      error: settings.enabled ? error : null,
      portNote: null,
      url,
      lastCallAt,
      calls,
      stdio: { command: '/opt/Slinger/slinger', args: ['/home/ana/.config/Slinger/mcp/bridge.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
    }
  }

  const api: McpApi = {
    async getMcpStatus() {
      return status()
    },
    async setMcpSettings(next) {
      settings = { ...next }
      error = settings.enabled && failStart ? `Port ${settings.port} is already in use. Choose another port.` : null
      failStart = false
      return status()
    },
    async revealMcpToken() {
      return token
    },
    async regenerateMcpToken() {
      token = `slg_mock-token-${String(++generation).padStart(32, '0')}`
      return status()
    },
    async mcpRespond(callId, result) {
      const resolve = pending.get(callId)
      pending.delete(callId)
      resolve?.(result)
    },
    onMcpCall(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async mcpHostReady() {},
    async listMcpClients() {
      return listClients()
    },
    async connectMcpClient(id) {
      if (connectFailure) {
        const message = connectFailure
        connectFailure = null
        throw new Error(message)
      }
      if (!settings.enabled) settings = { ...settings, enabled: true }
      clients.find((c) => c.id === id)!.state = 'connected'
      return listClients()
    },
    async disconnectMcpClient(id) {
      clients.find((c) => c.id === id)!.state = 'not-connected'
      return listClients()
    },
  }

  const controls: MockMcpControls = {
    call(tool, args = {}) {
      if (!settings.enabled) return Promise.resolve({ ok: false, error: 'The MCP server is off (mock).' })
      if (listeners.size === 0) return Promise.resolve({ ok: false, error: 'The Slinger window is not open, so the tool cannot run.' })
      const id = crypto.randomUUID()
      calls++
      lastCallAt = Math.floor(Date.now() / 1000)
      return new Promise((resolve) => {
        pending.set(id, resolve)
        for (const l of listeners) l({ id, tool: tool as McpCall['tool'], args })
      })
    },
    failNextStart() {
      failStart = true
    },
    failNextConnect(message) {
      connectFailure = message
    },
  }
  return { api, controls }
}
