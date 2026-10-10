/** MCP server state for Settings and the status bar; tool calls themselves run in McpHost. */
import type { McpSettings, McpStatus, McpToolName } from '../../../shared/mcp'
import { MCP_TOOLS } from '../../../shared/mcp'
import { api, errorInfo } from '../../lib/ipc'

class McpStore {
  status = $state<McpStatus | null>(null)
  /** Tool calls running right now. */
  active = $state(0)
  /** Title of the tool that ran last (status bar tooltip). */
  lastTool = $state<string | null>(null)
  error = $state<string | null>(null)

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
