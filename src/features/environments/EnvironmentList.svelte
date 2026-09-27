<script lang="ts">
  import Button from '../../components/ui/Button.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import type { Environment } from '../../../shared/types'

  interface Props {
    environments: Environment[]
    selectedId: string | null
    activeId: string | null
    disabled?: boolean
    /** Read-only workspace: creating, renaming, duplicating and deleting are disabled. */
    readOnly?: boolean
    onselect: (id: string) => void
    onsetactive: (id: string) => void
    oncreate: () => void
    onrename: (env: Environment) => void
    onduplicate: (env: Environment) => void
    ondelete: (env: Environment) => void
    /** Export as a Postman environment file (allowed in read-only workspaces). */
    onexport?: (env: Environment) => void
    /** ADDED (persisted variables): the workspace's Globals entry at the top of the list. */
    globalsSelected?: boolean
    onselectglobals?: () => void
  }
  let {
    environments, selectedId, activeId, disabled = false, readOnly = false, onselect, onsetactive, oncreate, onrename, onduplicate, ondelete, onexport,
    globalsSelected = false, onselectglobals,
  }: Props = $props()
  const selected = $derived(globalsSelected ? undefined : environments.find((e) => e.id === selectedId))
</script>

<div class="flex h-full min-h-0 w-56 shrink-0 flex-col gap-2">
  <div class="flex items-center justify-between">
    <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Environments</h3>
    <IconButton icon="plus" label="New environment" disabled={readOnly} onclick={oncreate} />
  </div>
  {#if onselectglobals}
    <button
      type="button"
      data-testid="globals-entry"
      aria-current={globalsSelected ? 'true' : undefined}
      {disabled}
      title="Workspace-wide variables, used by every request (lowest precedence)"
      class="flex w-full items-center gap-2 rounded border border-dashed border-border px-2 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-60 {globalsSelected ? 'bg-accent-soft' : ''}"
      onclick={onselectglobals}
    >
      <Icon name="globe" size={14} class="shrink-0 text-muted" />
      <span class="truncate font-medium">Globals</span>
    </button>
  {/if}
  <ul aria-label="Environments" class="min-h-0 flex-1 overflow-auto rounded border border-border">
    {#each environments as env (env.id)}
      <li>
        <button
          type="button"
          aria-current={env.id === selectedId && !globalsSelected ? 'true' : undefined}
          {disabled}
          class="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-60 {env.id === selectedId && !globalsSelected ? 'bg-accent-soft' : ''}"
          onclick={() => onselect(env.id)}
        >
          <span class="truncate">{env.name}</span>
          {#if env.id === activeId}
            <span class="shrink-0 rounded-full bg-success-soft px-1.5 text-[10px] text-success">Active</span>
          {/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if selected}
    <div class="flex flex-wrap gap-1">
      <Button size="sm" disabled={selected.id === activeId} onclick={() => onsetactive(selected.id)}>Set active</Button>
      <IconButton icon="edit" label="Rename environment" disabled={readOnly} onclick={() => onrename(selected)} />
      <IconButton icon="copy" label="Duplicate environment" disabled={readOnly} onclick={() => onduplicate(selected)} />
      {#if onexport}<IconButton icon="download" label="Export environment…" onclick={() => onexport(selected)} />{/if}
      <IconButton icon="trash" label="Delete environment" disabled={readOnly} onclick={() => ondelete(selected)} />
    </div>
    <p class="text-[11px] text-faint">Duplicating copies plain variables only; secrets are not copied.</p>
  {/if}
</div>
