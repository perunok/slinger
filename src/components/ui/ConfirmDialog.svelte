<script lang="ts">
  import Button from './Button.svelte'
  import Dialog from './Dialog.svelte'
  import { errorInfo } from '../../lib/ipc'

  interface Props {
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
    /** Runs on confirm. The dialog closes only when it resolves; a rejection is shown inline. */
    onconfirm: () => Promise<void> | void
    oncancel: () => void
    /** Optional extra content (e.g. a hint or a checkbox). */
    extra?: import('svelte').Snippet
  }
  let { title, message, confirmLabel = 'Confirm', danger = false, onconfirm, oncancel, extra }: Props = $props()
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function run() {
    busy = true
    error = null
    try {
      await onconfirm()
      oncancel()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }
</script>

<Dialog {title} onclose={oncancel} size="sm" {busy}>
  <p class="whitespace-pre-line text-sm">{message}</p>
  {@render extra?.()}
  {#if error}
    <p role="alert" class="mt-3 rounded border border-danger bg-danger-soft px-2 py-1.5 text-xs text-danger">{error}</p>
  {/if}
  {#snippet footer()}
    <Button onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button variant={danger ? 'danger' : 'primary'} loading={busy} onclick={run} data-autofocus>{confirmLabel}</Button>
  {/snippet}
</Dialog>
