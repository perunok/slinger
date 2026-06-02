<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte'

  export let collectionName: string
  export let defaultValue: string
  export let mode: 'path' | 'file' = 'path'

  const dispatch = createEventDispatcher<{
    export: string
    cancel: void
  }>()

  let valueDraft = defaultValue
  let inputRef: HTMLInputElement

  $: label = mode === 'path' ? 'Path' : 'File name'
  $: canExport = Boolean(valueDraft.trim())

  function handleSubmit() {
    if (!canExport) return
    dispatch('export', valueDraft.trim())
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch('cancel')
    }
  }

  onMount(() => {
    inputRef?.focus()
    inputRef?.select()
    window.addEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
</script>

<div class="export-collection-backdrop">
  <form class="export-collection-dialog" on:submit|preventDefault={handleSubmit}>
    <h2>Export collection</h2>
    <p class="export-collection-name">{collectionName}</p>

    <label>
      <span>{label}</span>
      <input
        bind:this={inputRef}
        bind:value={valueDraft}
        class="export-collection-input"
      />
    </label>

    <div class="export-collection-actions">
      <button class="secondary-button h-8" type="button" on:click={() => dispatch('cancel')}>
        Cancel
      </button>
      <button class="primary-button h-8" type="submit" disabled={!canExport}>
        Export
      </button>
    </div>
  </form>
</div>

<style>
  .export-collection-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.46);
    padding: 1rem;
  }

  .export-collection-dialog {
    width: min(100%, 32rem);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-alt);
    color: var(--text);
    box-shadow: 0 24px 90px rgba(0, 0, 0, 0.36);
    padding: 1rem;
  }

  .export-collection-dialog h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }

  .export-collection-name {
    margin: 0.35rem 0 0;
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .export-collection-dialog label {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.9rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .export-collection-input {
    height: 2rem;
    border: 1px solid var(--input-border);
    border-radius: 0.25rem;
    background: var(--input);
    color: var(--text);
    padding: 0 0.65rem;
    font-size: 0.875rem;
    outline: none;
  }

  .export-collection-input:focus {
    border-color: #5a8fff;
  }

  .export-collection-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
