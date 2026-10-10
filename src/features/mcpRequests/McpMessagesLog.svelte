<script lang="ts" module>
  import type { McpClientEvent } from '../../../shared/types'

  /** 'messages' = the whole JSON-RPC log; 'logs' = only what the server logs (notifications/message) and stderr. */
  export type McpLogMode = 'messages' | 'logs'
  export type McpLogCategory = 'rpc' | 'notification' | 'stderr' | 'connection'

  export interface McpLogRow {
    event: McpClientEvent
    /** 'out' = Slinger sent it, 'in' = the server sent it, 'none' = process output or a connection state change. */
    dir: 'out' | 'in' | 'none'
    category: McpLogCategory
    /** Method (or what the row is), e.g. "tools/call", "stderr", "warning". */
    title: string
    /** One-line summary after the title. */
    detail: string
    tone: 'normal' | 'danger' | 'warning' | 'muted'
  }

  const rec = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const idOf = (msg: Record<string, unknown>): string | null => (typeof msg.id === 'string' || typeof msg.id === 'number' ? String(msg.id) : null)
  const oneLine = (s: string, max = 200) => {
    const line = s.replace(/\s+/g, ' ').trim()
    return line.length > max ? `${line.slice(0, max)}…` : line
  }

  const jsonCache = new WeakMap<McpClientEvent, string>()
  /** Pretty JSON of an event's payload (stderr: its text), cached per event because payloads can be large. */
  export function eventText(e: McpClientEvent): string {
    let text = jsonCache.get(e)
    if (text === undefined) {
      const p = rec(e.payload)
      if (e.type === 'stderr' && p && typeof p.text === 'string') text = p.text
      else {
        try {
          text = JSON.stringify(e.payload, null, 2) ?? String(e.payload)
        } catch {
          text = String(e.payload)
        }
      }
      jsonCache.set(e, text)
    }
    return text
  }

  /** A JSON-RPC notification the transport delivered: receive event with a method and no id. */
  const isReceivedNotification = (e: McpClientEvent | undefined, method?: string): boolean => {
    const m = e?.type === 'receive' ? rec(e.payload) : null
    return !!m && typeof m.method === 'string' && idOf(m) === null && (method === undefined || m.method === method)
  }

  /**
   * Main may report a server notification twice: as the raw `receive` message and as a `notification` event right
   * next to it. Each view keeps one of the pair.
   */
  function hasTwin(events: readonly McpClientEvent[], i: number): boolean {
    const e = events[i]
    if (e.type === 'notification') {
      const method = str(rec(e.payload)?.method)
      return isReceivedNotification(events[i - 1], method) || isReceivedNotification(events[i + 1], method)
    }
    if (isReceivedNotification(e)) {
      const method = str(rec(e.payload)?.method)
      const twin = (n: McpClientEvent | undefined) => n?.type === 'notification' && str(rec(n.payload)?.method) === method
      return twin(events[i - 1]) || twin(events[i + 1])
    }
    return false
  }

  function logLevelTone(level: string): McpLogRow['tone'] {
    if (['error', 'critical', 'alert', 'emergency'].includes(level)) return 'danger'
    if (level === 'warning') return 'warning'
    if (level === 'debug') return 'muted'
    return 'normal'
  }

  /** Rows of the Messages view: every event, responses labelled with the method of their request. */
  export function messageRows(events: readonly McpClientEvent[]): McpLogRow[] {
    const methodById = new Map<string, string>()
    const rows: McpLogRow[] = []
    events.forEach((e, i) => {
      const p = rec(e.payload)
      if (e.type === 'send' || e.type === 'receive') {
        const dir = e.type === 'send' ? 'out' : 'in'
        const msg = p ?? {}
        const id = idOf(msg)
        if (typeof msg.method === 'string') {
          // A request (has an id; its response comes the other way) or a notification.
          if (id !== null) methodById.set(`${dir}:${id}`, msg.method)
          rows.push({ event: e, dir, category: id === null ? 'notification' : 'rpc', title: msg.method, detail: id === null ? 'notification' : `#${id}`, tone: 'normal' })
          return
        }
        const method = (id !== null && methodById.get(`${dir === 'in' ? 'out' : 'in'}:${id}`)) || 'response'
        const err = rec(msg.error)
        rows.push({
          event: e,
          dir,
          category: 'rpc',
          title: method,
          detail: err ? `#${id ?? '?'} error ${typeof err.code === 'number' ? `${err.code} ` : ''}${oneLine(str(err.message))}` : `#${id ?? '?'} result`,
          tone: err ? 'danger' : 'normal',
        })
        return
      }
      if (e.type === 'notification') {
        if (hasTwin(events, i)) return
        const params = rec(p?.params)
        const level = str(params?.level)
        rows.push({ event: e, dir: 'in', category: 'notification', title: str(p?.method) || 'notification', detail: level ? level : 'notification', tone: 'normal' })
        return
      }
      if (e.type === 'stderr') {
        rows.push({ event: e, dir: 'none', category: 'stderr', title: 'stderr', detail: oneLine(str(p?.text)), tone: 'muted' })
        return
      }
      rows.push({
        event: e,
        dir: 'none',
        category: 'connection',
        title: e.type === 'closed' ? 'Connection closed' : 'Error',
        detail: oneLine(str(p?.message)),
        tone: e.type === 'closed' ? 'warning' : 'danger',
      })
    })
    return rows
  }

  /** Rows of the Logs view: the server's log messages (notifications/message) and the process's stderr. */
  export function logRows(events: readonly McpClientEvent[]): McpLogRow[] {
    const rows: McpLogRow[] = []
    events.forEach((e, i) => {
      const p = rec(e.payload)
      if (e.type === 'stderr') {
        rows.push({ event: e, dir: 'none', category: 'stderr', title: 'stderr', detail: str(p?.text).replace(/\n$/, ''), tone: 'muted' })
        return
      }
      const isLog = (e.type === 'notification' || (isReceivedNotification(e) && !hasTwin(events, i))) && p?.method === 'notifications/message'
      if (!isLog) return
      const params = rec(p?.params) ?? {}
      const level = str(params.level) || 'info'
      let data = typeof params.data === 'string' ? params.data : ''
      if (typeof params.data !== 'string') {
        try {
          data = JSON.stringify(params.data) ?? ''
        } catch {
          data = String(params.data)
        }
      }
      const logger = str(params.logger)
      rows.push({ event: e, dir: 'in', category: 'notification', title: level, detail: logger ? `[${logger}] ${data}` : data, tone: logLevelTone(level) })
    })
    return rows
  }

  export function formatEventTime(ms: number): string {
    const d = new Date(ms)
    const pad = (n: number, w = 2) => String(n).padStart(w, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  }

  /** Longest JSON an expanded row renders (Copy still copies all of it). */
  export const ROW_JSON_LIMIT = 200_000
</script>

<script lang="ts">
  /** The JSON-RPC message log of one MCP session (Messages), or only its server log and stderr (Logs). */
  import { toast } from '../../app/toast.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'

  interface Props {
    events: readonly McpClientEvent[]
    mode: McpLogMode
    /** Empties the session's log (Clear); the Logs view shows part of the same log. */
    onclear?: () => void
  }
  let { events, mode, onclear }: Props = $props()

  type Filter = 'all' | McpLogCategory
  let filter = $state<Filter>('all')
  let query = $state('')
  // Expanded rows, by event (indices shift when old events are dropped).
  let open = $state.raw<Set<McpClientEvent>>(new Set())

  const FILTERS = $derived<Array<{ id: Filter; label: string }>>(
    mode === 'messages'
      ? [
          { id: 'all', label: 'All' },
          { id: 'rpc', label: 'Requests and responses' },
          { id: 'notification', label: 'Notifications' },
          { id: 'stderr', label: 'stderr' },
          { id: 'connection', label: 'Connection' },
        ]
      : [
          { id: 'all', label: 'All' },
          { id: 'notification', label: 'Server log' },
          { id: 'stderr', label: 'stderr' },
        ],
  )
  const rows = $derived(mode === 'messages' ? messageRows(events) : logRows(events))
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) =>
        (filter === 'all' || r.category === filter) &&
        (!q || r.title.toLowerCase().includes(q) || r.detail.toLowerCase().includes(q) || eventText(r.event).toLowerCase().includes(q)),
    )
  })
  const noun = $derived(mode === 'messages' ? 'message' : 'line')
  const TONE: Record<McpLogRow['tone'], string> = { normal: 'text-fg', danger: 'text-danger', warning: 'text-warning', muted: 'text-muted' }
  const ARROW: Record<McpLogRow['dir'], { glyph: string; label: string }> = {
    out: { glyph: '→', label: 'Sent' },
    in: { glyph: '←', label: 'Received' },
    none: { glyph: '·', label: 'Event' },
  }

  function toggle(e: McpClientEvent) {
    const next = new Set(open)
    if (!next.delete(e)) next.add(e)
    open = next
  }

  async function copy(e: McpClientEvent) {
    try {
      await navigator.clipboard.writeText(eventText(e))
      toast.success(e.type === 'stderr' ? 'Output copied' : 'Message copied')
    } catch {
      toast.error('Could not copy', 'Clipboard access was denied.')
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="mcp-{mode}-log">
  <div class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1 text-xs">
    <label for="mcp-{mode}-filter" class="text-muted">Show</label>
    <select id="mcp-{mode}-filter" class="h-6 py-0 text-xs" bind:value={filter}>
      {#each FILTERS as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
    </select>
    <input type="search" class="h-6 w-44 py-0 text-xs" placeholder="Filter" aria-label="Filter {noun}s" bind:value={query} />
    <span class="text-muted" data-testid="mcp-{mode}-count">
      {shown.length === rows.length ? `${rows.length} ${noun}${rows.length === 1 ? '' : 's'}` : `${shown.length} of ${rows.length} ${noun}s`}
    </span>
    {#if mode === 'logs'}
      <InfoTip label="About server logs">
        <span>Log messages the server sends (<code>notifications/message</code>) and, for a command (stdio) server, what the process writes to stderr.</span>
        <span>Servers decide what they log; many only log after a call.</span>
      </InfoTip>
    {:else}
      <InfoTip label="About the message log">
        <span>Every JSON-RPC message of this connection: → sent by Slinger, ← sent by the server. Responses are labelled with the method of their request.</span>
        <span>The log keeps the last 500 events and is not saved. Header values (such as Authorization) are never part of it.</span>
      </InfoTip>
    {/if}
    {#if onclear}<span class="ml-auto"><IconButton icon="trash" label={mode === 'messages' ? 'Clear messages' : 'Clear logs'} disabled={rows.length === 0} onclick={onclear} /></span>{/if}
  </div>
  <div class="min-h-0 flex-1 overflow-auto font-mono text-xs">
    {#if shown.length === 0}
      <p class="p-4 font-sans text-sm text-muted">
        {#if rows.length}
          No {noun}s match the filter.
        {:else if mode === 'messages'}
          No messages yet. Connect to a server to see its JSON-RPC traffic here.
        {:else}
          No server logs yet.
        {/if}
      </p>
    {:else}
      <ol aria-label={mode === 'messages' ? 'JSON-RPC messages' : 'Server logs'}>
        {#each shown as r (r.event)}
          {@const expanded = open.has(r.event)}
          {@const text = expanded ? eventText(r.event) : ''}
          <li class="border-b border-border" data-testid="mcp-log-row" data-type={r.event.type}>
            <button
              type="button"
              class="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-hover"
              aria-expanded={expanded}
              onclick={() => toggle(r.event)}
            >
              <span class="shrink-0 text-faint">{formatEventTime(r.event.at)}</span>
              {#if mode === 'messages'}
                <span class="w-3 shrink-0 text-center {r.dir === 'out' ? 'text-accent-text' : 'text-muted'}" title={ARROW[r.dir].label}>
                  <span aria-hidden="true">{ARROW[r.dir].glyph}</span><span class="sr-only">{ARROW[r.dir].label}</span>
                </span>
              {/if}
              <span class="shrink-0 font-semibold {mode === 'logs' ? `w-16 uppercase ${TONE[r.tone]}` : TONE[r.tone]}">{r.title}</span>
              <span class="min-w-0 flex-1 {mode === 'logs' ? 'whitespace-pre-wrap break-words text-fg' : `truncate ${r.tone === 'danger' ? 'text-danger' : 'text-muted'}`}">{r.detail}</span>
            </button>
            {#if expanded}
              <div class="relative border-t border-border bg-raised">
                <span class="absolute right-1 top-1"><IconButton icon="copy" label="Copy" onclick={() => copy(r.event)} /></span>
                <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-words px-3 py-2 pr-10">{text.length > ROW_JSON_LIMIT ? text.slice(0, ROW_JSON_LIMIT) : text}</pre>
                {#if text.length > ROW_JSON_LIMIT}
                  <p class="px-3 pb-2 font-sans text-warning">{(text.length - ROW_JSON_LIMIT).toLocaleString('en')} more characters not shown. Copy gets all of it.</p>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</div>
