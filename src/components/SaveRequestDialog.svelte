<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte'
  import type { Collection } from '../tauri'

  export let collections: Collection[]
  export let requestName: string
  export let selectedCollectionId: string | null

  const dispatch = createEventDispatcher<{
    save: { name: string; collectionId: string }
    cancel: void
  }>()

  let nameDraft = requestName
  let collectionId = selectedCollectionId ?? collections[0]?.id ?? ''
  let nameInputRef: HTMLInputElement

  $: canSave = Boolean(nameDraft.trim() && collectionId)

  function handleSubmit() {
    if (!canSave) return
    dispatch('save', {
      name: nameDraft.trim(),
      collectionId,
    })
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch('cancel')
    }
  }

  onMount(() => {
    nameInputRef?.focus()
    nameInputRef?.select()
    window.addEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
</script>

<div class="save-request-backdrop">
  <form class="save-request-dialog" on:submit|preventDefault={handleSubmit}>
    <h2>Save request</h2>

    <label>
      <span>Name</span>
      <input
        bind:this={nameInputRef}
        bind:value={nameDraft}
        class="save-request-input"
      />
    </label>

    <label>
      <span>Collection</span>
      <select bind:value={collectionId} class="save-request-input" disabled={collections.length === 0}>
        {#each collections as collection (collection.id)}
          <option value={collection.id}>{collection.name}</option>
        {/each}
      </select>
    </label>

    {#if collections.length === 0}
      <p class="save-request-empty">Create a collection before saving this request.</p>
    {/if}

    <div class="save-request-actions">
      <button class="secondary-button h-8" type="button" on:click={() => dispatch('cancel')}>
        Cancel
      </button>
      <button class="primary-button h-8" type="submit" disabled={!canSave}>
        Save
      </button>
    </div>
  </form>
</div>

<style>
  .save-request-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.46);
    padding: 1rem;
  }

  .save-request-dialog {
    width: min(100%, 28rem);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-alt);
    color: var(--text);
    box-shadow: 0 24px 90px rgba(0, 0, 0, 0.36);
    padding: 1rem;
  }

  .save-request-dialog h2 {
    margin: 0 0 1rem;
    font-size: 1rem;
    font-weight: 700;
  }

  .save-request-dialog label {
    display: grid;
    gap: 0.35rem;
    margin-top: 0.75rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .save-request-input {
    height: 2rem;
    border: 1px solid var(--input-border);
    border-radius: 0.25rem;
    background: var(--input);
    color: var(--text);
    padding: 0 0.65rem;
    font-size: 0.875rem;
    outline: none;
  }

  .save-request-input:focus {
    border-color: #5a8fff;
  }

  .save-request-empty {
    margin: 0.75rem 0 0;
    color: var(--muted);
    font-size: 0.8125rem;
  }

  .save-request-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
