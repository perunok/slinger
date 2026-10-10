<script lang="ts">
  /**
   * Settings > AI assistants (MCP). The main path is one Connect button per assistant found on this computer (Slinger
   * writes its entry into that assistant's configuration); port, token and hand-made setups sit under "Other assistants".
   */
  import { onMount } from 'svelte'
  import type { McpClientStatus } from '../../../shared/mcp'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { formatAgo } from '../sync/status'
  import { mcp } from './mcpStore.svelte'
  import { MCP_MANUAL, mcpSnippet, type McpManualKind } from './snippets'

  let { now }: { now: number } = $props()

  onMount(() => {
    void mcp.load()
    void mcp.loadClients()
  })
  const status = $derived(mcp.status)
  const installed = $derived((mcp.clients ?? []).filter((c) => c.installed || c.state !== 'not-connected'))
  const missing = $derived((mcp.clients ?? []).filter((c) => !c.installed && c.state === 'not-connected'))
  let portText = $state('')
  $effect(() => {
    if (status) portText = String(status.port)
  })
  const portValue = $derived(Number(portText))
  const portInvalid = $derived(!Number.isInteger(portValue) || portValue < 1024 || portValue > 65535)
  let busy = $state(false)
  let confirmNewToken = $state(false)
  let manual = $state<McpManualKind>('command')
  /** Assistants connected in this visit: their "what now" hint stays visible. */
  let justConnected = $state<string[]>([])

  async function apply(next: { enabled: boolean; port: number }) {
    busy = true
    await mcp.save(next)
    busy = false
  }

  function savePort() {
    if (!status || portInvalid || portValue === status.port) return
    void apply({ enabled: status.enabled, port: portValue })
  }

  async function toggle(c: McpClientStatus) {
    const connect = c.state !== 'connected'
    if (await mcp.setConnected(c.id, connect)) {
      if (connect) {
        justConnected = [...justConnected, c.id]
        toast.success(`Slinger added to ${c.name}`, c.afterConnect)
      } else {
        justConnected = justConnected.filter((x) => x !== c.id)
        toast.success(`Slinger removed from ${c.name}`)
      }
    }
  }

  async function copy(what: 'url' | 'token' | McpManualKind) {
    if (!status) return
    try {
      const needsToken = what === 'token' || what === 'http'
      const token = needsToken ? await mcp.revealToken() : ''
      const text = what === 'url' ? status.url : what === 'token' ? token : mcpSnippet(what, status, token)
      await navigator.clipboard.writeText(text)
      toast.success(needsToken ? 'Copied (it contains the token: keep it private)' : 'Copied')
    } catch (e) {
      toast.error('Could not copy', errorInfo(e).message)
    }
  }
</script>

<section class="grid gap-4" aria-labelledby="mcp-heading">
  <h3 class="sr-only" id="mcp-heading">AI assistants (MCP)</h3>
  <div class="grid gap-1">
    <div class="flex items-center gap-1.5 text-sm">
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          checked={status?.enabled ?? false}
          disabled={!status || busy}
          onchange={(e) => status && void apply({ enabled: e.currentTarget.checked, port: status.port })}
        />
        Let AI assistants work in Slinger (MCP server)
      </label>
      <InfoTip label="About the MCP server">
        Claude, Cursor and other assistants that speak the Model Context Protocol can then browse and search your collections,
        create and edit requests, folders, collections and environments, send requests and run collections, exactly as if you
        clicked in Slinger; changes appear here at once and sends land in History. Secret variable values are never handed out
        (assistants can set them and use them through {'{{variables}}'}). It only listens on this computer and needs a token that
        connected assistants find by themselves.
      </InfoTip>
    </div>
    {#if status}
      <div class="flex flex-wrap items-center gap-2 text-xs" data-testid="mcp-status" aria-live="polite">
        {#if status.enabled && status.running}
          <span class="h-2 w-2 rounded-full bg-success" aria-hidden="true"></span>
          <span>On.</span>
          <span class="text-muted">
            {status.calls === 0 ? 'No tool calls yet.' : `${status.calls} tool call${status.calls === 1 ? '' : 's'}, last ${formatAgo(status.lastCallAt ?? now, now)}.`}
          </span>
          {#if status.portNote}<span class="text-muted">{status.portNote}</span>{/if}
        {:else if status.enabled && status.error}
          <span class="text-danger" role="alert">{status.error}</span>
        {:else}
          <span class="text-muted">Off. Connecting an assistant turns it on.</span>
        {/if}
      </div>
    {/if}
  </div>

  <div class="grid gap-2">
    <div class="flex items-center gap-1.5">
      <h4 class="text-sm font-semibold">Your assistants</h4>
      <InfoTip label="About connecting">
        Connect adds Slinger to that assistant's own settings file (a copy of the previous file is kept next to it as
        .slinger-backup); Disconnect removes it again. The entry has no token or port in it: it starts a small helper that finds
        them, and opens Slinger when it is not running. Slinger only changes these files when you click.
      </InfoTip>
    </div>
    {#if mcp.clients === null}
      <p class="text-xs text-muted">Looking for assistants…</p>
    {:else}
      {#if installed.length === 0}
        <p class="text-xs text-muted">No supported assistant was found on this computer. Use Other assistants below.</p>
      {:else}
        <ul class="divide-y divide-border rounded border border-border" aria-label="Assistants">
          {#each installed as c (c.id)}
            <li class="grid gap-1 px-3 py-2" data-testid="mcp-client-{c.id}">
              <div class="flex items-center gap-2 text-sm">
                <span class="min-w-0 flex-1 font-medium">{c.name}</span>
                {#if c.state === 'connected'}
                  <span class="text-xs text-success">Connected</span>
                {:else if c.state === 'outdated'}
                  <span class="text-xs text-warning" title="Its entry points to another Slinger installation">Needs updating</span>
                {/if}
                <Button
                  size="sm"
                  variant={c.state === 'connected' ? 'ghost' : 'primary'}
                  loading={mcp.busyClient === c.id}
                  disabled={mcp.busyClient !== null}
                  onclick={() => void toggle(c)}
                  >{c.state === 'connected' ? 'Disconnect' : c.state === 'outdated' ? 'Update' : 'Connect'}</Button
                >
              </div>
              {#if mcp.clientError?.id === c.id}
                <p class="text-xs text-danger" role="alert">{mcp.clientError.message}</p>
              {:else if c.state === 'connected' && justConnected.includes(c.id)}
                <p class="text-xs text-muted">{c.afterConnect}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
      {#if missing.length > 0}
        <p class="text-xs text-faint">Not found on this computer: {missing.map((c) => c.name).join(', ')}.</p>
      {/if}
    {/if}
  </div>

  {#if status}
    <details class="grid gap-3 text-sm">
      <summary class="cursor-pointer select-none text-sm font-semibold">Other assistants and advanced</summary>
      <div class="mt-3 grid gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <label for="mcp-port">Port</label>
          <input
            id="mcp-port"
            class="field w-24"
            inputmode="numeric"
            bind:value={portText}
            disabled={busy}
            aria-invalid={portInvalid}
            onblur={savePort}
            onkeydown={(e) => e.key === 'Enter' && savePort()}
          />
          {#if portInvalid}<span class="text-xs text-danger">1024 to 65535</span>{/if}
          <span class="ml-4">Token</span>
          <code class="mono text-xs text-muted">slg_••••••••</code>
          <Button size="sm" icon="copy" onclick={() => void copy('token')}>Copy</Button>
          <Button size="sm" variant="ghost" onclick={() => (confirmNewToken = true)}>New token</Button>
          <InfoTip label="About port and token">
            If the port is taken, Slinger uses one of the next ten. Connected assistants follow port and token changes by
            themselves; only hand-made URL setups need the new values.
          </InfoTip>
        </div>
        <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Manual setup">
          {#each MCP_MANUAL as m (m.id)}
            <Button size="sm" variant={manual === m.id ? 'primary' : 'ghost'} role="radio" aria-checked={manual === m.id} onclick={() => (manual = m.id)}>{m.label}</Button>
          {/each}
        </div>
        <p class="text-xs text-muted">{MCP_MANUAL.find((m) => m.id === manual)?.hint}</p>
        <pre class="mono max-h-48 overflow-auto rounded border border-border bg-surface-raised p-2 text-xs" data-testid="mcp-snippet">{mcpSnippet(manual, status, '<token>')}</pre>
        <div><Button size="sm" icon="copy" onclick={() => void copy(manual)}>Copy setup</Button></div>
      </div>
    </details>
  {:else if mcp.error}
    <p class="text-xs text-danger" role="alert">{mcp.error}</p>
  {/if}
</section>

{#if confirmNewToken}
  <ConfirmDialog
    title="New MCP token"
    message="Connected assistants pick up the new token by themselves; hand-made URL setups stop working until you give them the new one."
    confirmLabel="Make a new token"
    onconfirm={async () => {
      await mcp.regenerateToken()
      confirmNewToken = false
    }}
    oncancel={() => (confirmNewToken = false)}
  />
{/if}
