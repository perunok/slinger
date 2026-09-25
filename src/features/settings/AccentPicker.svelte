<script lang="ts">
  /** Accent colour, independent of the theme. Each swatch is rendered with the active theme so it shows the real colour. */
  import { settings } from '../../app/settings.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { ACCENTS, THEME_DEFAULT_ACCENT } from '../../lib/themes'

  const choices = [{ id: THEME_DEFAULT_ACCENT, label: 'Theme default' }, ...ACCENTS]
</script>

<div role="radiogroup" aria-labelledby="accent-heading" class="grid grid-cols-5 gap-1 sm:grid-cols-10">
  {#each choices as a (a.id)}
    {@const selected = settings.accent === a.id}
    <label
      class="flex cursor-pointer flex-col items-center gap-1 rounded-md border px-0.5 py-1.5 text-center text-[11px] leading-tight transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus {selected
        ? 'border-accent bg-accent-soft text-fg'
        : 'border-transparent text-muted hover:bg-hover hover:text-fg'}"
    >
      <input type="radio" name="accent" value={a.id} class="sr-only" checked={selected} onchange={() => settings.setAccent(a.id)} />
      <span
        data-theme={settings.resolvedTheme}
        data-accent={a.id === THEME_DEFAULT_ACCENT ? undefined : a.id}
        class="flex h-6 w-6 items-center justify-center rounded-full border"
        style="background: var(--accent); border-color: var(--border-strong); color: var(--accent-fg)"
        aria-hidden="true"
      >
        {#if selected}<Icon name="check" size={13} />{/if}
      </span>
      {a.label}
    </label>
  {/each}
</div>
