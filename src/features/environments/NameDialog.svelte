<script lang="ts">
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'

  interface Props {
    title: string
    initial?: string
    confirmLabel: string
    /** Closes only when this resolves; a rejection is shown inline. */
    onsubmit: (name: string) => Promise<void>
    oncancel: () => void
    /** Live validation (e.g. duplicate names); a non-null message is shown inline and blocks submit. */
    validate?: (name: string) => string | null
  }
  let { title, initial = '', confirmLabel, onsubmit, oncancel, validate }: Props = $props()
  let name = $state('')
  // svelte-ignore state_referenced_locally
  name = initial
  let busy = $state(false)
  let error = $state<string | null>(null)
  let touched = $state(false)
  const issue = $derived(validate ? validate(name) : null)
  // Show the live issue once the user has typed; an empty untouched field is not an error yet.
  const shown = $derived(error ?? (touched ? issue : null))

  async function submit(e: Event) {
    e.preventDefault()
    touched = true
    if (issue) return
    busy = true
    error = null
    try {
      await onsubmit(name)
      oncancel()
    } catch (err) {
      error = errorInfo(err).message
    } finally {
      busy = false
    }
  }
</script>

<Dialog {title} onclose={oncancel} size="sm" {busy}>
  <form id="env-name-form" onsubmit={submit} class="flex flex-col gap-2">
    <label class="text-xs text-muted" for="env-name-input">Environment name</label>
    <input
      id="env-name-input"
      data-autofocus
      bind:value={name}
      oninput={() => ((touched = true), (error = null))}
      autocomplete="off"
      aria-invalid={shown ? 'true' : undefined}
      class="h-8 rounded border border-border bg-surface px-2 text-sm outline-none focus:border-accent"
    />
    <InlineError message={shown} />
  </form>
  {#snippet footer()}
    <Button onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button variant="primary" type="submit" form="env-name-form" loading={busy} disabled={touched && !!issue}>{confirmLabel}</Button>
  {/snippet}
</Dialog>
