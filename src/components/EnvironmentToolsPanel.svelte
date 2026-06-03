<script lang="ts">
  import type {
    Environment,
    EnvironmentVariable,
    Workspace,
  } from '../tauri'

  export let selectedWorkspace: Workspace | null
  export let environments: Environment[]
  export let selectedEnvironmentId: string | null
  export let setSelectedEnvironmentId: (id: string | null) => void
  export let environmentName: string
  export let setEnvironmentName: (value: string) => void
  export let handleCreateEnvironment: (event: SubmitEvent) => Promise<void>
  export let environmentVariables: EnvironmentVariable[]
  export let variableKey: string
  export let setVariableKey: (value: string) => void
  export let variableValue: string
  export let setVariableValue: (value: string) => void
  export let handleSaveVariable: (event: SubmitEvent) => Promise<void>
  export let handleEditVariable: (variable: EnvironmentVariable) => void
  export let handleDeleteVariable: (variable: EnvironmentVariable) => Promise<void>

  $: selectedEnvironment =
    environments.find((environment) => environment.id === selectedEnvironmentId) ?? null

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-3">
  <form class="flex shrink-0 gap-2" on:submit={handleCreateEnvironment}>
    <input
      value={environmentName}
      on:input={(event) => setEnvironmentName(inputValue(event))}
      placeholder="New environment"
      class="h-8 min-w-0 flex-1 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-sm text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
      disabled={!selectedWorkspace}
    />
    <button class="secondary-button h-8 shrink-0" disabled={!environmentName.trim() || !selectedWorkspace}>
      Add
    </button>
  </form>

  <div class="shrink-0 space-y-2">
    <label class="block text-xs font-semibold uppercase text-[var(--muted)]" for="environment-tools-select">
      Active Environment
    </label>
    <select
      id="environment-tools-select"
      value={selectedEnvironmentId ?? ''}
      on:change={(event) => setSelectedEnvironmentId(selectValue(event) || null)}
      class="select-field h-8 w-full rounded px-2 text-sm outline-none"
      disabled={!selectedWorkspace || environments.length === 0}
    >
      {#each environments as environment (environment.id)}
        <option value={environment.id}>{environment.name}</option>
      {/each}
    </select>
  </div>

  <form class="shrink-0 space-y-2" on:submit={handleSaveVariable}>
    <div class="grid grid-cols-2 gap-2">
      <input
        value={variableKey}
        on:input={(event) => setVariableKey(inputValue(event))}
        placeholder="key"
        class="h-8 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-xs text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
        disabled={!selectedEnvironmentId}
      />
      <input
        value={variableValue}
        on:input={(event) => setVariableValue(inputValue(event))}
        placeholder="value"
        class="h-8 rounded border border-[var(--input-border)] bg-[var(--input)] px-2 text-xs text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
        disabled={!selectedEnvironmentId}
      />
    </div>
    <button class="secondary-button h-8 w-full" disabled={!selectedEnvironmentId || !variableKey.trim()}>
      Save Variable
    </button>
  </form>

  <div class="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-[var(--border)] pt-3">
    <div class="flex h-7 shrink-0 items-center justify-between gap-3">
      <span class="text-xs font-semibold uppercase text-[var(--muted)]">Variables</span>
      <span class="text-xs text-[var(--muted)]">{environmentVariables.length}</span>
    </div>

    {#if !selectedWorkspace}
      <div class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
        Select a workspace first.
      </div>
    {:else if !selectedEnvironment}
      <div class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
        Select an environment.
      </div>
    {:else if environmentVariables.length === 0}
      <div class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
        No variables in {selectedEnvironment.name}.
      </div>
    {:else}
      <div class="min-h-0 flex-1 space-y-1 overflow-auto pt-2">
        {#each environmentVariables as variable (variable.id)}
          <div class="group flex items-center gap-2 rounded bg-[var(--panel)] px-2 py-1.5 text-xs">
            <button
              class="min-w-0 flex-1 text-left"
              on:click={() => handleEditVariable(variable)}
              type="button"
              title="Edit variable"
            >
              <span class="block truncate font-mono text-[var(--text)]">{`{{${variable.key}}}`}</span>
              <span class="block truncate font-normal text-[var(--muted)]">{variable.value}</span>
            </button>
            <button
              type="button"
              class="shrink-0 rounded px-2 py-1 text-[var(--muted)] opacity-0 hover:bg-[var(--surface)] hover:text-[var(--text)] group-hover:opacity-100 focus:opacity-100"
              on:click={() => handleDeleteVariable(variable)}
            >
              Delete
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
