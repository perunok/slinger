<script lang="ts">
  import { builtinVariableToken, type BuiltinVariable } from '../lib/builtinVariables'

  export let suggestions: BuiltinVariable[]
  export let selectedIndex = 0
  export let selectVariable: (name: string) => void
  export let style = ''
</script>

<div
  class="z-30 w-72 overflow-hidden rounded border border-[var(--border)] bg-[var(--surface)] text-sm shadow-xl"
  {style}
>
  <div class="border-b border-[var(--border)] px-3 py-2 text-xs font-semibold uppercase text-[var(--muted)]">
    Built-in Variables
  </div>
  <div class="max-h-64 overflow-auto py-1">
    {#each suggestions as variable, index (variable.name)}
      <button
        type="button"
        class={`grid w-full gap-0.5 px-3 py-2 text-left ${
          index === selectedIndex ? 'bg-[var(--panel)] text-[var(--text)]' : 'text-[var(--text)] hover:bg-[var(--panel)]'
        }`}
        on:mousedown|preventDefault={() => selectVariable(variable.name)}
      >
        <span class="font-mono text-xs" style="color: var(--variable-builtin);">{builtinVariableToken(variable.name)}</span>
        <span class="text-xs text-[var(--muted)]">{variable.description}</span>
      </button>
    {/each}
  </div>
</div>
