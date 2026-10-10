<script lang="ts" module>
  import type { HttpResponseData, McpCallOutcome } from '../../../shared/types'

  /** `tests` and `console` exist only when the last run ran scripts. */
  export type McpResultTabId = 'result' | 'json' | 'messages' | 'logs' | 'tests' | 'console'

  const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

  /** The JSON-RPC result of an MCP response: `mcp.result`, else the body (executeDraft writes the result there). */
  export function mcpResultOf(response: HttpResponseData | null): Record<string, unknown> | null {
    if (!response) return null
    if (response.mcp) return rec(response.mcp.result)
    try {
      return rec(JSON.parse(response.bodyText ?? ''))
    } catch {
      return null
    }
  }

  /** The operation that produced a result: the response's own, else guessed from the result's shape. */
  export function mcpOperationOf(response: HttpResponseData | null, result: Record<string, unknown> | null): string | null {
    if (response?.mcp?.operation) return response.mcp.operation
    if (!result) return null
    if (Array.isArray(result.content)) return 'tools/call'
    if (Array.isArray(result.contents)) return 'resources/read'
    if (Array.isArray(result.messages)) return 'prompts/get'
    return null
  }

  /**
   * ok / tool error (isError) / error (protocol, transport or not sent), or null when nothing ran. An error wins over a
   * response: it is the latest run's (a send clears the error, but a failed run leaves the previous response).
   */
  export function mcpStatusOf(response: HttpResponseData | null, error: string | null): 'ok' | 'tool-error' | 'error' | null {
    if (error) return 'error'
    if (response?.mcp) return response.mcp.ok ? 'ok' : response.mcp.isError ? 'tool-error' : 'error'
    if (response) return response.status >= 200 && response.status < 300 ? 'ok' : 'error'
    return null
  }

  /** The heading of the error alert: did the server answer with an error, did the call fail, or did nothing run? */
  export function mcpErrorHeading(protocolError: McpCallOutcome['error'], ran: boolean): string {
    const data = protocolError?.data as { timedOut?: unknown; cancelled?: unknown } | null | undefined
    if (protocolError && protocolError.code !== null && !data?.timedOut) return 'The server returned an error'
    if (protocolError || ran) return 'The call failed'
    return 'The request did not run'
  }

  function pretty(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2) ?? ''
    } catch {
      return String(value)
    }
  }
</script>

<script lang="ts">
  /**
   * What sits under an MCP request's editor: the last run's result (content blocks, structured content, raw JSON) and
   * the connection's JSON-RPC message log and server logs (read from connections.svelte.ts).
   */
  import { scopeStore } from '../../app/scope.svelte'
  import { toast } from '../../app/toast.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { formatBytes, formatDuration, LARGE_BODY_BYTES, truncateForDisplay } from '../../lib/response'
  import { testCounts, type ScriptOutput } from '../../lib/scripts'
  import ConsoleView from '../scripts/ConsoleView.svelte'
  import TestsView from '../scripts/TestsView.svelte'
  import { mcpConnections } from './connections.svelte'
  import McpContentBlocks from './McpContentBlocks.svelte'
  import McpMessagesLog, { logRows } from './McpMessagesLog.svelte'

  interface Props {
    /** The last successful run's (synthetic) response; ignored while `error` is set (the latest run failed). */
    response: HttpResponseData | null
    /** Why the last run failed before or instead of a result (unresolved variable, protocol or transport error). */
    error: string | null
    /** The open session whose message log is shown. */
    sessionId: string | null
    /** The error the last call ended with (JSON-RPC code and data when the server answered with one). */
    errorDetail?: McpCallOutcome['error']
    /** Variables the last run could not resolve: each gets a Create button. */
    unresolved?: string[]
    /** Warnings of the last run (for example an unsupported auth type). */
    warnings?: string[]
    /** Test results and console output of the last run's scripts; adds the Tests and Console views. */
    scripts?: ScriptOutput | null
    onclearconsole?: () => void
    view?: McpResultTabId
    onviewchange?: (v: McpResultTabId) => void
  }
  let {
    response,
    error,
    sessionId,
    errorDetail = null,
    unresolved = [],
    warnings = [],
    scripts = null,
    onclearconsole,
    view = 'result',
    onviewchange,
  }: Props = $props()

  // Events arrive on the push channel only after someone subscribed (idempotent).
  $effect(() => mcpConnections.subscribe())

  let chosen = $state<McpResultTabId>('result')
  $effect.pre(() => {
    chosen = view
  })
  // A stored Tests or Console view without script results falls back to the result.
  const current = $derived<McpResultTabId>(!scripts && (chosen === 'tests' || chosen === 'console') ? 'result' : chosen)
  function select(v: McpResultTabId) {
    chosen = v
    onviewchange?.(v)
  }

  // The latest run failed: an earlier run's response is stale, so only the error shows.
  const shown = $derived(error ? null : response)
  const result = $derived(mcpResultOf(shown))
  const operation = $derived(mcpOperationOf(shown, result))
  const status = $derived(mcpStatusOf(shown, error))
  const protocolError = $derived(error ? errorDetail : (shown?.mcp?.error ?? null))
  const errorText = $derived(error ?? (protocolError ? protocolError.message : null))
  const events = $derived(mcpConnections.events(sessionId))
  const logCount = $derived(logRows(events).length)
  const jsonText = $derived(shown?.bodyText ?? (result ? pretty(result) : protocolError ? pretty({ error: protocolError }) : ''))

  // A huge result shows its first 2 MB until "Show all" (like HTTP responses); a new result starts truncated again.
  let showAllJson = $state(false)
  $effect.pre(() => {
    void shown
    showAllJson = false
  })
  const shownJson = $derived(showAllJson ? { text: jsonText, truncated: false } : truncateForDisplay(jsonText))

  const content = $derived(Array.isArray(result?.content) ? (result.content as unknown[]) : [])
  const structured = $derived(result && 'structuredContent' in result && result.structuredContent !== undefined ? pretty(result.structuredContent) : null)
  const contents = $derived(Array.isArray(result?.contents) ? (result.contents as unknown[]).map((resource) => ({ type: 'resource', resource })) : [])
  const messages = $derived(
    Array.isArray(result?.messages) ? (result.messages as unknown[]).map((m) => ({ role: String(rec(m)?.role ?? 'message'), content: rec(m)?.content })) : [],
  )
  const description = $derived(typeof result?.description === 'string' ? result.description : '')

  const counts = $derived(scripts ? testCounts(scripts) : null)
  const tabs = $derived([
    { id: 'result', label: 'Result' },
    { id: 'json', label: 'JSON' },
    { id: 'messages', label: 'Messages', badge: events.length ? String(events.length) : undefined },
    { id: 'logs', label: 'Logs', badge: logCount ? String(logCount) : undefined },
    ...(scripts && counts
      ? [
          {
            id: 'tests',
            label: 'Tests',
            badge: counts.total ? `${counts.passed}/${counts.total}` : undefined,
            badgeTone: (counts.failed ? 'danger' : 'success') as 'danger' | 'success',
          },
          { id: 'console', label: 'Console', badge: scripts.console.length ? String(scripts.console.length) : undefined },
        ]
      : []),
  ])
  const STATUS = {
    ok: { label: 'OK', cls: 'bg-success-soft text-success' },
    'tool-error': { label: 'Tool error', cls: 'bg-danger-soft text-danger' },
    error: { label: 'Error', cls: 'bg-danger-soft text-danger' },
  } as const
  const subject = $derived(shown?.mcp ? [shown.mcp.operation, shown.mcp.name].filter(Boolean).join(' ') : '')

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(jsonText)
      toast.success('Result copied')
    } catch {
      toast.error('Could not copy', 'Clipboard access was denied.')
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-surface" aria-label="MCP result" role="region" data-testid="mcp-result-pane">
  {#if !response && !error && !sessionId}
    <div class="flex h-full flex-col items-center justify-center gap-1 text-sm text-muted" data-testid="mcp-result-empty">
      <p>Connect and run a tool, read a resource or get a prompt</p>
      <p class="text-xs text-faint">Ctrl+Enter also runs it</p>
    </div>
  {:else}
    {#if status}
      <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <span class="rounded px-2 py-0.5 text-xs font-semibold {STATUS[status].cls}" data-testid="mcp-status-chip">{STATUS[status].label}</span>
        {#if shown}<span class="rounded bg-raised px-2 py-0.5 text-xs text-muted" data-testid="mcp-time-chip" title="Time to complete the call">{formatDuration(shown.durationMs)}</span>{/if}
        {#if subject}<code class="min-w-0 truncate text-xs text-muted" title={subject}>{subject}</code>{/if}
        <span class="ml-auto"><IconButton icon="copy" label="Copy result JSON" disabled={!jsonText} onclick={copyJson} /></span>
      </div>
    {/if}
    {#if shown && warnings.length}
      <ul class="border-b border-border bg-warning-soft px-3 py-1 text-xs text-warning" data-testid="mcp-warnings">
        {#each warnings as w (w)}<li>{w}</li>{/each}
      </ul>
    {/if}
    <Tabs {tabs} value={current} onchange={(v) => select(v as McpResultTabId)} label="MCP result views" idPrefix="mcpres" class="px-2" />
    <div class="min-h-0 flex-1" role="tabpanel" id="mcpres-panel-{current}" aria-labelledby="mcpres-{current}">
      {#if current === 'tests' && scripts}
        <TestsView output={scripts} />
      {:else if current === 'console' && scripts}
        <ConsoleView entries={scripts.console} onclear={onclearconsole} />
      {:else if current === 'messages'}
        <McpMessagesLog {events} mode="messages" onclear={sessionId ? () => mcpConnections.clearEvents(sessionId) : undefined} />
      {:else if current === 'logs'}
        <McpMessagesLog {events} mode="logs" />
      {:else if current === 'json'}
        {#if jsonText}
          <div class="flex h-full min-h-0 flex-col">
            {#if shownJson.truncated}
              <div class="flex items-center gap-2 border-b border-border bg-warning-soft px-3 py-1 text-xs text-warning">
                <span>Large result ({formatBytes(jsonText.length)}). Showing the first {formatBytes(LARGE_BODY_BYTES)}.</span>
                <Button size="sm" onclick={() => (showAllJson = true)}>Show all</Button>
              </div>
            {/if}
            <div class="min-h-0 flex-1">
              <CodeEditor value={shownJson.text} readOnly language={shownJson.truncated ? 'text' : 'json'} fold={!shownJson.truncated} label="Result JSON" />
            </div>
          </div>
        {:else}
          <p class="p-4 text-sm text-muted">{errorText ? 'There is no result: the run failed.' : 'Nothing has run on this connection yet.'}</p>
        {/if}
      {:else}
        <div class="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3" data-testid="mcp-result">
          {#if errorText && status === 'error'}
            <div role="alert" class="rounded border border-danger bg-danger-soft p-3 text-sm" data-testid="mcp-error">
              <p class="font-medium text-danger">{mcpErrorHeading(protocolError, !!shown)}</p>
              <p class="mt-1 whitespace-pre-wrap break-words">{errorText}</p>
              {#if error && unresolved.length}
                <ul class="mt-2 flex flex-wrap gap-2">
                  {#each unresolved as name (name)}
                    <li><Button size="sm" icon="plus" onclick={() => scopeStore.createVariable?.(name)}>Create <code>{name}</code></Button></li>
                  {/each}
                </ul>
              {/if}
              {#if protocolError && protocolError.code !== null}<p class="mt-1 text-xs text-muted">JSON-RPC error {protocolError.code}</p>{/if}
              {#if protocolError?.data !== undefined && protocolError?.data !== null}
                <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{pretty(protocolError.data)}</pre>
              {/if}
            </div>
          {/if}
          {#if status === 'tool-error'}
            <div role="alert" class="flex items-center gap-1 rounded border border-danger bg-danger-soft px-3 py-2 text-sm" data-testid="mcp-tool-error">
              <span class="font-medium text-danger">The tool reported an error</span>
              <InfoTip label="About tool errors">
                <span>The server ran the tool and answered with <code>isError: true</code>. The content below is the tool's error output.</span>
                <span>Test scripts see status 500 “Tool error”; the collection runner counts the run as failed.</span>
              </InfoTip>
            </div>
          {/if}
          {#if !result}
            {#if !errorText}
              <p class="text-sm text-muted" data-testid="mcp-result-none">Nothing has run on this connection yet. Run a tool, read a resource or get a prompt.</p>
            {/if}
          {:else if operation === 'tools/call'}
            <McpContentBlocks blocks={content} label="Tool result content" emptyText="The tool returned no content." />
            {#if structured !== null}
              <section class="flex flex-col gap-1" aria-label="Structured content" data-testid="mcp-structured">
                <h3 class="flex items-center gap-1 text-xs font-semibold text-muted">
                  Structured content
                  <InfoTip label="About structured content">
                    <span>The tool's machine-readable result (<code>structuredContent</code>), shaped by its output schema when it declares one.</span>
                    <span>Tests can read it with <code>pm.response.json().structuredContent</code>.</span>
                  </InfoTip>
                </h3>
                <div class="overflow-hidden rounded border border-border" style="height: {Math.min(320, structured.split('\n').length * 18 + 12)}px">
                  <CodeEditor value={structured} readOnly language="json" fold lineNumbers={false} label="Structured content" />
                </div>
              </section>
            {/if}
          {:else if operation === 'resources/read'}
            <McpContentBlocks blocks={contents} label="Resource contents" emptyText="The resource has no contents." />
          {:else if operation === 'prompts/get'}
            {#if description}<p class="text-sm text-muted" data-testid="mcp-prompt-description">{description}</p>{/if}
            {#if messages.length === 0}
              <p class="text-sm text-muted">The prompt returned no messages.</p>
            {:else}
              <ol class="flex flex-col gap-3" aria-label="Prompt messages">
                {#each messages as m, i (i)}
                  <li class="flex flex-col gap-1" data-testid="mcp-prompt-message">
                    <span class="text-xs font-semibold uppercase text-muted">{m.role}</span>
                    <McpContentBlocks blocks={m.content === undefined ? [] : [m.content]} label="{m.role} message {i + 1}" />
                  </li>
                {/each}
              </ol>
            {/if}
          {:else}
            <pre class="overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{jsonText}</pre>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
