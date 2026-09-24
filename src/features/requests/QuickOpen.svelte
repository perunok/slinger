<script lang="ts">
  /** Ctrl+K: jump to any saved request by name, URL or method. */
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import { methodColor } from './method'
  import { tabsStore } from './tabs.svelte'

  let query = $state('')
  let index = $state(0)

  const results = $derived.by(() => {
    const q = query.trim().toLowerCase()
    const all = app.requests.map((r) => ({ r, col: app.collections.find((c) => c.id === r.collectionId)?.name ?? '' }))
    if (!q) return all.slice(0, 50)
    const score = (x: (typeof all)[number]) => {
      const name = x.r.name.toLowerCase()
      if (name.startsWith(q)) return 0
      if (name.includes(q)) return 1
      if (x.r.url.toLowerCase().includes(q)) return 2
      if (x.r.method.toLowerCase() === q) return 2
      return 9
    }
    return all
      .map((x) => ({ x, s: score(x) }))
      .filter((y) => y.s < 9)
      .sort((a, b) => a.s - b.s || a.x.r.name.localeCompare(b.x.r.name))
      .map((y) => y.x)
      .slice(0, 50)
  })
  $effect(() => {
    void query
    index = 0
  })

  function open(i: number) {
    const hit = results[i]
    if (!hit) return
    tabsStore.openRequest(hit.r)
    ui.quickOpen = false
  }
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      index = Math.min(results.length - 1, index + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      index = Math.max(0, index - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      open(index)
    }
    queueMicrotask(() => document.getElementById(`qo-${index}`)?.scrollIntoView({ block: 'nearest' }))
  }
</script>

<Dialog title="Go to request" onclose={() => (ui.quickOpen = false)} size="md">
  <input
    type="text"
    class="w-full"
    placeholder="Search requests by name, URL or method…"
    role="combobox"
    aria-label="Search requests"
    aria-expanded="true"
    aria-controls="qo-list"
    aria-activedescendant={results[index] ? `qo-${index}` : undefined}
    bind:value={query}
    data-autofocus
    {onkeydown}
  />
  <ul id="qo-list" role="listbox" aria-label="Results" class="mt-2 max-h-80 overflow-auto">
    {#each results as hit, i (hit.r.id)}
      <li
        id="qo-{i}"
        role="option"
        aria-selected={i === index}
        class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm {i === index ? 'bg-accent-soft' : 'hover:bg-hover'}"
        onclick={() => open(i)}
        onkeydown={() => {}}
        onmousemove={() => (index = i)}
      >
        <span class="w-12 shrink-0 text-[10px] font-bold" style="color:{methodColor(hit.r.method)}">{hit.r.method}</span>
        <span class="min-w-0 flex-1 truncate">{hit.r.name}</span>
        <span class="max-w-48 truncate text-xs text-faint">{hit.col}</span>
      </li>
    {:else}
      <li class="px-2 py-4 text-center text-sm text-muted">No matching requests.</li>
    {/each}
  </ul>
</Dialog>
