/** Manual setups for assistants Slinger cannot connect by itself (Settings > AI assistants > Other assistants). */
import type { McpStatus } from '../../../shared/mcp'

export type McpManualKind = 'command' | 'http'

export const MCP_MANUAL: { id: McpManualKind; label: string; hint: string }[] = [
  {
    id: 'command',
    label: 'Command (most assistants)',
    hint: 'Add this to the assistant\u2019s MCP configuration. It needs no token and starts Slinger when it is not running.',
  },
  {
    id: 'http',
    label: 'URL + token',
    hint: 'For assistants that only take a server URL. Copy puts your real token in; it only works while Slinger runs.',
  },
]

export function mcpSnippet(kind: McpManualKind, status: Pick<McpStatus, 'url' | 'stdio'>, token: string): string {
  switch (kind) {
    case 'command':
      return JSON.stringify({ mcpServers: { slinger: { command: status.stdio.command, args: status.stdio.args, env: status.stdio.env } } }, null, 2)
    case 'http':
      return JSON.stringify({ mcpServers: { slinger: { type: 'http', url: status.url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
  }
}
