<script lang="ts">
  /**
   * Asks before Slinger starts a stdio MCP server command for the first time on this device. Main refuses untrusted
   * commands (collections can be synced, imported or written by AI assistants), so this is the only way one gets allowed:
   * the user sees the exact command, arguments, working directory and extra environment (resolved values; environment
   * values that come from secret variables stay hidden) and clicks Allow.
   */
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'

  interface Props {
    command: string
    args: string[]
    cwd: string
    /** The extra environment variables, resolved. */
    env?: Array<{ key: string; value: string }>
    /** Environment variables whose value comes from a secret: shown masked. */
    secretKeys?: string[]
    /** While the command is being allowed and the connection retried. */
    busy?: boolean
    error?: string | null
    onallow: () => void
    oncancel: () => void
  }
  let { command, args, cwd, env = [], secretKeys = [], busy = false, error = null, onallow, oncancel }: Props = $props()
</script>

<Dialog title="Allow Slinger to run this command on this computer?" onclose={oncancel} {busy}>
  <div class="space-y-3 text-sm">
    <p>
      This MCP request starts a program on this computer. It runs with your user's permissions, so allow it only if you trust
      where the request came from. Slinger asks again whenever the command, its arguments, the working directory or the
      environment variables change.
    </p>
    <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5">
      <dt class="text-xs text-muted">Command</dt>
      <dd class="break-all font-mono text-xs" data-testid="trust-command">{command}</dd>
      <dt class="text-xs text-muted">Arguments</dt>
      <dd class="font-mono text-xs" data-testid="trust-args">
        {#if args.length === 0}<span class="text-faint">none</span>{:else}
          <ol class="space-y-0.5">
            {#each args as a, i (i)}<li class="break-all rounded bg-raised px-1">{a}</li>{/each}
          </ol>
        {/if}
      </dd>
      <dt class="text-xs text-muted">Working directory</dt>
      <dd class="break-all font-mono text-xs" data-testid="trust-cwd">{#if cwd}{cwd}{:else}<span class="text-faint">your home directory</span>{/if}</dd>
      <dt class="text-xs text-muted">Environment</dt>
      <dd class="font-mono text-xs" data-testid="trust-env">
        {#if env.length === 0}<span class="text-faint">none added</span>{:else}
          <ul class="space-y-0.5">
            {#each env as e, i (i)}
              <li class="break-all rounded bg-raised px-1">
                {e.key}={#if secretKeys.includes(e.key)}<span class="text-faint" title="The value of a secret variable">••••••••</span>{:else}{e.value}{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </dd>
    </dl>
    {#if error}<InlineError message={error} />{/if}
  </div>
  {#snippet footer()}
    <!-- Cancel has the focus: Enter must never allow a command by accident. -->
    <Button onclick={oncancel} disabled={busy} data-autofocus>Cancel</Button>
    <Button variant="primary" onclick={onallow} loading={busy}>Allow and connect</Button>
  {/snippet}
</Dialog>
