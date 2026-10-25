<script lang="ts">
  /**
   * The response viewer's Spec chip: how the response compares with the collection's OpenAPI document. A failed check
   * opens a list of the problems (path + message) and what was checked (operation, documented response). Nothing is
   * shown when there is no document or the request is not one of its operations.
   */
  import type { OpenApiValidation } from '../../../shared/types'
  import Icon from '../../components/ui/Icon.svelte'

  let { result }: { result: OpenApiValidation } = $props()

  const WIDTH = 420
  const id = `spec-${Math.random().toString(36).slice(2, 10)}`
  let button = $state<HTMLButtonElement | null>(null)
  let panel = $state<HTMLDivElement | null>(null)
  let open = $state(false)
  let pos = $state({ left: 0, top: 0 })

  const failed = $derived(result.status === 'invalid' || result.status === 'not-json')
  const label = $derived(
    result.status === 'valid'
      ? 'Matches spec'
      : failed
        ? `${result.errors.length} spec error${result.errors.length === 1 ? '' : 's'}`
        : 'No schema in spec',
  )
  const checked = $derived(result.operation ? `${result.operation}${result.responseKey ? ` → ${result.responseKey}` : ''}` : '')
  const title = $derived(
    result.status === 'valid'
      ? `The response matches the OpenAPI document (${checked})`
      : failed
        ? 'Show where the response differs from the OpenAPI document'
        : `The OpenAPI document has no schema for this response (${checked})`,
  )
  const tone = $derived(result.status === 'valid' ? 'bg-success-soft text-success' : failed ? 'bg-danger-soft text-danger' : 'bg-raised text-muted')

  // A new result closes the list of the previous one.
  $effect(() => {
    void result
    open = false
  })

  function toggle() {
    if (!failed || !button) return
    if (open) {
      open = false
      return
    }
    const r = button.getBoundingClientRect()
    pos = { left: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)), top: r.bottom + 4 }
    open = true
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      open = false
      button?.focus()
    }
  }

  // A click anywhere else closes the list.
  function onpointerdown(e: PointerEvent) {
    const t = e.target as Node | null
    if (open && t && !button?.contains(t) && !panel?.contains(t)) open = false
  }
</script>

<svelte:window {onkeydown} {onpointerdown} />

{#if result.status !== 'no-spec' && result.status !== 'no-operation'}
  {#if failed}
    <button
      bind:this={button}
      type="button"
      class="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus {tone}"
      data-testid="spec-chip"
      data-status={result.status}
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      {title}
      onclick={toggle}
    >
      {label}<Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
    </button>
  {:else}
    <span class="rounded px-2 py-0.5 text-xs font-medium {tone}" data-testid="spec-chip" data-status={result.status} {title}>{label}</span>
  {/if}
{/if}

{#if open && failed}
  <div
    bind:this={panel}
    {id}
    role="region"
    aria-label="Spec errors"
    class="fixed z-50 max-h-72 overflow-auto rounded-md border border-strong bg-surface p-2 text-xs shadow-pop"
    style="left: {pos.left}px; top: {pos.top}px; width: {WIDTH}px; max-width: calc(100vw - 16px)"
  >
    {#if checked}<p class="mb-1 text-faint">Checked against <span class="font-mono">{checked}</span></p>{/if}
    <ul class="flex flex-col gap-1" aria-label="Problems">
      {#each result.errors as e, i (i)}
        <li class="break-words"><span class="font-mono text-danger">{e.path}</span> {e.message}</li>
      {/each}
    </ul>
  </div>
{/if}
