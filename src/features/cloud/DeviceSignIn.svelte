<script lang="ts">
  import { errorInfo } from '../../lib/ipc'
  import { onDestroy } from 'svelte'
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { api } from '../../lib/ipc'
  import { cloud } from './cloudStore.svelte'
  import { DeviceFlow } from './deviceFlow.svelte'

  const flow = new DeviceFlow({
    start: () => cloud.client().deviceStart(cloud.config.deviceName),
    poll: (code) => cloud.client().devicePoll(code),
    onApproved: (tokens) => cloud.completeSignIn(tokens),
  })
  // No leaked timers when the dialog closes.
  onDestroy(() => flow.dispose())

  let actionError = $state<string | null>(null)

  function start() {
    if (cloud.applyConfig(cloud.config)) void flow.begin()
  }

  const target = $derived(flow.info?.verification_uri_complete || flow.info?.verification_uri || '')
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  async function open() {
    actionError = null
    try {
      await api().openExternalUrl(target)
    } catch (e) {
      actionError = errorInfo(e).message
    }
  }
  async function copy() {
    actionError = null
    try {
      await navigator.clipboard.writeText(flow.info?.user_code ?? '')
    } catch (e) {
      actionError = errorInfo(e).message
    }
  }
  const messages: Record<string, string> = {
    expired: 'The code expired. Start again.',
    denied: 'Sign-in was denied in the browser.',
    cancelled: 'Sign-in cancelled.',
  }
</script>

<div class="space-y-3" aria-live="polite">
  {#if flow.phase === 'waiting' && flow.info}
    <p class="text-sm">Open the page below and enter this code to approve this device.</p>
    <p class="mono rounded border border-border bg-raised px-3 py-2 text-center text-xl tracking-widest" data-testid="user-code">{flow.info.user_code}</p>
    <p class="break-all text-xs text-muted">{flow.info.verification_uri}</p>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="primary" icon="external" onclick={open}>Open in browser</Button>
      <Button icon="copy" onclick={copy}>Copy code</Button>
      <Button variant="ghost" onclick={() => flow.cancel()}>Cancel</Button>
    </div>
    <p class="text-xs text-muted">Waiting for approval… code expires in {mmss(flow.remaining)}</p>
  {:else if flow.phase === 'starting'}
    <Button variant="primary" loading disabled>Requesting code…</Button>
  {:else if flow.phase === 'approved'}
    <p class="text-sm text-success">Approved. Loading your account…</p>
  {:else}
    <Button variant="primary" icon="cloud" onclick={start}>Sign in</Button>
    {#if messages[flow.phase]}<p class="text-xs text-warning">{messages[flow.phase]}</p>{/if}
  {/if}
  <InlineError message={flow.error ?? actionError} />
</div>
