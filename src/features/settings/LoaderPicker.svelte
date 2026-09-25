<script lang="ts">
  /** Which animation runs while a request is in flight. The selected character runs in its card (a still picture with reduced motion). */
  import { settings } from '../../app/settings.svelte'
  import LoadingCharacter from '../../components/ui/LoadingCharacter.svelte'
  import { LOADER_CHARACTERS, LOADER_OPTIONS, prefersReducedMotion } from '../../lib/loader'

  const reduced = prefersReducedMotion()
</script>

<div role="radiogroup" aria-labelledby="loader-heading" class="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
  {#each LOADER_OPTIONS as o (o.id)}
    {@const selected = settings.loader === o.id}
    <label
      class="flex cursor-pointer flex-col gap-1.5 rounded-md border p-2 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus {selected
        ? 'border-accent bg-accent-soft'
        : 'border-border hover:bg-hover'}"
      data-loader-option={o.id}
    >
      <input type="radio" name="loader" value={o.id} class="sr-only" checked={selected} onchange={() => settings.setLoader(o.id)} />
      <span class="flex h-5 items-end gap-1" aria-hidden="true">
        {#if o.id === 'random'}
          {#each LOADER_CHARACTERS as c (c)}
            <span class="w-1/3"><LoadingCharacter kind={c} size="sm" still /></span>
          {/each}
        {:else if o.id === 'classic'}
          <span class="mb-0.5 inline-block h-4 w-4 rounded-full border-2 border-muted border-t-transparent {selected && !reduced ? 'animate-spin' : ''}"></span>
        {:else}
          <LoadingCharacter kind={o.id} size="sm" still={!selected || reduced} />
        {/if}
      </span>
      <span class="leading-tight">{o.label}</span>
    </label>
  {/each}
</div>
<p class="mt-1.5 text-xs text-faint">
  Shown while a request is in flight: the character runs back and forth until the response arrives. Random picks one per send; with reduced motion
  it stands still.
</p>
