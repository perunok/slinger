<script lang="ts">
  /**
   * Ctrl+K: jump to any saved request by name, URL or method. Also a small command palette: commands (switch theme /
   * accent) show up when the query matches them, and a leading ">" lists only commands.
   */
  import { settings } from '../../app/settings.svelte'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { ACCENTS, THEMES, THEME_DEFAULT_ACCENT } from '../../lib/themes'
  import type { ApiRequest } from '../../../shared/types'
  import { methodColor } from './method'
  import { tabsStore } from './tabs.svelte'

  interface Command {
    key: string
    label: string
    hint: string
    /** Swatch: a theme (its background ringed by its accent) or an accent over the current theme. */
    swatch: { theme?: string; accent?: string }
    current: () => boolean
    run: () => void
  }
  type Hit = { kind: 'request'; key: string; r: ApiRequest; col: string } | ({ kind: 'command' } & Command)

  const commands: Command[] = [
    {
      key: 'theme:system',
      label: 'Theme: System',
      hint: 'follows the OS',
      swatch: {},
      current: () => settings.theme === 'system',
      run: () => settings.setTheme('system'),
    },
    ...THEMES.map((t) => ({
      key: `theme:${t.id}`,
      label: `Theme: ${t.label}`,
      hint: `${t.scheme} theme`,
      swatch: { theme: t.id },
      current: () => settings.theme === t.id,
      run: () => settings.setTheme(t.id),
    })),
    ...[{ id: THEME_DEFAULT_ACCENT, label: 'Theme default' }, ...ACCENTS].map((a) => ({
      key: `accent:${a.id}`,
      label: `Accent: ${a.label}`,
      hint: 'accent colour',
      swatch: { accent: a.id },
      current: () => settings.accent === a.id,
      run: () => settings.setAccent(a.id),
    })),
  ]

  let query = $state('')
  let index = $state(0)

  const results = $derived.by((): Hit[] => {
    const raw = query.trim().toLowerCase()
    const commandMode = raw.startsWith('>')
    const q = commandMode ? raw.slice(1).trim() : raw
    const words = q.split(/\s+/).filter(Boolean)
    const cmds: Hit[] =
      commandMode || q.length >= 2
        ? commands
            .filter((c) => words.every((w) => `${c.label} ${c.hint}`.toLowerCase().includes(w)))
            .map((c) => ({ kind: 'command' as const, ...c }))
        : []
    if (commandMode) return cmds
    const all = app.requests.map((r) => ({ r, col: app.collections.find((c) => c.id === r.collectionId)?.name ?? '' }))
    const toHit = (x: (typeof all)[number]): Hit => ({ kind: 'request', key: x.r.id, ...x })
    if (!q) return all.slice(0, 50).map(toHit)
    const score = (x: (typeof all)[number]) => {
      const name = x.r.name.toLowerCase()
      if (name.startsWith(q)) return 0
      if (name.includes(q)) return 1
      if (x.r.url.toLowerCase().includes(q)) return 2
      if (x.r.method.toLowerCase() === q) return 2
      return 9
    }
    const reqs = all
      .map((x) => ({ x, s: score(x) }))
      .filter((y) => y.s < 9)
      .sort((a, b) => a.s - b.s || a.x.r.name.localeCompare(b.x.r.name))
      .map((y) => toHit(y.x))
      .slice(0, 50)
    return [...reqs, ...cmds]
  })
  $effect(() => {
    void query
    index = 0
  })

  function open(i: number) {
    const hit = results[i]
    if (!hit) return
    if (hit.kind === 'request') tabsStore.openRequest(hit.r)
    else hit.run()
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
    placeholder="Search requests by name, URL or method… (> for commands, e.g. > theme nord)"
    role="combobox"
    aria-label="Search requests and commands"
    aria-expanded="true"
    aria-controls="qo-list"
    aria-activedescendant={results[index] ? `qo-${index}` : undefined}
    bind:value={query}
    data-autofocus
    {onkeydown}
  />
  <ul id="qo-list" role="listbox" aria-label="Results" class="mt-2 max-h-80 overflow-auto">
    {#each results as hit, i (hit.key)}
      <li
        id="qo-{i}"
        role="option"
        aria-selected={i === index}
        class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm {i === index ? 'bg-accent-soft' : 'hover:bg-hover'}"
        onclick={() => open(i)}
        onkeydown={() => {}}
        onmousemove={() => (index = i)}
      >
        {#if hit.kind === 'request'}
          <span class="w-12 shrink-0 text-[10px] font-bold" style="color:{methodColor(hit.r.method)}">{hit.r.method}</span>
          <span class="min-w-0 flex-1 truncate">{hit.r.name}</span>
          <span class="max-w-48 truncate text-xs text-faint">{hit.col}</span>
        {:else}
          <span class="flex w-12 shrink-0 items-center" aria-hidden="true">
            {#if hit.swatch.theme}
              <span data-theme={hit.swatch.theme} class="h-3.5 w-3.5 rounded-sm border-2" style="background: var(--bg); border-color: var(--accent)"></span>
            {:else if hit.swatch.accent}
              <span
                data-theme={settings.resolvedTheme}
                data-accent={hit.swatch.accent === THEME_DEFAULT_ACCENT ? undefined : hit.swatch.accent}
                class="h-3.5 w-3.5 rounded-full border"
                style="background: var(--accent); border-color: var(--border-strong)"
              ></span>
            {:else}
              <Icon name="settings" size={14} class="text-muted" />
            {/if}
          </span>
          <span class="min-w-0 flex-1 truncate">{hit.label}</span>
          {#if hit.current()}<span class="text-xs text-accent-text">current</span>{/if}
          <span class="text-xs text-faint">{hit.hint}</span>
        {/if}
      </li>
    {:else}
      <li class="px-2 py-4 text-center text-sm text-muted">No matching requests or commands.</li>
    {/each}
  </ul>
</Dialog>
