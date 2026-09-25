<script lang="ts">
  import { onMount } from 'svelte'
  import { settings } from '../../app/settings.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import { api } from '../../lib/ipc'
  import { THEMES } from '../../lib/themes'

  let version = $state<string | null>(null)
  onMount(() => {
    api().getAppVersion().then((v) => (version = v), () => (version = null))
  })

  const choices = [{ id: 'system', label: 'System' }, ...THEMES]
</script>

<Dialog title="Settings" onclose={() => (ui.settingsOpen = false)} size="md">
  <section class="mb-5">
    <h3 class="mb-2 text-sm font-semibold" id="theme-heading">Theme</h3>
    <div role="radiogroup" aria-labelledby="theme-heading" class="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {#each choices as c (c.id)}
        <label
          class="flex cursor-pointer flex-col gap-1.5 rounded-md border p-2 text-sm transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent {settings.theme === c.id ? 'border-accent bg-accent-soft' : 'border-border hover:bg-hover'}"
        >
          <input type="radio" name="theme" value={c.id} class="sr-only" checked={settings.theme === c.id} onchange={() => settings.setTheme(c.id)} />
          <!-- Each swatch is scoped to its own palette via data-theme, so it always shows the real tokens. -->
          <span class="flex h-8 overflow-hidden rounded border border-border" aria-hidden="true">
            {#if c.id === 'system'}
              <span data-theme="light" class="flex-1" style="background:var(--surface)"></span>
              <span data-theme="dark" class="flex-1" style="background:var(--surface)"></span>
            {:else}
              <span data-theme={c.id} class="flex flex-1" style="background:var(--bg)">
                <span class="flex-1" style="background:var(--surface)"></span>
                <span class="flex-1" style="background:var(--accent)"></span>
                <span class="flex-1" style="background:var(--text)"></span>
              </span>
            {/if}
          </span>
          {c.label}
          {#if c.id === 'system'}<span class="text-xs text-faint">Follows your OS</span>{/if}
        </label>
      {/each}
    </div>
  </section>

  <section class="mb-5 grid gap-1">
    <label for="font-size" class="text-sm font-semibold">Font size: {settings.fontSize}px</label>
    <input id="font-size" type="range" min="11" max="20" step="1" value={settings.fontSize} oninput={(e) => settings.setFontSize(Number(e.currentTarget.value))} class="w-64 accent-[var(--accent)]" />
  </section>

  <section class="mb-5">
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={settings.editorWrap} onchange={(e) => settings.setEditorWrap(e.currentTarget.checked)} />
      Wrap long lines in editors (request body, response, code)
    </label>
  </section>

  <section class="mb-2 grid gap-2">
    <h3 class="text-sm font-semibold">Scripts</h3>
    <div class="flex items-center gap-2 text-sm">
      <label for="script-timeout">Time limit per script (ms)</label>
      <input
        id="script-timeout"
        type="number"
        min="100"
        max="60000"
        step="500"
        class="w-28"
        value={settings.scriptTimeoutMs}
        onchange={(e) => settings.setScriptTimeoutMs(Number(e.currentTarget.value))}
      />
    </div>
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={settings.scriptContinueOnError} onchange={(e) => settings.setScriptContinueOnError(e.currentTarget.checked)} />
      Send the request even when a pre-request script fails
    </label>
    <p class="text-xs text-faint">Scripts run in an isolated sandbox without network or file access (64 MB memory per script).</p>
  </section>

  {#snippet footer()}
    <span class="mr-auto text-xs text-faint">Slinger {version ?? ''}</span>
    <Button variant="primary" onclick={() => (ui.settingsOpen = false)}>Done</Button>
  {/snippet}
</Dialog>
