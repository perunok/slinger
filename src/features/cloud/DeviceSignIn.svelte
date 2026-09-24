<script lang="ts">
  /** Device-flow sign-in UI. The main process polls; this only shows the code and reacts to the result. */
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { api } from '../../lib/ipc'
  import { sync } from '../sync/syncStore.svelte'

  /** Called before starting: persists the server settings. Return false to abort. */
  let { beforeStart }: { beforeStart: () => Promise<boolean> } = $props()

  const flow = $derived(sync.signIn)
  let actionError = $state<string | null>(null)
  let tick = $state(Math.floor(Date.now() / 1000))

  $effect(() => {
    if (flow.phase !== 'waiting') return
    const t = setInterval(() => (tick = Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  })

  const remaining = $derived(flow.expiresAt ? Math.max(0, flow.expiresAt - tick) : 0)
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const target = $derived(flow.info?.verificationUriComplete || flow.info?.verificationUri || '')

  async function start() {
    actionError = null
    if (await beforeStart()) await sync.startSignIn()
  }
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
      await navigator.clipboard.writeText(flow.info?.userCode ?? '')
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
    <p class="text-sm">Open the page below, sign in and enter this code to approve this device.</p>
    <p class="mono rounded border border-border bg-raised px-3 py-2 text-center text-xl tracking-widest" data-testid="user-code">{flow.info.userCode}</p>
    <p class="break-all text-xs text-muted">{flow.info.verificationUri}</p>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="primary" icon="external" onclick={open}>Open in browser</Button>
      <Button icon="copy" onclick={copy}>Copy code</Button>
      <Button variant="ghost" onclick={() => sync.cancelSignIn()}>Cancel</Button>
    </div>
    <p class="text-xs text-muted">Waiting for approval… the code expires in {mmss(remaining)}</p>
  {:else if flow.phase === 'starting'}
    <Button variant="primary" loading disabled>Requesting code…</Button>
  {:else if flow.phase === 'approved'}
    <p class="text-sm text-success">Approved. Loading your account…</p>
  {:else}
    <Button variant="primary" icon="cloud" onclick={start}>Sign in</Button>
    {#if messages[flow.phase]}<p class="text-xs text-warning">{flow.message || messages[flow.phase]}</p>{/if}
  {/if}
  <InlineError message={flow.phase === 'error' ? flow.message : actionError} />
</div>
