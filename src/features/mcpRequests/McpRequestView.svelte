<script lang="ts" module>
  import type { RequestSection, ResponseSection } from '../requests/tabs.svelte'
  import type { McpResultTabId } from './McpResultPane.svelte'

  export type McpSection = 'call' | 'connection' | 'server' | 'scripts' | 'docs'

  /**
   * MCP sections are kept in the tab's ordinary `section` (so they survive switching tabs and restarts like an HTTP
   * request's): Call is stored as 'params' (the default of a new tab), Connection as 'headers', Server as 'settings'.
   */
  const TO_TAB: Record<McpSection, RequestSection> = { call: 'params', connection: 'headers', server: 'settings', scripts: 'scripts', docs: 'docs' }

  export function mcpSectionOf(section: RequestSection): McpSection {
    if (section === 'headers' || section === 'auth') return 'connection'
    if (section === 'settings') return 'server'
    if (section === 'scripts' || section === 'docs') return section
    return 'call'
  }
  export const tabSectionOf = (section: McpSection): RequestSection => TO_TAB[section]

  /** Likewise for the result pane's view, kept in the tab's `responseView` (Tests and Console as for HTTP responses). */
  const RESULT_TO_TAB: Record<McpResultTabId, ResponseSection> = {
    result: 'pretty',
    json: 'raw',
    messages: 'headers',
    logs: 'cookies',
    tests: 'tests',
    console: 'console',
  }
  export function mcpResultViewOf(view: ResponseSection): McpResultTabId {
    return (Object.keys(RESULT_TO_TAB) as McpResultTabId[]).find((k) => RESULT_TO_TAB[k] === view) ?? 'result'
  }
  export const tabResultViewOf = (view: McpResultTabId): ResponseSection => RESULT_TO_TAB[view]
</script>

<script lang="ts">
  /**
   * The editor of an MCP request (App shows it instead of RequestView when the draft has `mcp`). The bar connects and
   * runs; Run is the tab's ordinary send (tabsStore.send -> executeDraft), so History, scripts, the runner and
   * workflows treat it like any request. The tab's connection is `tab:<tabId>` in the connection registry: Connect
   * opens it here, and a Run reuses it (or opens it first).
   *
   * stdio commands must be allowed on this device before they start: when main refuses one (connect or run), the trust
   * dialog shows the exact command, and Allow records it and tries again.
   */
  import { onDestroy, untrack } from 'svelte'
  import type { McpClientEvent, McpConnectInput, McpListKind, McpTrustCommandInput } from '../../../shared/types'
  import { scopeStore } from '../../app/scope.svelte'
  import { settings } from '../../app/settings.svelte'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import SplitPane from '../../components/ui/SplitPane.svelte'
  import Tabs from '../../components/ui/Tabs.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { dataRows } from '../../lib/kv'
  import type { McpDraft } from '../../lib/mcpRequest'
  import { prepareMcp, secretsNeeded, withMcpOAuth2Token } from '../../lib/prepare'
  import type { RequestDraft } from '../../lib/request'
  import { editorCode } from '../../lib/scripts'
  import { findSecretsUsed } from '../../lib/template'
  import ResponsePositionButton from '../layout/ResponsePositionButton.svelte'
  import { splitKey } from '../layout/layoutActions'
  import ConflictDialog from '../requests/ConflictDialog.svelte'
  import DocsPanel from '../requests/DocsPanel.svelte'
  import ScriptsPanel from '../requests/ScriptsPanel.svelte'
  import { MCP_TOKEN_WHERE, oauth2TokenMessage, untrustedCommandOf } from '../requests/execute'
  import { tabsStore, type RequestTab } from '../requests/tabs.svelte'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import SyncSizeWarning from '../sync/SyncSizeWarning.svelte'
  import TabNoticeBanner from '../sync/TabNoticeBanner.svelte'
  import { mcpConnections } from './connections.svelte'
  import McpBar, { type McpConnectionStatus } from './McpBar.svelte'
  import McpCallPanel, { type McpLists } from './McpCallPanel.svelte'
  import McpConnectionPanel from './McpConnectionPanel.svelte'
  import McpResultPane from './McpResultPane.svelte'
  import McpServerPanel from './McpServerPanel.svelte'
  import McpTrustDialog from './McpTrustDialog.svelte'

  let { tab }: { tab: RequestTab } = $props()

  const mcp = $derived(tab.draft.mcp as McpDraft)
  // App mounts one view per tab (keyed by its id), so the key never changes for this component.
  const key = untrack(() => `tab:${tab.id}`)
  const conn = $derived(mcpConnections.connections[key] ?? null)
  const sessionId = $derived(conn?.sessionId ?? null)

  /** Secrets and the OAuth 2.0 token are being looked up before the connect itself starts. */
  let resolving = $state(false)
  let connectError = $state<string | null>(null)
  const status = $derived<McpConnectionStatus>(
    conn ? 'connected' : resolving || mcpConnections.isConnecting(key) ? 'connecting' : connectError ? 'error' : 'disconnected',
  )
  const statusText = $derived(
    conn ? `Connected to ${conn.info.serverInfo.title || conn.info.serverInfo.name} ${conn.info.serverInfo.version}` : (connectError ?? ''),
  )

  const section = $derived(mcpSectionOf(tab.section))
  const sections = $derived.by(() => {
    const d = tab.draft
    const count = (n: number) => (n > 0 ? String(n) : undefined)
    const connectionBadge =
      mcp.transport === 'stdio'
        ? count(dataRows(mcp.env).filter((r) => r.enabled).length)
        : (count(dataRows(d.headers).filter((r) => r.enabled).length) ?? (d.auth.kind !== 'none' ? '•' : undefined))
    return [
      { id: 'call', label: 'Call' },
      { id: 'connection', label: 'Connection', badge: connectionBadge },
      { id: 'server', label: 'Server', badge: conn ? '•' : undefined, badgeTone: 'success' as const },
      { id: 'scripts', label: 'Scripts', badge: editorCode(d.extras.scripts, 'prerequest').trim() || editorCode(d.extras.scripts, 'test').trim() ? '•' : undefined },
      { id: 'docs', label: 'Docs' },
    ]
  })

  // --- Connecting ---------------------------------------------------------------------------------------------------

  type Resolved = { ok: true; input: McpConnectInput } | { ok: false; error: string }

  /**
   * The resolved connect input, the way a send resolves it (environment > collection variables > globals, secrets and
   * the OAuth 2.0 token revealed just in time); pre-request scripts do not run for Connect. Only the connection
   * settings count: the call is replaced by a stand-in that always resolves, so an unfinished call (no tool yet,
   * arguments with an undefined variable) does not keep the user from connecting to see what the server offers.
   */
  async function resolveConnect(): Promise<Resolved> {
    const workspaceId = app.workspaceId
    if (!workspaceId) return { ok: false, error: 'Open a workspace first.' }
    const snapshot = $state.snapshot(tab.draft) as RequestDraft
    const draft: RequestDraft = { ...snapshot, mcp: { ...(snapshot.mcp as McpDraft), operation: 'prompts/get', prompt: 'connect', promptArguments: [] } }
    const scope = scopeStore.scopeFor(tab.collectionId)
    const secrets = new Map<string, string>()
    try {
      for (const v of secretsNeeded(draft, scope)) {
        if (!v.id) continue
        secrets.set(v.key, v.source === 'global' ? await api().revealGlobalVariable(v.id) : await api().revealEnvironmentVariable(v.id))
      }
    } catch (e) {
      return { ok: false, error: `Could not read a secret variable: ${errorInfo(e).message}` }
    }
    const prepared = prepareMcp(draft, { workspaceId, requestId: tab.requestId, scope, secrets })
    if (!prepared.ok) return { ok: false, error: prepared.error }
    let connect = prepared.connect
    if (prepared.oauth2) {
      try {
        const token = await api().refreshOAuth2Token(prepared.oauth2.config, { ifExpiring: true })
        if (!token.hasToken) return { ok: false, error: oauth2TokenMessage('missing', MCP_TOKEN_WHERE) }
        if (token.expired) return { ok: false, error: oauth2TokenMessage('expired', MCP_TOKEN_WHERE) }
        connect = withMcpOAuth2Token(connect, prepared.oauth2, await api().revealOAuth2Token(token.tokenKey))
      } catch (e) {
        return { ok: false, error: errorInfo(e).message }
      }
    }
    return { ok: true, input: { ...connect, workspaceId, origin: 'user' } }
  }

  async function connect(): Promise<boolean> {
    if (resolving || mcpConnections.isConnecting(key)) return false
    connectError = null
    resolving = true
    let resolved: Resolved
    try {
      resolved = await resolveConnect()
    } finally {
      resolving = false
    }
    if (!resolved.ok) {
      connectError = resolved.error
      return false
    }
    try {
      await mcpConnections.getSession(key, resolved.input)
      return true
    } catch (e) {
      const info = errorInfo(e)
      if (info.details?.reason === 'untrusted_command') {
        askTrust(untrustedCommandOf(info.details), 'connect')
        return false
      }
      connectError = `Could not connect to the MCP server: ${info.message}`
      return false
    }
  }

  async function disconnect() {
    connectError = null
    await mcpConnections.disconnect(key)
  }

  /**
   * Run = Send: the tab's send path (which connects first when needed). A command main refused lands in
   * `tab.untrustedCommand` (whatever started the send, e.g. the global Ctrl+Enter); the effect below asks about it.
   */
  async function run() {
    if (tab.sending) return
    await tabsStore.send(tab)
  }

  function save() {
    if (sync.blocked) return
    if (tab.requestId) void tabsStore.save(tab)
    else ui.saveAsTabId = tab.id
  }

  /** Ctrl/Cmd+Enter inside the editor runs through `run` (the tab strip and sidebar reach tabsStore.send directly). */
  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
    e.preventDefault()
    void run()
  }

  // --- Allowing a stdio command ---------------------------------------------------------------------------------------

  let trust = $state<(McpTrustCommandInput & { then: 'connect' | 'run'; secretKeys: string[] }) | null>(null)
  let trustBusy = $state(false)
  let trustError = $state<string | null>(null)

  function askTrust(command: McpTrustCommandInput, then: 'connect' | 'run') {
    trustError = null
    // Environment values that come from secret variables are not shown in the dialog.
    const scope = scopeStore.scopeFor(tab.collectionId)
    const secretKeys = dataRows(mcp.env)
      .filter((r) => r.enabled && r.key.trim() && findSecretsUsed([r.value], scope).length > 0)
      .map((r) => r.key.trim())
    trust = { ...command, then, secretKeys }
  }

  $effect(() => {
    const refused = tab.untrustedCommand
    if (!refused) return
    untrack(() => {
      tab.untrustedCommand = null
      askTrust(refused, 'run')
    })
  })

  async function allow() {
    if (!trust) return
    // A plain copy: IPC cannot clone the state proxy.
    const { then, secretKeys: _secretKeys, ...command } = $state.snapshot(trust)
    trustBusy = true
    trustError = null
    try {
      await api().mcpClientTrustCommand(command)
    } catch (e) {
      trustError = errorInfo(e).message
      return
    } finally {
      trustBusy = false
    }
    trust = null
    if (then === 'run') await run()
    else await connect()
  }

  // --- What the server offers ---------------------------------------------------------------------------------------

  let lists = $state<McpLists | null>(null)
  let listsLoading = $state(false)
  let listError = $state<string | null>(null)
  /** The last event of the session handled for list_changed notifications. */
  let lastSeen: McpClientEvent | null = null
  /** The session whose lists are shown (plain, so loads finishing after the view closed read no state). */
  let listSession: string | null = null

  const KINDS_FOR: Record<string, McpListKind[]> = { tools: ['tools'], resources: ['resources', 'resourceTemplates'], prompts: ['prompts'] }
  const LIST_LABEL: Record<McpListKind, string> = { tools: 'Tools', resources: 'Resources', resourceTemplates: 'Templates', prompts: 'Prompts' }

  /** Loads the given lists (default: every list the server declares a capability for). */
  async function loadLists(id: string, kinds?: McpListKind[]) {
    const caps = mcpConnections.info(key)?.capabilities ?? {}
    const wanted = kinds ?? (Object.keys(KINDS_FOR).filter((c) => c in caps).flatMap((c) => KINDS_FOR[c]) as McpListKind[])
    listsLoading = true
    listError = null
    // Each list on its own: a server that fails one (say, resource templates it declares but does not implement) still
    // shows the others.
    const results = await Promise.allSettled(wanted.map((k) => api().mcpClientList(id, k)))
    if (listSession !== id) return
    const next: McpLists = lists && kinds ? { ...lists, truncated: { ...lists.truncated } } : { tools: [], resources: [], resourceTemplates: [], prompts: [], truncated: {} }
    const failed: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        next[r.value.kind] = r.value.items
        next.truncated[r.value.kind] = r.value.truncated
      } else {
        failed.push(`${LIST_LABEL[wanted[i]]}: ${errorInfo(r.reason).message}`)
      }
    })
    lists = next
    listError = failed.length ? `Could not load ${failed.length === 1 ? 'a list' : 'some lists'} of the server. ${failed.join('; ')}` : null
    listsLoading = false
  }

  // A new session (Connect, or a Run that connected first) loads the lists; disconnecting clears them.
  $effect(() => {
    const id = sessionId
    lastSeen = null
    listSession = id
    if (!id) {
      lists = null
      listError = null
      listsLoading = false
      return
    }
    lists = null
    untrack(() => void loadLists(id))
  })

  // `notifications/*/list_changed` reloads that list.
  $effect(() => {
    const id = sessionId
    const events = mcpConnections.events(id)
    if (!id || events.length === 0) return
    const fresh: McpClientEvent[] = []
    for (let i = events.length - 1; i >= 0 && events[i] !== lastSeen; i--) fresh.push(events[i])
    lastSeen = events[events.length - 1]
    const kinds = new Set<McpListKind>()
    for (const e of fresh) {
      if (e.type !== 'notification') continue
      const method = (e.payload as { method?: unknown } | null)?.method
      const m = typeof method === 'string' ? /^notifications\/(tools|resources|prompts)\/list_changed$/.exec(method) : null
      if (m) for (const k of KINDS_FOR[m[1]]) kinds.add(k)
    }
    if (kinds.size > 0) untrack(() => lists && void loadLists(id, [...kinds]))
  })

  // Closing the tab closes its connection (switching to another tab keeps it open).
  onDestroy(() => {
    listSession = null
    const self = untrack(() => tab)
    queueMicrotask(() => {
      if (!tabsStore.tabs.includes(self)) void mcpConnections.disconnect(key)
    })
  })
</script>

<div id="request-panel" role="tabpanel" tabindex="-1" aria-labelledby="rtab-{tab.id}" class="flex min-h-0 flex-1 flex-col" {onkeydown}>
  <div class="flex items-center gap-2 border-b border-border px-3 pt-2 text-xs text-muted">
    <label for="req-name-{tab.id}" class="sr-only">Request name</label>
    <input
      id="req-name-{tab.id}"
      type="text"
      class="min-w-0 max-w-md flex-1 border-transparent bg-transparent px-1 text-sm font-medium text-fg hover:border-border focus:border-accent"
      value={tab.draft.name}
      oninput={(e) => (tab.draft.name = e.currentTarget.value)}
      placeholder="Request name"
    />
    {#if !tab.requestId}<span class="rounded bg-raised px-1.5 py-0.5">unsaved</span>{/if}
    <button type="button" class="ml-auto rounded px-2 py-1 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40" disabled={sync.blocked} title={sync.blocked ? sync.blockedMessage : undefined} onclick={() => (ui.saveAsTabId = tab.id)}>Save As…</button>
  </div>
  <TabNoticeBanner {tab} />
  <SyncSizeWarning {tab} />
  {#if sync.blocked && tab.dirty}<ReadOnlyNote class="mx-3 mt-2" />{/if}
  <McpBar
    {tab}
    {status}
    {statusText}
    onconnect={() => void connect()}
    ondisconnect={() => void disconnect()}
    onrun={() => void run()}
    oncancel={() => tabsStore.cancel(tab)}
    onsave={save}
    ontransportchange={() => void disconnect()}
  />
  {#if connectError && !conn}<p class="mx-3 mb-2 rounded border border-danger bg-danger-soft px-2 py-1.5 text-xs text-danger" role="alert" data-testid="mcp-connect-error">{connectError}</p>{/if}
  <SplitPane
    direction={settings.responsePosition === 'below' ? 'column' : 'row'}
    storageKey={splitKey('request', settings.responsePosition)}
    initial={0.5}
    min={settings.responsePosition === 'below' ? 0.15 : 0.25}
    class="min-h-0"
  >
    {#snippet action()}<ResponsePositionButton />{/snippet}
    {#snippet first()}
      <div class="flex h-full min-h-0 flex-col">
        <Tabs tabs={sections} value={section} onchange={(v) => (tab.section = tabSectionOf(v as McpSection))} label="MCP request sections" idPrefix="sec" class="scroll-strip shrink-0 overflow-x-auto overflow-y-hidden px-2" />
        <div class="min-h-0 flex-1 overflow-auto" role="tabpanel" id="sec-panel-{section}" aria-labelledby="sec-{section}">
          {#if section === 'call'}<McpCallPanel {tab} {lists} loading={listsLoading} {listError} onrefresh={() => sessionId && void loadLists(sessionId)} />
          {:else if section === 'connection'}<McpConnectionPanel {tab} />
          {:else if section === 'server'}<McpServerPanel info={conn?.info ?? null} />
          {:else if section === 'scripts'}<ScriptsPanel {tab} />
          {:else}<DocsPanel {tab} />
          {/if}
        </div>
      </div>
    {/snippet}
    {#snippet second()}
      <McpResultPane
        response={tab.error ? null : (tab.response?.data ?? null)}
        error={tab.error?.message ?? null}
        errorDetail={tab.error?.mcp ?? null}
        unresolved={tab.error?.unresolved ?? []}
        warnings={tab.warnings}
        scripts={tab.scriptOutput}
        onclearconsole={() => tab.scriptOutput && (tab.scriptOutput = { ...tab.scriptOutput, console: [] })}
        {sessionId}
        view={mcpResultViewOf(tab.responseView)}
        onviewchange={(v) => (tab.responseView = tabResultViewOf(v))}
      />
    {/snippet}
  </SplitPane>
</div>

{#if tab.conflict}<ConflictDialog {tab} />{/if}
{#if trust}
  <McpTrustDialog command={trust.command} args={trust.args} cwd={trust.cwd} env={trust.env} secretKeys={trust.secretKeys} busy={trustBusy} error={trustError} onallow={() => void allow()} oncancel={() => (trust = null)} />
{/if}
