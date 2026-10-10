<script lang="ts">
  /** Settings > AI assistants (MCP): turn the local MCP endpoint on, see where it runs, copy client setups. */
  import { onMount } from 'svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { formatAgo } from '../sync/status'
  import { mcp } from './mcpStore.svelte'
  import { MCP_CLIENTS, mcpSnippet, type McpClientKind } from './snippets'

  let { now }: { now: number } = $props()

  onMount(() => void mcp.load())
  const status = $derived(mcp.status)
  let portText = $state('')
  $effect(() => {
    if (status) portText = String(status.port)
  })
  const portValue = $derived(Number(portText))
  const portInvalid = $derived(!Number.isInteger(portValue) || portValue < 1024 || portValue > 65535)
  let busy = $state(false)
  let confirmNewToken = $state(false)
  let client = $state<McpClientKind>('claude-code')

  async function apply(next: { enabled: boolean; port: number }) {
    busy = true
    await mcp.save(next)
    busy = false
  }

  function savePort() {
    if (!status || portInvalid || portValue === status.port) return
    void apply({ enabled: status.enabled, port: portValue })
  }

  async function copy(what: 'url' | 'token' | McpClientKind) {
    if (!status) return
    try {
      const text = what === 'url' ? status.url : what === 'token' ? await mcp.revealToken() : mcpSnippet(what, status, await mcp.revealToken())
      await navigator.clipboard.writeText(text)
      toast.success(what === 'url' ? 'Copied' : 'Copied (it contains the token: keep it private)')
    } catch (e) {
      toast.error('Could not copy', errorInfo(e).message)
    }
  }
</script>

<section class="grid gap-3" aria-labelledby="mcp-heading">
  <h3 class="sr-only" id="mcp-heading">AI assistants (MCP)</h3>
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
      Claude, Cursor and other assistants that speak the Model Context Protocol can then browse and search your collections, create
      and edit requests, folders, collections and environments, send requests and run collections, exactly as if you clicked in
      Slinger; changes appear here at once and sends land in History. Secret variable values are never handed out (assistants can set
      them and use them through {'{{variables}}'}). It only listens on this computer (127.0.0.1), needs the token below, and works
      while Slinger is open.
    </InfoTip>
  </div>

  {#if status}
    <div class="flex flex-wrap items-center gap-2 text-xs" data-testid="mcp-status" aria-live="polite">
      {#if status.enabled && status.running}
        <span class="h-2 w-2 rounded-full bg-success" aria-hidden="true"></span>
        <span>Running at <code class="mono">{status.url}</code></span>
        <Button size="sm" variant="ghost" icon="copy" onclick={() => void copy('url')}>Copy URL</Button>
        <span class="text-muted">
          {status.calls === 0 ? 'No tool calls yet.' : `${status.calls} tool call${status.calls === 1 ? '' : 's'}, last ${formatAgo(status.lastCallAt ?? now, now)}.`}
        </span>
      {:else if status.enabled && status.error}
        <span class="text-danger" role="alert">{status.error}</span>
      {:else}
        <span class="text-muted">Off.</span>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-2 text-sm">
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
      <InfoTip label="About the token">
        Every assistant needs this token (it is part of the setups below). It is kept in your system keychain. A new token locks out
        every assistant set up with the old one.
      </InfoTip>
    </div>

    <div class="grid gap-2">
      <div class="flex items-center gap-1.5">
        <h4 class="text-sm font-semibold">Connect an assistant</h4>
        <InfoTip label="About connecting">
          Copy puts the setup with your real token on the clipboard (the text shown here has a placeholder). Claude Desktop starts
          Slinger's small built-in bridge program, which forwards to the running app.
        </InfoTip>
      </div>
      <div class="flex flex-wrap gap-1" role="radiogroup" aria-label="Assistant">
        {#each MCP_CLIENTS as c (c.id)}
          <Button size="sm" variant={client === c.id ? 'primary' : 'ghost'} role="radio" aria-checked={client === c.id} onclick={() => (client = c.id)}>{c.label}</Button>
        {/each}
      </div>
      <p class="text-xs text-muted">{MCP_CLIENTS.find((c) => c.id === client)?.hint}</p>
      <pre class="mono max-h-48 overflow-auto rounded border border-border bg-surface-raised p-2 text-xs" data-testid="mcp-snippet">{mcpSnippet(client, status, '<token>')}</pre>
      <div><Button size="sm" icon="copy" onclick={() => void copy(client)}>Copy setup</Button></div>
    </div>
  {:else if mcp.error}
    <p class="text-xs text-danger" role="alert">{mcp.error}</p>
  {/if}
</section>

{#if confirmNewToken}
  <ConfirmDialog
    title="New MCP token"
    message="Assistants set up with the current token stop working until you give them the new one."
    confirmLabel="Make a new token"
    onconfirm={async () => {
      await mcp.regenerateToken()
      confirmNewToken = false
    }}
    oncancel={() => (confirmNewToken = false)}
  />
{/if}
