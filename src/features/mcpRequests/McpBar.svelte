<script lang="ts" module>
  /**
   * Command-line style argument text <-> the stored argument list. Whitespace separates arguments; double or single
   * quotes keep spaces inside one, and a backslash escapes the next character (inside double quotes too). Each argument
   * may hold `{{variables}}`; they are resolved when the command starts, never split.
   */
  export function splitArgs(text: string): string[] {
    const out: string[] = []
    let cur = ''
    let started = false
    let quote: '"' | "'" | null = null
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      if (quote) {
        if (ch === quote) quote = null
        else if (ch === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i]
        else cur += ch
      } else if (ch === '"' || ch === "'") {
        quote = ch
        started = true
      } else if (ch === '\\' && i + 1 < text.length) {
        cur += text[++i]
        started = true
      } else if (/\s/.test(ch)) {
        if (started) out.push(cur)
        cur = ''
        started = false
      } else {
        cur += ch
        started = true
      }
    }
    if (started) out.push(cur)
    return out
  }

  /** The text `splitArgs` turns back into `args` (arguments with spaces, quotes or backslashes are double-quoted). */
  export function formatArgs(args: readonly string[]): string {
    return args.map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/["\\]/g, (c) => `\\${c}`)}"` : a)).join(' ')
  }

  export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
</script>

<script lang="ts">
  /**
   * The bar of an MCP request: transport, server URL (HTTP / SSE) or command and arguments (stdio), Connect / Disconnect
   * with a status dot, Run (= Send, Ctrl+Enter) and Save.
   */
  import { untrack } from 'svelte'
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import Button from '../../components/ui/Button.svelte'
  import type { McpDraft, McpTransport } from '../../lib/mcpRequest'
  import { sync } from '../sync/syncStore.svelte'
  import type { RequestTab } from '../requests/tabs.svelte'

  interface Props {
    tab: RequestTab
    status: McpConnectionStatus
    /** Shown on hover of the status dot (the server's name, or why connecting failed). */
    statusText?: string
    onconnect: () => void
    ondisconnect: () => void
    onrun: () => void
    oncancel: () => void
    onsave: () => void
    /** The transport changed (an open connection no longer matches the request). */
    ontransportchange?: () => void
  }
  let { tab, status, statusText = '', onconnect, ondisconnect, onrun, oncancel, onsave, ontransportchange }: Props = $props()
  const mcp = $derived(tab.draft.mcp as McpDraft)

  const TRANSPORTS: { id: McpTransport; label: string }[] = [
    { id: 'http', label: 'Streamable HTTP' },
    { id: 'sse', label: 'SSE (legacy)' },
    { id: 'stdio', label: 'Command (stdio)' },
  ]
  const STATUS_LABEL: Record<McpConnectionStatus, string> = {
    disconnected: 'Not connected',
    connecting: 'Connecting',
    connected: 'Connected',
    error: 'Connection failed',
  }
  const DOT: Record<McpConnectionStatus, string> = {
    disconnected: 'bg-faint',
    connecting: 'bg-warning animate-pulse',
    connected: 'bg-success',
    error: 'bg-danger',
  }

  // The argument text is kept as typed (a trailing space or an open quote must survive), and is only rewritten from
  // the draft when the arguments change elsewhere (undo of a load, a remote update).
  let argsText = $state(untrack(() => formatArgs(mcp.args)))
  $effect(() => {
    const args = mcp.args
    untrack(() => {
      if (JSON.stringify(splitArgs(argsText)) !== JSON.stringify(args)) argsText = formatArgs(args)
    })
  })
  function setArgs(text: string) {
    argsText = text
    mcp.args = splitArgs(text)
  }

  function setTransport(v: string) {
    const next = TRANSPORTS.find((t) => t.id === v)?.id ?? 'http'
    if (next === mcp.transport) return
    mcp.transport = next
    ontransportchange?.()
  }
</script>

<div class="flex items-center gap-2 px-3 py-2" role="group" aria-label="MCP server">
  <select aria-label="Transport" class="h-8 w-40 shrink-0" value={mcp.transport} onchange={(e) => setTransport(e.currentTarget.value)}>
    {#each TRANSPORTS as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
  </select>
  {#if mcp.transport === 'stdio'}
    <div class="flex h-8 w-56 min-w-0 shrink items-center rounded border border-border bg-surface px-1 focus-within:border-accent">
      <TemplateInput class="w-full !border-transparent" mono label="Command" placeholder="npx" value={mcp.command} oninput={(v) => (mcp.command = v)} onenter={onrun} />
    </div>
    <div class="flex h-8 min-w-0 flex-1 items-center rounded border border-border bg-surface px-1 focus-within:border-accent">
      <TemplateInput class="w-full !border-transparent" mono label="Arguments" placeholder="-y @modelcontextprotocol/server-everything" value={argsText} oninput={setArgs} onenter={onrun} />
    </div>
  {:else}
    <div class="flex h-8 min-w-0 flex-1 items-center rounded border border-border bg-surface px-1 focus-within:border-accent">
      <TemplateInput
        class="w-full !border-transparent"
        mono
        label="Server URL"
        placeholder={mcp.transport === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'}
        value={tab.draft.url}
        oninput={(v) => (tab.draft.url = v)}
        onenter={onrun}
      />
    </div>
  {/if}
  <span class="inline-flex h-2.5 w-2.5 shrink-0 rounded-full {DOT[status]}" role="img" aria-label={STATUS_LABEL[status]} title={statusText || STATUS_LABEL[status]} data-testid="mcp-status"></span>
  {#if status === 'connected'}
    <Button icon="x" onclick={ondisconnect} class="w-28">Disconnect</Button>
  {:else}
    <Button icon="link" onclick={onconnect} loading={status === 'connecting'} disabled={status === 'connecting'} class="w-28">Connect</Button>
  {/if}
  {#if tab.sending}
    <Button variant="danger" icon="stop" onclick={oncancel} class="w-24">Cancel</Button>
  {:else}
    <Button variant="primary" icon="play" onclick={onrun} class="w-24" title="Run (Ctrl+Enter)">Run</Button>
  {/if}
  <Button icon="save" onclick={onsave} loading={tab.saving} title={sync.blocked ? `${sync.blockedMessage} Saving is disabled.` : 'Save (Ctrl+S)'} disabled={sync.blocked || (!!tab.requestId && !tab.dirty)}>Save</Button>
</div>
