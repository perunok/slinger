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
  export let className = ''

  $: parts = resolveTemplateParts(value, environmentVariables)
  $: hasTemplate = parts.some((part) => part.key)
  $: inputType = sensitive && !hasTemplate ? 'password' : 'text'

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
</script>

<div class="relative">
  {#if hasTemplate}
    <div
      class={`${className} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre`}
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
    class={`${className} ${hasTemplate ? 'relative' : ''}`}
    style={hasTemplate ? 'background: transparent; border-color: transparent; color: transparent; caret-color: var(--text);' : ''}
    on:input={(event) => setValue(inputValue(event))}
  />
</div>
