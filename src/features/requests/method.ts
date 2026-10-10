/**
 * Method badge colours, shared by every list that shows a request's method (tabs, tree, Quick open, History, runner,
 * versions, overview). MCP requests (`method: 'MCP'`) use the neutral `--m-other` token, like any other non-verb method.
 */
import { MCP_METHOD } from '../../lib/mcpRequest'

const COLORS: Record<string, string> = {
  GET: 'var(--m-get)',
  POST: 'var(--m-post)',
  PUT: 'var(--m-put)',
  PATCH: 'var(--m-patch)',
  DELETE: 'var(--m-delete)',
  [MCP_METHOD]: 'var(--m-other)',
}
export function methodColor(method: string): string {
  return COLORS[method.toUpperCase()] ?? 'var(--m-other)'
}

/** A stored method (a request row, a History entry) that marks an MCP request. */
export function isMcpMethod(method: string | null | undefined): boolean {
  return (method ?? '').toUpperCase() === MCP_METHOD
}
