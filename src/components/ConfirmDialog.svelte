<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte'

  export let message: string
  export let confirmLabel = 'Confirm'
  export let tone: 'default' | 'danger' = 'default'

  const dispatch = createEventDispatcher<{
    confirm: void
    cancel: void
  }>()

  let cancelButtonRef: HTMLButtonElement

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch('cancel')
    }
  }

  onMount(() => {
    cancelButtonRef?.focus()
    window.addEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
</script>

<div class="confirm-backdrop">
  <section
    class="confirm-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="confirm-title"
  >
    <h2 id="confirm-title">Are you sure?</h2>
    <p>{message}</p>
    <div class="confirm-actions">
      <button
        bind:this={cancelButtonRef}
        class="secondary-button h-8"
        type="button"
        on:click={() => dispatch('cancel')}
      >
        Cancel
      </button>
      <button
        class={`primary-button h-8 ${tone === 'danger' ? 'danger' : ''}`}
        type="button"
        on:click={() => dispatch('confirm')}
      >
        {confirmLabel}
      </button>
    </div>
  </section>
</div>

<style>
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.46);
    padding: 1rem;
  }

  .confirm-dialog {
    width: min(100%, 26rem);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-alt);
    color: var(--text);
    box-shadow: 0 24px 90px rgba(0, 0, 0, 0.36);
    padding: 1rem;
  }

  .confirm-dialog h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }

  .confirm-dialog p {
    margin: 0.75rem 0 0;
    color: var(--muted);
    font-size: 0.875rem;
    line-height: 1.5;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .primary-button.danger {
    background: #dc2626;
  }

  .primary-button.danger:hover {
    background: #ef4444;
  }
</style>
