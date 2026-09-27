<script lang="ts">
  /**
   * Custom theme editor: a CSS config view (CodeMirror, strict parser with line-numbered errors) and a form view
   * (colour pickers + values per token group) editing the same token map. The draft is previewed live in the whole app
   * (settings.setDraftTheme) and reverted on cancel; contrast warnings use the same checks as the built-in themes.
   */
  import { onDestroy, untrack } from 'svelte'
  import { settings } from '../../app/settings.svelte'
  import Button from '../../components/ui/Button.svelte'
  import CodeEditor from '../../components/editor/CodeEditor.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { toHex } from '../../lib/contrast'
  import { auditCustomTheme, describeWarning, effectiveVars, tokenHex } from '../../lib/customThemeAudit'
  import {
    MAX_THEME_LABEL_LENGTH,
    TOKEN_GROUPS,
    checkTokenValue,
    orderTokens,
    parseThemeCss,
    themeToCss,
    tokenLabel,
    type CssIssue,
    type CustomTheme,
    type ThemeToken,
    type ThemeTokens,
  } from '../../lib/customThemes'
  import { THEMES, THEME_DEFAULT_ACCENT, THEME_TOKENS, findTheme, type Scheme } from '../../lib/themes'
  import ThemePreview from './ThemePreview.svelte'

  interface Props {
    initial: CustomTheme
    isNew: boolean
    /** Shown above the editor (e.g. tokens skipped while importing). */
    notices?: string[]
    onclose: () => void
    /** Called after a successful save. */
    onsaved?: (t: CustomTheme) => void
  }
  let { initial, isNew, notices = [], onclose, onsaved }: Props = $props()

  const id = untrack(() => initial.id)
  let label = $state(untrack(() => initial.label))
  let base = $state(untrack(() => initial.base))
  let scheme = $state<Scheme>(untrack(() => initial.scheme))
  let tokens = $state<ThemeTokens>(untrack(() => ({ ...initial.tokens })))
  let view = $state<'css' | 'form'>('css')
  let cssText = $state(untrack(() => themeToCss(initial)))
  let cssErrors = $state<CssIssue[]>([])
  /** The form changed the tokens since the CSS text was last in step with them. */
  let formEdited = $state(false)
  /** Raw text per token in the form view while it is not a valid value. */
  let formRaw = $state<Partial<Record<ThemeToken, string>>>({})
  let formErrors = $state<Partial<Record<ThemeToken, string>>>({})
  let inApp = $state(true)
  let error = $state<string | null>(null)

  const draft = $derived<CustomTheme>({ id, label: label.trim() || 'Custom theme', scheme, base, tokens })
  const accent = $derived(settings.accent === THEME_DEFAULT_ACCENT ? null : settings.accent)
  const audit = $derived(auditCustomTheme(draft, accent))
  const overridden = $derived(Object.keys(tokens).length)
  const attrs = $derived(settings.themeAttrs(id))
  const blocking = $derived(cssErrors.length > 0 && !(view === 'form' && formEdited))
  const canSave = $derived(!!label.trim() && !blocking && Object.keys(formErrors).length === 0)

  /** Set once the editor saved or was dismissed: from then on it never touches the preview again. */
  let done = false
  $effect(() => {
    const d = draft
    const show = inApp
    if (!done) untrack(() => settings.setDraftTheme(d, show))
  })
  // Destroyed without Save/Cancel (e.g. the Settings dialog went away): end the preview. Deferred because state read
  // during a Svelte teardown returns the values from before the change (settings would re-apply the stale draft).
  onDestroy(() => {
    if (done) return
    done = true
    queueMicrotask(() => settings.clearDraftTheme(id))
  })

  function close() {
    done = true
    settings.clearDraftTheme(id)
    onclose()
  }

  function onCss(text: string) {
    cssText = text
    const r = parseThemeCss(text)
    cssErrors = r.errors
    // Valid declarations apply (and preview) right away; saving waits until every error is fixed.
    tokens = r.tokens
    if (r.scheme) scheme = r.scheme
  }

  function showView(v: 'css' | 'form') {
    if (v === view) return
    if (v === 'css' && formEdited) {
      cssText = themeToCss({ scheme, base, tokens })
      cssErrors = []
      formEdited = false
    }
    view = v
  }

  /** Keeps the CSS text's header comment and color-scheme line in step with the selects. */
  function syncHeader() {
    if (cssErrors.length) return
    const header = themeToCss({ scheme, base, tokens: {} }).split('\n')
    let text = cssText
    text = /^\/\* Base: [^\n]*\*\/\n/.test(text) ? text.replace(/^\/\* Base: [^\n]*\*\/\n/, `${header[0]}\n`) : `${header[0]}\n${text}`
    text = /color-scheme:\s*(light|dark)\s*;?/.test(text) ? text.replace(/color-scheme:\s*(light|dark)\s*;?/, `color-scheme: ${scheme};`) : text.replace(/\n/, `\ncolor-scheme: ${scheme};\n`)
    cssText = text
  }

  function setBase(id: string) {
    base = id
    const b = findTheme(id)
    if (b) scheme = b.scheme
    syncHeader()
  }
  function setScheme(s: Scheme) {
    scheme = s
    syncHeader()
  }

  function editToken(token: ThemeToken, value: string) {
    const v = value.trim()
    formEdited = true
    const raw = { ...formRaw }
    const errs = { ...formErrors }
    delete raw[token]
    delete errs[token]
    if (!v) {
      const next = { ...tokens }
      delete next[token]
      tokens = next
    } else {
      const problem = checkTokenValue(token, v)
      if (problem) {
        raw[token] = value
        errs[token] = problem
      } else tokens = orderTokens({ ...tokens, [token]: v })
    }
    formRaw = raw
    formErrors = errs
  }

  /** Writes every token the theme does not set yet with its base value, so the whole palette is visible. */
  function fillFromBase() {
    const vars = effectiveVars({ scheme, base, tokens: {} }, null)
    const next: ThemeTokens = {}
    for (const k of THEME_TOKENS) {
      const own = tokens[k]
      const inherited = vars[k]
      if (own !== undefined) next[k] = own
      else if (inherited && !checkTokenValue(k, inherited)) next[k] = inherited
    }
    tokens = orderTokens(next)
    cssText = themeToCss({ scheme, base, tokens })
    cssErrors = []
    formEdited = false
  }

  const inheritedVars = $derived(effectiveVars({ scheme, base, tokens: {} }, null))
  const ownVars = $derived(effectiveVars(draft, null))
  const black = toHex({ r: 0, g: 0, b: 0, a: 1 })

  function save() {
    error = null
    const t: CustomTheme = { id, label: label.trim().slice(0, MAX_THEME_LABEL_LENGTH), scheme, base, tokens: orderTokens(tokens) }
    if (!settings.saveCustomTheme(t)) {
      error = 'You already have the maximum number of custom themes. Delete one first.'
      return
    }
    done = true
    settings.clearDraftTheme(id)
    onsaved?.(t)
    onclose()
  }

  const lights = THEMES.filter((t) => t.scheme === 'light')
  const darks = THEMES.filter((t) => t.scheme === 'dark')
</script>

<Dialog title={isNew ? 'New custom theme' : `Edit theme: ${initial.label}`} onclose={close} size="xl">
  <div class="flex flex-col gap-3 text-sm" data-testid="custom-theme-editor">
    <div class="flex flex-wrap items-end gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-medium text-muted">Name</span>
        <input class="w-56" maxlength={MAX_THEME_LABEL_LENGTH} bind:value={label} aria-label="Theme name" />
      </label>
      <label class="grid gap-1">
        <span class="text-xs font-medium text-muted">Base theme</span>
        <select class="w-48" value={base} onchange={(e) => setBase(e.currentTarget.value)} aria-label="Base theme">
          <optgroup label="Light">{#each lights as t (t.id)}<option value={t.id}>{t.label}</option>{/each}</optgroup>
          <optgroup label="Dark">{#each darks as t (t.id)}<option value={t.id}>{t.label}</option>{/each}</optgroup>
        </select>
      </label>
      <label class="grid gap-1">
        <span class="text-xs font-medium text-muted">Scheme</span>
        <select class="w-28" value={scheme} onchange={(e) => setScheme(e.currentTarget.value as Scheme)} aria-label="Scheme">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <div role="group" aria-label="Editor view" class="ml-auto flex overflow-hidden rounded border border-border text-xs">
        {#each [['css', 'CSS'], ['form', 'Form']] as const as [v, name] (v)}
          <button
            type="button"
            aria-pressed={view === v}
            class="px-2.5 py-1 {view === v ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg'}"
            onclick={() => showView(v)}>{name}</button
          >
        {/each}
      </div>
    </div>

    {#each notices as n, i (i)}
      <p class="rounded border border-warning bg-warning-soft px-2 py-1 text-xs" role="status">{n}</p>
    {/each}

    <div class="grid min-h-0 gap-3 md:grid-cols-[minmax(0,1fr)_16rem]">
      <div class="flex min-w-0 flex-col gap-2">
        {#if view === 'css'}
          <p class="text-xs text-muted">
            One <code>--token: colour;</code> per line (any CSS colour: hex, rgb, hsl, oklch, color-mix, light-dark). Tokens you leave out
            come from the base theme. Selectors, @-rules, url() and var() are not allowed.
          </p>
          <div class="h-80 overflow-hidden rounded border border-border">
            <CodeEditor value={cssText} onchange={onCss} language="css" label="Theme CSS" />
          </div>
          {#if cssErrors.length}
            <ul class="grid gap-0.5 rounded border border-danger bg-danger-soft px-2 py-1.5 text-xs" aria-label="CSS errors" data-testid="theme-css-errors">
              {#each cssErrors as e, i (i)}
                <li><span class="font-semibold">Line {e.line}:</span> {e.message}</li>
              {/each}
            </ul>
          {/if}
        {:else}
          {#if cssErrors.length && !formEdited}
            <p class="rounded border border-warning bg-warning-soft px-2 py-1 text-xs" role="status">
              The CSS has {cssErrors.length} error{cssErrors.length === 1 ? '' : 's'}; this form shows only its valid declarations. Editing here replaces the CSS.
            </p>
          {/if}
          <div class="grid h-96 content-start gap-3 overflow-auto pr-1" data-testid="theme-form">
            {#each TOKEN_GROUPS as g (g.label)}
              <section aria-label={g.label}>
                <h4 class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g.label}</h4>
                {#if g.tokens[0]?.token === 'accent' && accent}
                  <p class="mb-1 text-xs text-faint">An accent colour is selected in Settings, so the app uses it instead of these (choose "Theme default" to use them).</p>
                {/if}
                <div class="grid gap-1">
                  {#each g.tokens as info (info.token)}
                    {@const own = tokens[info.token]}
                    {@const hex = info.token === 'shadow-pop' ? null : tokenHex(draft, null, info.token, undefined, ownVars)}
                    <div class="grid grid-cols-[1.75rem_minmax(0,11rem)_minmax(0,1fr)_1.75rem] items-center gap-2">
                      {#if info.token !== 'shadow-pop'}
                        <input
                          type="color"
                          class="h-6 w-7 cursor-pointer rounded border border-border bg-transparent p-0"
                          value={hex ?? black}
                          aria-label="{info.label} colour"
                          oninput={(e) => editToken(info.token, e.currentTarget.value)}
                        />
                      {:else}
                        <span></span>
                      {/if}
                      <span class="min-w-0 truncate" title={info.hint || info.label}>
                        {info.label} <span class="text-xs text-faint">--{info.token}</span>
                      </span>
                      <input
                        class="min-w-0 font-mono text-xs {formErrors[info.token] ? 'border-danger' : ''}"
                        value={formRaw[info.token] ?? own ?? ''}
                        placeholder={inheritedVars[info.token] ?? ''}
                        aria-label="--{info.token}"
                        aria-invalid={formErrors[info.token] ? true : undefined}
                        onchange={(e) => editToken(info.token, e.currentTarget.value)}
                      />
                      {#if own !== undefined || formRaw[info.token] !== undefined}
                        <button
                          type="button"
                          class="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
                          title="Use the base theme's value"
                          aria-label="Reset --{info.token}"
                          onclick={() => editToken(info.token, '')}><Icon name="refresh" size={12} /></button
                        >
                      {:else}
                        <span></span>
                      {/if}
                      {#if formErrors[info.token]}
                        <span class="col-start-3 text-xs text-danger" role="alert">--{info.token} {formErrors[info.token]}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              </section>
            {/each}
          </div>
        {/if}
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{overridden} of {THEME_TOKENS.length} tokens set; the rest follow {findTheme(base)?.label ?? base}.</span>
          <Button size="sm" onclick={fillFromBase} disabled={overridden === THEME_TOKENS.length || blocking}>Add all tokens from base</Button>
        </div>
      </div>

      <aside class="flex min-w-0 flex-col gap-2" aria-label="Preview and contrast">
        <ThemePreview theme={id} {accent} />
        <label class="flex items-center gap-2 text-xs">
          <input type="checkbox" bind:checked={inApp} />
          Preview in the whole app
        </label>
        <section class="grid gap-1 text-xs" aria-label="Contrast" data-testid="theme-contrast">
          <h4 class="font-semibold">Contrast (WCAG AA)</h4>
          {#if audit.failures.length === 0}
            <p class="flex items-center gap-1 text-success"><Icon name="check" size={12} /> All checked colour pairs are readable.</p>
          {:else}
            <p class="text-warning">
              {audit.failures.length} pair{audit.failures.length === 1 ? '' : 's'} below the target. You can still save; these may be hard to read.
            </p>
            <ul class="grid max-h-60 gap-1 overflow-auto" aria-label="Contrast warnings">
              {#each audit.failures as f, i (i)}
                <li class="flex items-start gap-1.5">
                  <span
                    data-theme={attrs['data-theme']}
                    data-custom-theme={attrs['data-custom-theme']}
                    data-accent={accent ?? undefined}
                    class="mt-px inline-flex h-4 shrink-0 items-center rounded border border-border px-1 text-[10px] font-semibold"
                    style="background: var(--{f.bg}); color: var(--{f.fg})"
                    aria-hidden="true">Aa</span
                  >
                  <span>{describeWarning(f)}</span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if audit.unchecked.length}
            <p class="text-faint">Not checked (colour not understood): {audit.unchecked.map((t) => tokenLabel(t)).join(', ')}</p>
          {/if}
        </section>
      </aside>
    </div>
    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
  </div>

  {#snippet footer()}
    {#if blocking}<span class="mr-auto text-xs text-danger">Fix the CSS errors to save.</span>{/if}
    <Button onclick={close}>Cancel</Button>
    <Button variant="primary" onclick={save} disabled={!canSave}>{isNew ? 'Create theme' : 'Save theme'}</Button>
  {/snippet}
</Dialog>
