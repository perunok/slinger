<script lang="ts">
  /** Theme picker: live thumbnails grouped Light / Dark, a filter, and which themes "System" switches between. */
  import { settings } from '../../app/settings.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { THEMES, type Scheme, type ThemeInfo } from '../../lib/themes'
  import ThemePreview from './ThemePreview.svelte'

  let query = $state('')
  let show = $state<'all' | Scheme>('all')

  const accent = $derived(settings.accent === 'theme' ? null : settings.accent)
  const words = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean))
  const matches = (label: string, scheme: Scheme | null) => {
    if (scheme && show !== 'all' && scheme !== show) return false
    const hay = `${label} ${scheme ?? 'light dark'}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  }
  const groups = $derived(
    (['light', 'dark'] as const).map((scheme) => ({
      scheme,
      title: scheme === 'light' ? 'Light' : 'Dark',
      items: THEMES.filter((t) => t.scheme === scheme && matches(t.label, t.scheme)),
    })),
  )
  const showSystem = $derived(show === 'all' && matches('System follows OS', null))
  const empty = $derived(!showSystem && groups.every((g) => g.items.length === 0))
  const lights = THEMES.filter((t) => t.scheme === 'light')
  const darks = THEMES.filter((t) => t.scheme === 'dark')

  const card = (selected: boolean) =>
    `relative flex cursor-pointer flex-col gap-1.5 rounded-md border p-1.5 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus ${
      selected ? 'border-accent bg-accent-soft' : 'border-border hover:bg-hover'
    }`
</script>

{#snippet option(t: ThemeInfo)}
  <label class={card(settings.theme === t.id)} data-theme-option={t.id}>
    <input type="radio" name="theme" value={t.id} class="sr-only" checked={settings.theme === t.id} onchange={() => settings.setTheme(t.id)} />
    <ThemePreview theme={t.id} {accent} />
    <span class="flex items-center gap-1 px-0.5">
      <span class="min-w-0 flex-1 truncate">{t.label}</span>
      {#if settings.theme === t.id}<Icon name="check" size={13} class="shrink-0 text-accent-text" />{/if}
    </span>
  </label>
{/snippet}

<div class="mb-3 flex flex-wrap items-center gap-2">
  <input type="search" class="w-56" placeholder="Filter themes…" aria-label="Filter themes" bind:value={query} />
  <div role="group" aria-label="Show themes" class="flex overflow-hidden rounded border border-border text-xs">
    {#each [['all', 'All'], ['light', 'Light'], ['dark', 'Dark']] as const as [id, label] (id)}
      <button
        type="button"
        aria-pressed={show === id}
        class="px-2.5 py-1 {show === id ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg'}"
        onclick={() => (show = id)}>{label}</button
      >
    {/each}
  </div>
  <span class="text-xs text-faint">{THEMES.length} themes</span>
</div>

<div role="radiogroup" aria-labelledby="theme-heading" class="grid gap-3">
  {#if showSystem}
    <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <label class={card(settings.theme === 'system')}>
        <input type="radio" name="theme" value="system" class="sr-only" checked={settings.theme === 'system'} onchange={() => settings.setTheme('system')} />
        <span class="grid grid-cols-2 gap-1" aria-hidden="true">
          <ThemePreview theme={settings.systemLight} {accent} />
          <ThemePreview theme={settings.systemDark} {accent} />
        </span>
        <span class="flex items-center gap-1 px-0.5">
          <span class="min-w-0 flex-1 truncate">System <span class="text-xs text-faint">follows your OS</span></span>
          {#if settings.theme === 'system'}<Icon name="check" size={13} class="shrink-0 text-accent-text" />{/if}
        </span>
      </label>
      <div class="col-span-1 grid content-center gap-2 text-xs sm:col-span-3">
        <label class="flex items-center gap-2">
          <Icon name="sun" size={14} class="shrink-0 text-muted" />
          <span class="w-36 shrink-0 whitespace-nowrap text-muted">When the OS is light</span>
          <select class="min-w-0 flex-1 sm:max-w-56" value={settings.systemLight} onchange={(e) => settings.setSystemTheme('light', e.currentTarget.value)}>
            {#each lights as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
          </select>
        </label>
        <label class="flex items-center gap-2">
          <Icon name="moon" size={14} class="shrink-0 text-muted" />
          <span class="w-36 shrink-0 whitespace-nowrap text-muted">When the OS is dark</span>
          <select class="min-w-0 flex-1 sm:max-w-56" value={settings.systemDark} onchange={(e) => settings.setSystemTheme('dark', e.currentTarget.value)}>
            {#each darks as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
          </select>
        </label>
      </div>
    </div>
  {/if}

  {#each groups as g (g.scheme)}
    {#if g.items.length}
      <section aria-label="{g.title} themes">
        <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{g.title}</h4>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {#each g.items as t (t.id)}{@render option(t)}{/each}
        </div>
      </section>
    {/if}
  {/each}

  {#if empty}
    <p class="py-4 text-center text-sm text-muted">No themes match “{query}”.</p>
  {/if}
</div>
