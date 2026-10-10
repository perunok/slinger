/**
 * History rows of MCP requests (`method: 'MCP'`). Main records them with `url` = the unresolved display string (the
 * server URL template, or the command line `command arg1 arg2` for stdio) and `detail` = `"<operation> <target>"`
 * (`"tools/call get_weather"`, `"resources/read demo://readme"`, `"prompts/get greet"`).
 */
import type { HistoryEntry } from '../../../shared/types'
import { MCP_OPERATIONS, newMcpDraft, newMcpRequestDraft, type McpDraft, type McpOperation } from '../../lib/mcpRequest'
import type { RequestDraft } from '../../lib/request'

/** `"tools/call get_weather"` -> its operation and target (tool / prompt name, or resource URI); null if not one. */
export function parseMcpDetail(detail: string | null | undefined): { operation: McpOperation; target: string } | null {
  const text = (detail ?? '').trim()
  const op = MCP_OPERATIONS.find((o) => text === o || text.startsWith(`${o} `))
  return op ? { operation: op, target: text.slice(op.length).trim() } : null
}

/** A server URL (or a template that starts with a variable, e.g. `{{baseUrl}}/mcp`), as opposed to a command line. */
const looksLikeUrl = (s: string) => /^(https?:\/\/|\{\{)/i.test(s)

/**
 * A new, unsaved MCP draft rebuilt from a History row whose request is gone: the server URL (Streamable HTTP; an SSE
 * server cannot be told apart from the row) or the command line split on spaces (stdio), plus the operation and its
 * tool, URI or prompt from `detail`. Arguments are not in History, so they start empty.
 */
export function mcpDraftFromHistory(entry: Pick<HistoryEntry, 'url' | 'detail' | 'requestName'>): RequestDraft {
  const url = entry.url.trim()
  const draft = newMcpRequestDraft(entry.requestName || url || undefined)
  const init: Partial<McpDraft> = {}
  if (url && !looksLikeUrl(url)) {
    const [command, ...args] = url.split(/\s+/)
    Object.assign(init, { transport: 'stdio', command, args })
  } else draft.url = url
  const op = parseMcpDetail(entry.detail)
  if (op) {
    init.operation = op.operation
    if (op.operation === 'tools/call') init.tool = op.target
    else if (op.operation === 'resources/read') init.uri = op.target
    else init.prompt = op.target
  }
  draft.mcp = newMcpDraft(init)
  return draft
}
