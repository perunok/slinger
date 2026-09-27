<script lang="ts">
  /**
   * Theme picker: live thumbnails grouped Custom / Light / Dark, a filter, which themes "System" switches between, and
   * the user's custom themes (new, duplicate, edit, import/export, delete; lib/customThemes.ts).
   */
  import { settings } from '../../app/settings.svelte'
  import { toast } from '../../app/toast.svelte'
  import Button from '../../components/ui/Button.svelte'
  import ConfirmDialog from '../../components/ui/ConfirmDialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import IconButton from '../../components/ui/IconButton.svelte'
  import { auditCustomTheme, describeWarning } from '../../lib/customThemeAudit'
  import { MAX_CUSTOM_THEMES, THEME_FILE_EXT, newCustomThemeId, newThemeFrom, themeToFile, uniqueLabel, type CustomTheme, type CustomThemeData } from '../../lib/customThemes'
  import { saveExport } from '../../lib/exportFile'
  import { errorInfo } from '../../lib/ipc'
  import { THEMES, type Scheme, type ThemeInfo } from '../../lib/themes'
  import { sanitizeFileStem } from '../importexport/fileName'
  import CustomThemeEditor from './CustomThemeEditor.svelte'
  import ThemeImportDialog from './ThemeImportDialog.svelte'
  import ThemePreview from './ThemePreview.svelte'

  let query = $state('')
  let show = $state<'all' | Scheme>('all')
  let editing = $state<{ theme: CustomTheme; isNew: boolean; notices: string[] } | null>(null)
  let importing = $state(false)
  let deleting = $state<CustomTheme | null>(null)

  const accent = $derived(settings.accent === 'theme' ? null : settings.accent)
  const words = $derived(query.trim().toLowerCase().split(/\s+/).filter(Boolean))
  const matches = (label: string, scheme: Scheme | null, extra = '') => {
    if (scheme && show !== 'all' && scheme !== show) return false
    const hay = `${label} ${scheme ?? 'light dark'} ${extra}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  }
  const groups = $derived(
    (['light', 'dark'] as const).map((scheme) => ({
      scheme,
      title: scheme === 'light' ? 'Light' : 'Dark',
      items: THEMES.filter((t) => t.scheme === scheme && matches(t.label, t.scheme)),
    })),
  )
  const customs = $derived(settings.customThemes.filter((c) => matches(c.label, c.scheme, 'custom')))
  const showSystem = $derived(show === 'all' && matches('System follows OS', null))
  const empty = $derived(!showSystem && customs.length === 0 && groups.every((g) => g.items.length === 0))
  const lights = THEMES.filter((t) => t.scheme === 'light')
  const darks = THEMES.filter((t) => t.scheme === 'dark')
  const customLights = $derived(settings.customThemes.filter((c) => c.scheme === 'light'))
  const customDarks = $derived(settings.customThemes.filter((c) => c.scheme === 'dark'))
  const full = $derived(settings.customThemes.length >= MAX_CUSTOM_THEMES)
  const fullHint = `At most ${MAX_CUSTOM_THEMES} custom themes`
  const warnings = $derived(new Map(settings.customThemes.map((c) => [c.id, auditCustomTheme(c, accent).failures])))

  const card = (selected: boolean) =>
    `relative flex cursor-pointer flex-col gap-1.5 rounded-md border p-1.5 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus ${
      selected ? 'border-accent bg-accent-soft' : 'border-border hover:bg-hover'
    }`

  function startFrom(sourceId: string) {
    if (full) return
    editing = { theme: newThemeFrom(sourceId, settings.customThemes), isNew: true, notices: [] }
  }

  function onImported(theme: CustomThemeData, notices: string[]) {
    importing = false
    if (full) return void toast.error('Too many custom themes', `${fullHint}; delete one first.`)
    editing = { theme: { ...theme, id: newCustomThemeId(), label: uniqueLabel(theme.label, settings.customThemes) }, isNew: true, notices }
  }

  async function exportTheme(c: CustomTheme) {
    try {
      const path = await saveExport(`${sanitizeFileStem(c.label, 'theme')}${THEME_FILE_EXT}`, themeToFile(c))
      toast.success(`Exported “${c.label}”`, path)
    } catch (e) {
      toast.error('Could not export the theme', errorInfo(e).message)
    }
  }
</script>

{#snippet option(t: ThemeInfo)}
  <div class="group relative" data-theme-option={t.id}>
    <label class={card(settings.theme === t.id)}>
      <input type="radio" name="theme" value={t.id} class="sr-only" checked={settings.theme === t.id} onchange={() => settings.setTheme(t.id)} />
      <ThemePreview theme={t.id} {accent} />
      <span class="flex items-center gap-1 px-0.5">
        <span class="min-w-0 flex-1 truncate">{t.label}</span>
        {#if settings.theme === t.id}<Icon name="check" size={13} class="shrink-0 text-accent-text" />{/if}
      </span>
    </label>
    <IconButton
      icon="copy"
      size={13}
      label="Duplicate {t.label} as a custom theme"
      class="absolute right-1 top-1 !h-6 !w-6 bg-surface opacity-0 shadow-pop focus-visible:opacity-100 group-hover:opacity-100"
      disabled={full}
      onclick={() => startFrom(t.id)}
    />
  </div>
{/snippet}

{#snippet customOption(c: CustomTheme)}
  {@const failures = warnings.get(c.id) ?? []}
  <div class="flex flex-col gap-1" data-theme-option={c.id}>
    <label class={card(settings.theme === c.id)}>
      <input type="radio" name="theme" value={c.id} class="sr-only" checked={settings.theme === c.id} onchange={() => settings.setTheme(c.id)} />
      <ThemePreview theme={c.id} {accent} />
      <span class="flex items-center gap-1 px-0.5">
        <span class="min-w-0 flex-1 truncate">{c.label}</span>
        {#if failures.length}
          <span
            class="flex shrink-0 items-center gap-0.5 text-xs text-warning"
            title={`Contrast warnings:\n${failures.map(describeWarning).join('\n')}`}
            data-testid="theme-warnings"
            ><Icon name="alert" size={12} />{failures.length}<span class="sr-only">{` contrast warning${failures.length === 1 ? '' : 's'}`}</span></span
          >
        {/if}
        {#if settings.theme === c.id}<Icon name="check" size={13} class="shrink-0 text-accent-text" />{/if}
      </span>
      <span class="px-0.5 text-[11px] text-faint">Custom · {c.scheme}</span>
    </label>
    <div class="flex justify-end gap-0.5">
      <IconButton icon="edit" size={13} label="Edit {c.label}" class="!h-6 !w-6" onclick={() => (editing = { theme: c, isNew: false, notices: [] })} />
      <IconButton icon="copy" size={13} label="Duplicate {c.label}" class="!h-6 !w-6" disabled={full} onclick={() => startFrom(c.id)} />
      <IconButton icon="download" size={13} label="Export {c.label}" class="!h-6 !w-6" onclick={() => exportTheme(c)} />
      <IconButton icon="trash" size={13} label="Delete {c.label}" class="!h-6 !w-6" onclick={() => (deleting = c)} />
    </div>
  </div>
{/snippet}

{#snippet systemOptions(builtins: ThemeInfo[], custom: CustomTheme[])}
  {#each builtins as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
  {#if custom.length}
    <optgroup label="Custom">
      {#each custom as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
    </optgroup>
  {/if}
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
  <span class="text-xs text-faint">{THEMES.length} themes{settings.customThemes.length ? ` + ${settings.customThemes.length} custom` : ''}</span>
  <span class="ml-auto flex gap-1">
    <Button size="sm" icon="plus" disabled={full} title={full ? fullHint : 'Start from the current theme'} onclick={() => startFrom(settings.resolvedTheme)}>New custom theme</Button>
    <Button size="sm" icon="upload" disabled={full} title={full ? fullHint : 'Import a theme file or CSS'} onclick={() => (importing = true)}>Import theme</Button>
  </span>
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
            {@render systemOptions(lights, customLights)}
          </select>
        </label>
        <label class="flex items-center gap-2">
          <Icon name="moon" size={14} class="shrink-0 text-muted" />
          <span class="w-36 shrink-0 whitespace-nowrap text-muted">When the OS is dark</span>
          <select class="min-w-0 flex-1 sm:max-w-56" value={settings.systemDark} onchange={(e) => settings.setSystemTheme('dark', e.currentTarget.value)}>
            {@render systemOptions(darks, customDarks)}
          </select>
        </label>
      </div>
    </div>
  {/if}

  {#if customs.length}
    <section aria-label="Custom themes">
      <h4 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Custom</h4>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {#each customs as c (c.id)}{@render customOption(c)}{/each}
      </div>
    </section>
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

<!-- keyed by theme id: a different theme always gets a fresh editor -->
{#each editing ? [editing] : [] as e (e.theme.id)}
  <CustomThemeEditor
    initial={e.theme}
    isNew={e.isNew}
    notices={e.notices}
    onclose={() => (editing = null)}
    onsaved={(t) => {
      if (e.isNew) settings.setTheme(t.id)
    }}
  />
{/each}

{#if importing}
  <ThemeImportDialog onclose={() => (importing = false)} onimport={onImported} />
{/if}

{#if deleting}
  {@const d = deleting}
  <ConfirmDialog
    title="Delete custom theme"
    message={`Delete “${d.label}”? This cannot be undone (export it first to keep a copy).${settings.theme === d.id ? ' Slinger switches to its base theme.' : ''}`}
    confirmLabel="Delete"
    danger
    onconfirm={() => settings.deleteCustomTheme(d.id)}
    oncancel={() => (deleting = null)}
  />
{/if}
