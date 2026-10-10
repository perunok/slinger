<script lang="ts">
  /** The Server section of an MCP request: what the connected server reported when it was initialized. */
  import type { McpSessionInfo } from '../../../shared/types'
  import MarkdownView from '../../components/markdown/MarkdownView.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'

  let { info }: { info: McpSessionInfo | null } = $props()

  /** Capability names with a short note of what they include (e.g. "tools (listChanged)"). */
  const capabilities = $derived(
    Object.entries(info?.capabilities ?? {}).map(([name, value]) => {
      const flags = value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).filter(([, v]) => v === true).map(([k]) => k) : []
      return { name, flags }
    }),
  )
</script>

<div class="space-y-4 p-3 text-sm">
  {#if !info}
    <p class="text-muted" data-testid="mcp-server-empty">Not connected. Click Connect to see the server's name, version, capabilities and instructions.</p>
  {:else}
    <dl class="grid max-w-xl grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
      <dt class="text-xs text-muted">Name</dt>
      <dd data-testid="mcp-server-name">{info.serverInfo.title ? `${info.serverInfo.title} (${info.serverInfo.name})` : info.serverInfo.name}</dd>
      <dt class="text-xs text-muted">Version</dt>
      <dd class="font-mono text-xs">{info.serverInfo.version}</dd>
      <dt class="text-xs text-muted">Protocol version</dt>
      <dd class="font-mono text-xs">{info.protocolVersion ?? 'unknown'}</dd>
      <dt class="text-xs text-muted">Connected in</dt>
      <dd class="text-xs">{info.connectMs} ms</dd>
    </dl>

    <section>
      <h3 class="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Capabilities
        <InfoTip label="About server capabilities">
          <span>What the server said it supports when the connection started. "listChanged" means it tells Slinger when that list changes, and Slinger then reloads it.</span>
        </InfoTip>
      </h3>
      {#if capabilities.length === 0}
        <p class="text-xs text-faint">None declared.</p>
      {:else}
        <ul class="flex flex-wrap gap-1.5" data-testid="mcp-server-capabilities">
          {#each capabilities as c (c.name)}
            <li class="rounded bg-raised px-1.5 py-0.5 font-mono text-xs">{c.name}{#if c.flags.length}<span class="text-muted"> ({c.flags.join(', ')})</span>{/if}</li>
          {/each}
        </ul>
      {/if}
      <details class="mt-2">
        <summary class="cursor-pointer text-xs text-muted hover:text-fg">Raw capabilities</summary>
        <pre class="mt-1 overflow-auto rounded bg-raised p-2 font-mono text-xs">{JSON.stringify(info.capabilities, null, 2)}</pre>
      </details>
    </section>

    <section>
      <h3 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Instructions</h3>
      {#if info.instructions?.trim()}
        <MarkdownView source={info.instructions} label="Server instructions" />
      {:else}
        <p class="text-xs text-faint">The server sent no instructions.</p>
      {/if}
    </section>
  {/if}
</div>
