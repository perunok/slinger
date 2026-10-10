<script lang="ts">
  /**
   * The Connection section of an MCP request: how Slinger reaches the server. HTTP and SSE use the request's headers and
   * authorization (the HTTP request editor's own Authorization panel); a command (stdio) gets extra environment
   * variables and a working directory. The call timeout applies to every transport.
   */
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import KeyValueTable from '../../components/kv/KeyValueTable.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import type { McpDraft } from '../../lib/mcpRequest'
  import { MCP_MAX_TIMEOUT_MS } from '../../lib/prepare'
  import AuthPanel from '../requests/AuthPanel.svelte'
  import type { RequestTab } from '../requests/tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const mcp = $derived(tab.draft.mcp as McpDraft)

  function setTimeoutMs(v: string) {
    const n = Number(v)
    mcp.timeoutMs = v.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : Math.min(Math.round(n), MCP_MAX_TIMEOUT_MS)
  }
</script>

<div class="space-y-5 p-3">
  {#if mcp.transport === 'stdio'}
    <section aria-labelledby="mcp-env-{tab.id}">
      <h3 id="mcp-env-{tab.id}" class="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Environment
        <InfoTip label="About the command's environment">
          <span>Extra environment variables for the command, on top of a minimal safe set (PATH, HOME and the like). Values may use <code>{'{{variables}}'}</code>, including secrets.</span>
        </InfoTip>
      </h3>
      <KeyValueTable rows={mcp.env} onchange={(rows) => (mcp.env = rows)} noun="Environment variable" keyPlaceholder="NAME" description={false} duplicates="exact" />
    </section>
    <section class="grid max-w-xl gap-1">
      <span class="flex items-center gap-1 text-xs text-muted">
        Working directory
        <InfoTip label="About the working directory">
          <span>Where the command starts. Leave empty to start it in your home directory.</span>
        </InfoTip>
      </span>
      <div class="rounded border border-border bg-surface px-1 py-0.5 focus-within:border-accent">
        <TemplateInput class="w-full !border-transparent" mono label="Working directory" placeholder="Home directory" value={mcp.cwd} oninput={(v) => (mcp.cwd = v)} />
      </div>
    </section>
  {:else}
    <section aria-labelledby="mcp-headers-{tab.id}">
      <h3 id="mcp-headers-{tab.id}" class="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Headers
        <InfoTip label="About connection headers">
          <span>Sent with every HTTP request of the connection, including the first one. The authorization below is added as a header too.</span>
        </InfoTip>
      </h3>
      <KeyValueTable rows={tab.draft.headers} onchange={(rows) => (tab.draft.headers = rows)} noun="Header" keyPlaceholder="Header" suggestions="headers" duplicates="case-insensitive" />
    </section>
    <section aria-labelledby="mcp-auth-{tab.id}">
      <h3 id="mcp-auth-{tab.id}" class="-mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Authorization
        <InfoTip label="About MCP authorization">
          <span>Slinger does not run MCP's own OAuth discovery. Use a bearer token, Basic auth, an API key, or OAuth 2.0 with the server's endpoints entered by hand.</span>
        </InfoTip>
      </h3>
      <div class="-mx-3"><AuthPanel {tab} /></div>
    </section>
  {/if}
  <section class="grid max-w-md gap-1">
    <label for="mcp-timeout-{tab.id}" class="text-xs text-muted">Call timeout (milliseconds)</label>
    <input id="mcp-timeout-{tab.id}" type="number" min="1" max={MCP_MAX_TIMEOUT_MS} step="1000" class="w-48" placeholder="60000" value={mcp.timeoutMs ?? ''} oninput={(e) => setTimeoutMs(e.currentTarget.value)} />
    <p class="text-xs text-faint">Leave empty for the default of 60 seconds; at most 600 000 (10 minutes). A call that takes longer is cancelled.</p>
  </section>
</div>
