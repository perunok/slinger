/**
 * Main -> renderer hand-off for MCP tool calls. The renderer owns the request model and the send pipeline, so main
 * only forwards `{id, tool, args}` over a push channel and waits for `mcpRespond(id, result)`.
 */
import { randomUUID } from 'node:crypto'
import type { McpCall, McpCallResult, McpToolName } from '../../shared/mcp'

export type McpEmit = (call: McpCall) => boolean

interface Pending {
  resolve(result: McpCallResult): void
  timer: ReturnType<typeof setTimeout>
}

export class McpBridge {
  readonly #pending = new Map<string, Pending>()

  /** `emit` returns false when there is no window to run the call in. */
  constructor(private readonly emit: McpEmit) {}

  call(tool: McpToolName, args: unknown, timeoutMs: number): Promise<McpCallResult> {
    const id = randomUUID()
    return new Promise<McpCallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({ ok: false, error: `Slinger did not finish "${tool}" within ${Math.round(timeoutMs / 1000)} s.` })
      }, timeoutMs)
      this.#pending.set(id, { resolve, timer })
      if (!this.emit({ id, tool, args })) {
        clearTimeout(timer)
        this.#pending.delete(id)
        resolve({ ok: false, error: 'The Slinger window is not open, so the tool cannot run. Open Slinger and try again.' })
      }
    })
  }

  /** The renderer's answer. Unknown or late ids are ignored (the call already timed out). */
  respond(id: string, result: McpCallResult): void {
    const p = this.#pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.#pending.delete(id)
    p.resolve(result)
  }

  /** Fails every waiting call (app quitting, server stopped). */
  failAll(error: string): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error })
      this.#pending.delete(id)
    }
  }
}
