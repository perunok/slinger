<script lang="ts">
  import { onMount } from 'svelte'
  import { settings } from '../../app/settings.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import { api } from '../../lib/ipc'
  import AccentPicker from './AccentPicker.svelte'
  import ThemeGallery from './ThemeGallery.svelte'

  let version = $state<string | null>(null)
  onMount(() => {
    api().getAppVersion().then((v) => (version = v), () => (version = null))
  })
</script>

<Dialog title="Settings" onclose={() => (ui.settingsOpen = false)} size="lg">
  <section class="mb-5">
    <h3 class="mb-2 text-sm font-semibold" id="theme-heading">Theme</h3>
    <ThemeGallery />
  </section>

  <section class="mb-5">
    <h3 class="mb-2 text-sm font-semibold" id="accent-heading">Accent colour</h3>
    <AccentPicker />
  </section>

  <section class="mb-5 grid gap-1">
    <label for="font-size" class="text-sm font-semibold">Font size: {settings.fontSize}px</label>
    <input id="font-size" type="range" min="11" max="20" step="1" value={settings.fontSize} oninput={(e) => settings.setFontSize(Number(e.currentTarget.value))} class="w-64" />
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
