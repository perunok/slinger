<script lang="ts">
  /** Asks for a single name. Closes only after `onsubmit` resolves; failures show inline. */
  import { untrack } from 'svelte'
  import { errorInfo } from '../../lib/ipc'
  import Button from './Button.svelte'
  import Dialog from './Dialog.svelte'
  import InlineError from './InlineError.svelte'

  interface Props {
    title: string
    label: string
    initial?: string
    submitLabel?: string
    placeholder?: string
    onsubmit: (name: string) => Promise<void> | void
    oncancel: () => void
  }
  let { title, label, initial = '', submitLabel = 'Save', placeholder = '', onsubmit, oncancel }: Props = $props()

  let name = $state(untrack(() => initial))
  let busy = $state(false)
  let error = $state<string | null>(null)
  const valid = $derived(name.trim().length > 0)
  const inputId = `name-${Math.random().toString(36).slice(2, 8)}`

  async function submit(e?: Event) {
    e?.preventDefault()
    if (!valid || busy) return
    busy = true
    error = null
    try {
      await onsubmit(name.trim())
      oncancel()
    } catch (err) {
      error = errorInfo(err).message
    } finally {
      busy = false
    }
  }
</script>

<Dialog {title} onclose={oncancel} size="sm" {busy}>
  <form onsubmit={submit} id="{inputId}-form" class="grid gap-2">
    <label for={inputId} class="text-xs text-muted">{label}</label>
    <input
      id={inputId}
      type="text"
      class="w-full"
      bind:value={name}
      {placeholder}
      data-autofocus
      autocomplete="off"
      onfocus={(e) => e.currentTarget.select()}
    />
    <InlineError message={error} />
  </form>
  {#snippet footer()}
    <Button onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button variant="primary" type="submit" form="{inputId}-form" loading={busy} disabled={!valid}>{submitLabel}</Button>
  {/snippet}
</Dialog>
