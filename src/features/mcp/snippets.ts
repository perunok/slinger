/** Connection snippets for MCP clients (Settings > AI assistants). Built with the real token only when copied. */
import type { McpStatus } from '../../../shared/mcp'

export type McpClientKind = 'claude-code' | 'json-http' | 'claude-desktop'

export const MCP_CLIENTS: { id: McpClientKind; label: string; hint: string }[] = [
  { id: 'claude-code', label: 'Claude Code', hint: 'Run this command once in a terminal.' },
  { id: 'json-http', label: 'Cursor, VS Code, others', hint: 'Add this to the client’s MCP configuration (mcp.json).' },
  { id: 'claude-desktop', label: 'Claude Desktop', hint: 'Add this to claude_desktop_config.json, then restart Claude Desktop.' },
]

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

export function mcpSnippet(kind: McpClientKind, status: Pick<McpStatus, 'url' | 'stdio'>, token: string): string {
  switch (kind) {
    case 'claude-code':
      return `claude mcp add --scope user --transport http slinger ${status.url} --header ${shellQuote(`Authorization: Bearer ${token}`)}`
    case 'json-http':
      return JSON.stringify({ mcpServers: { slinger: { type: 'http', url: status.url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
    case 'claude-desktop':
      return JSON.stringify(
        { mcpServers: { slinger: { command: status.stdio.command, args: status.stdio.args, env: { ...status.stdio.env, SLINGER_MCP_TOKEN: token } } } },
        null,
        2,
      )
  }
}
