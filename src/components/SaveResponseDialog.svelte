<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte'

  export let existingNames: string[]

  const dispatch = createEventDispatcher<{
    save: string
    cancel: void
  }>()

  let nameDraft = ''
  let nameInputRef: HTMLInputElement

  function normalizeName(value: string): string {
    return value.trim().toLowerCase()
  }

  $: normalizedName = normalizeName(nameDraft)
  $: duplicateName = Boolean(
    normalizedName && existingNames.some((name) => normalizeName(name) === normalizedName),
  )
  $: canSave = Boolean(normalizedName && !duplicateName)

  function handleSubmit() {
    if (!canSave) return
    dispatch('save', nameDraft.trim())
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dispatch('cancel')
    }
  }

  onMount(() => {
    nameInputRef?.focus()
    window.addEventListener('keydown', handleKeydown)
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
  })
</script>

<div class="save-response-backdrop">
  <form class="save-response-dialog" on:submit|preventDefault={handleSubmit}>
    <h2>Save response</h2>

    <label>
      <span>Name</span>
      <input
        bind:this={nameInputRef}
        bind:value={nameDraft}
        class="save-response-input"
        placeholder="Response name"
      />
    </label>

    {#if duplicateName}
      <p class="save-response-error">A response with this name already exists.</p>
    {/if}

    <div class="save-response-actions">
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
  .save-response-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.46);
    padding: 1rem;
  }

  .save-response-dialog {
    width: min(100%, 26rem);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--bg-alt);
    color: var(--text);
    box-shadow: 0 24px 90px rgba(0, 0, 0, 0.36);
    padding: 1rem;
  }

  .save-response-dialog h2 {
    margin: 0 0 1rem;
    font-size: 1rem;
    font-weight: 700;
  }

  .save-response-dialog label {
    display: grid;
    gap: 0.35rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }

  .save-response-input {
    height: 2rem;
    border: 1px solid var(--input-border);
    border-radius: 0.25rem;
    background: var(--input);
    color: var(--text);
    padding: 0 0.65rem;
    font-size: 0.875rem;
    outline: none;
  }

  .save-response-input:focus {
    border-color: #5a8fff;
  }

  .save-response-error {
    margin: 0.75rem 0 0;
    color: #f87171;
    font-size: 0.8125rem;
  }

  .save-response-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
