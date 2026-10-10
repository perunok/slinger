/** MCP server state for Settings and the status bar; tool calls themselves run in McpHost. */
import type { McpClientId, McpClientStatus, McpSettings, McpStatus, McpToolName } from '../../../shared/mcp'
import { MCP_TOOLS } from '../../../shared/mcp'
import { api, errorInfo } from '../../lib/ipc'

class McpStore {
  status = $state<McpStatus | null>(null)
  /** Tool calls running right now. */
  active = $state(0)
  /** Title of the tool that ran last (status bar tooltip). */
  lastTool = $state<string | null>(null)
  error = $state<string | null>(null)
  /** Assistants found on this computer (Settings). */
  clients = $state<McpClientStatus[] | null>(null)
  /** The assistant being connected / disconnected. */
  busyClient = $state<McpClientId | null>(null)
  clientError = $state<{ id: McpClientId; message: string } | null>(null)

  async loadClients(): Promise<void> {
    try {
      this.clients = await api().listMcpClients()
    } catch (e) {
      this.error = errorInfo(e).message
    }
  }

  /** Connect (adds Slinger to the assistant's configuration; turns the server on) or Disconnect. */
  async setConnected(id: McpClientId, connected: boolean): Promise<boolean> {
    this.busyClient = id
    this.clientError = null
    try {
      this.clients = connected ? await api().connectMcpClient(id) : await api().disconnectMcpClient(id)
      await this.load()
      return true
    } catch (e) {
      this.clientError = { id, message: errorInfo(e).message }
      return false
    } finally {
      this.busyClient = null
    }
  }

  async load(): Promise<void> {
    try {
      this.status = await api().getMcpStatus()
      this.error = null
    } catch (e) {
      this.error = errorInfo(e).message
    }
  }

  async save(next: McpSettings): Promise<void> {
    try {
      this.status = await api().setMcpSettings(next)
      this.error = null
    } catch (e) {
      this.error = errorInfo(e).message
    }
  }

  async regenerateToken(): Promise<void> {
    try {
      this.status = await api().regenerateMcpToken()
    } catch (e) {
      this.error = errorInfo(e).message
    }
  }

  revealToken(): Promise<string> {
    return api().revealMcpToken()
  }

  /** McpHost reports each call so the status bar can show activity. */
  begin(tool: string): void {
    this.active++
    this.lastTool = Object.hasOwn(MCP_TOOLS, tool) ? MCP_TOOLS[tool as McpToolName].title : tool
  }
  end(): void {
    this.active = Math.max(0, this.active - 1)
    void this.load() // call count / last call time
  }
}

export const mcp = new McpStore()
