<script lang="ts">
  import {
    resolveTemplateParts,
    type TemplatePart,
  } from '../lib/requestDocument'
  import type { EnvironmentVariable } from '../tauri'

  export let value = ''
  export let setValue: (value: string) => void
  export let id: string | undefined = undefined
  export let environmentVariables: EnvironmentVariable[] = []
  export let sensitive = false
  export let showVisibilityToggle = false
  export let visibleByDefault = false
  export let className = ''

  $: parts = resolveTemplateParts(value, environmentVariables)
  $: hasTemplate = parts.some((part) => part.key)
  let isVisible = visibleByDefault
  $: inputType = sensitive && !isVisible ? 'password' : 'text'
  $: showOverlay = hasTemplate && inputType === 'text'
  $: inputClassName = `${className} ${showOverlay ? 'relative' : ''} ${showVisibilityToggle ? 'pr-10' : ''}`.trim()

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

  function variablePartStyle(part: TemplatePart): string {
    const color =
      part.source === 'builtin'
        ? 'var(--variable-builtin)'
        : part.resolved
          ? 'var(--variable-env)'
          : 'var(--variable-unresolved)'

    return `color: ${color};`
  }

  function toggleVisibility() {
    isVisible = !isVisible
  }
</script>

<div class="relative">
  {#if showOverlay}
    <div
      class={`${className} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre pr-10`}
      aria-hidden="true"
    >
      {#each parts as part}
        {#if part.key}
          <span style={variablePartStyle(part)}>{part.text}</span>
        {:else}
          <span>{part.text}</span>
        {/if}
      {/each}
    </div>
  {/if}
  <input
    {id}
    type={inputType}
    value={value}
    class={inputClassName}
    style={showOverlay ? 'background: transparent; border-color: transparent; color: transparent; caret-color: var(--text);' : ''}
    on:input={(event) => setValue(inputValue(event))}
  />
  {#if showVisibilityToggle}
    <button
      type="button"
      class="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-[var(--muted)] transition-colors hover:text-[var(--text)] focus-visible:text-[var(--text)] focus-visible:outline-none"
      aria-label={isVisible ? 'Hide value' : 'Show value'}
      title={isVisible ? 'Hide value' : 'Show value'}
      on:click={toggleVisibility}
    >
      {#if isVisible}
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 3l18 18" />
          <path d="M10.58 10.58A3 3 0 0 0 9 12a3 3 0 0 0 4.24 2.74" />
          <path d="M9.88 5.09A10.94 10.94 0 0 1 12 5c5 0 9.27 3.11 11 7-0.55 1.24-1.4 2.4-2.48 3.38" />
          <path d="M6.61 6.61C4.62 7.9 3.16 9.81 2 12c1.73 3.89 6 7 10 7 1.55 0 3.03-0.3 4.39-0.85" />
        </svg>
      {:else}
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      {/if}
    </button>
  {/if}
</div>
