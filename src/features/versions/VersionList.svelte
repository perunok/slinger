<script lang="ts">
  import type { CollectionVersion } from '../../../shared/types'
  import { latestRelease } from '../../lib/semver'
  import { formatCreated, isPrerelease, truncate } from './helpers'

  interface Props {
    versions: CollectionVersion[]
    selectedId: string | null
    onselect: (id: string) => void
  }
  let { versions, selectedId, onselect }: Props = $props()

  const latest = $derived(latestRelease(versions.map((v) => v.version)))

  function onkeydown(e: KeyboardEvent) {
    const i = versions.findIndex((v) => v.id === selectedId)
    let next = -1
    if (e.key === 'ArrowDown') next = Math.min(versions.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = versions.length - 1
    if (next < 0) return
    e.preventDefault()
    onselect(versions[next].id)
    queueMicrotask(() => document.getElementById(`ver-opt-${versions[next].id}`)?.focus())
  }
</script>

<ul role="listbox" aria-label="Versions" class="flex flex-col gap-1 p-1" {onkeydown}>
  {#each versions as v, idx (v.id)}
    {@const selected = v.id === selectedId}
    <li
      id="ver-opt-{v.id}"
      role="option"
      aria-selected={selected}
      tabindex={selected || (selectedId === null && idx === 0) ? 0 : -1}
      class="cursor-pointer rounded border px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent {selected ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-hover'}"
      onclick={() => onselect(v.id)}
      onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onselect(v.id))}
    >
      <div class="flex items-center gap-1.5">
        <span
          class="rounded px-1.5 py-0.5 font-mono text-xs {isPrerelease(v.version) ? 'border border-dashed border-warning text-warning' : 'bg-raised text-fg'}"
        >{v.version}</span>
        {#if isPrerelease(v.version)}<span class="text-[10px] uppercase text-warning">pre-release</span>{/if}
        {#if v.version === latest}<span class="rounded-full bg-success-soft px-1.5 text-[10px] leading-4 text-success">latest</span>{/if}
      </div>
      <div class="mt-0.5 text-xs text-muted">{formatCreated(v.createdAt)}</div>
      {#if v.notes}<div class="mt-0.5 text-xs text-fg">{truncate(v.notes, 70)}</div>{/if}
      <div class="mt-0.5 text-[11px] text-faint">{v.requestCount} request{v.requestCount === 1 ? '' : 's'}, {v.folderCount} folder{v.folderCount === 1 ? '' : 's'}</div>
    </li>
  {/each}
</ul>
