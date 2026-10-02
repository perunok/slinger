<script lang="ts">
  import { onMount } from 'svelte'
  import { settings } from '../../app/settings.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import { api } from '../../lib/ipc'
  import { windowChrome } from '../../app/windowChrome.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import { formatAgo } from '../sync/status'
  import { runsStore } from '../runner/runs.svelte'
  import { updates } from '../updates/updates.svelte'
  import AccentPicker from './AccentPicker.svelte'
  import LoaderPicker from './LoaderPicker.svelte'
  import ThemeGallery from './ThemeGallery.svelte'

  let version = $state<string | null>(null)
  onMount(() => {
    api().getAppVersion().then((v) => (version = v), () => (version = null))
    // "checked 5 min ago" stays current while the dialog is open.
    const timer = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(timer)
  })
  let now = $state(Math.floor(Date.now() / 1000))
  const runningRuns = $derived(runsStore.sessions.filter((s) => s.running).length)
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

  <section class="mb-5">
    <h3 class="mb-2 text-sm font-semibold" id="loader-heading">Loading animation</h3>
    <LoaderPicker />
  </section>

  <section class="mb-5 grid gap-1">
    <label for="font-size" class="text-sm font-semibold">Font size: {settings.fontSize}px</label>
    <input id="font-size" type="range" min="11" max="20" step="1" value={settings.fontSize} oninput={(e) => settings.setFontSize(Number(e.currentTarget.value))} class="w-64" />
  </section>

  <section class="mb-5 grid gap-1.5" aria-labelledby="layout-heading">
    <h3 class="text-sm font-semibold" id="layout-heading">Layout</h3>
    <div role="radiogroup" aria-label="Response position" class="flex flex-wrap items-center gap-4 text-sm">
      <span class="text-muted" aria-hidden="true">Response:</span>
      <label class="flex items-center gap-2">
        <input type="radio" name="response-position" value="below" checked={settings.responsePosition === 'below'} onchange={() => settings.setResponsePosition('below')} />
        Below the request
      </label>
      <label class="flex items-center gap-2">
        <input type="radio" name="response-position" value="beside" checked={settings.responsePosition === 'beside'} onchange={() => settings.setResponsePosition('beside')} />
        Beside the request
      </label>
    </div>
    <p class="text-xs text-faint">Applies to request and example tabs; each layout remembers its own divider position. Also the button on the divider, or Ctrl+Alt+V.</p>
    <label class="mt-1 flex items-center gap-2 text-sm">
      <input type="checkbox" checked={settings.showStatusBar} onchange={(e) => settings.setShowStatusBar(e.currentTarget.checked)} />
      Show status bar
    </label>
  </section>

  {#if windowChrome.loaded}
    <section class="mb-5 grid gap-1.5" aria-labelledby="window-heading">
      <h3 class="text-sm font-semibold" id="window-heading">Window</h3>
      <div class="flex items-center gap-1.5 text-sm">
        <label class="flex items-center gap-2">
          <input type="checkbox" checked={windowChrome.preferred === 'system'} onchange={(e) => void windowChrome.setPreferred(e.currentTarget.checked ? 'system' : 'custom')} />
          Use the system title bar
        </label>
        <InfoTip label="About the title bar">
          By default Slinger's top bar is the window's title bar: drag any empty part of it to move the window, double-click
          it to maximise. The window buttons sit at its end{windowChrome.platform === 'darwin' ? '' : ', and the menu button at its start opens the File, Edit, View and Help menus'}.
          Turn this on for your system's own title bar{windowChrome.platform === 'darwin' ? '' : ' and menu bar'} instead. The change applies when the window reopens.
        </InfoTip>
      </div>
      {#if windowChrome.pendingReopen}
        <div class="flex flex-wrap items-center gap-2 text-xs" data-testid="titlebar-reopen">
          <span class="text-muted">
            Applies when the window reopens{runningRuns > 0 ? `; that stops ${runningRuns === 1 ? 'the collection run' : `${runningRuns} collection runs`} in progress` : ''}.
          </span>
          <Button size="sm" onclick={() => void windowChrome.reopen()}>Reopen window</Button>
        </div>
      {/if}
    </section>
  {/if}

  <section class="mb-5 grid gap-1.5" aria-labelledby="updates-heading">
    <h3 class="text-sm font-semibold" id="updates-heading">Updates</h3>
    <div class="flex items-center gap-1.5 text-sm">
      <label class="flex items-center gap-2">
        <input type="checkbox" checked={updates.auto} onchange={(e) => updates.setAuto(e.currentTarget.checked)} />
        Check for new releases automatically
      </label>
      <InfoTip label="About update checks">
        Once a day Slinger asks GitHub which version of Slinger is the latest release (github.com/perunok/slinger) and shows
        a notification when there is a newer one. The request sends nothing about you or your data. Nothing is downloaded
        or installed: the notification links to the release page. Help &gt; Check for Updates… checks right away.
      </InfoTip>
    </div>
    <div class="flex flex-wrap items-center gap-2 text-xs" data-testid="update-status" aria-live="polite">
      {#if updates.available}
        <span class="font-medium text-fg">Slinger {updates.available.version} is available.</span>
        <Button size="sm" variant="primary" onclick={() => updates.openRelease()}>View release</Button>
      {:else if updates.error}
        <span class="text-danger">Could not check: {updates.error}</span>
      {:else if updates.lastCheckedAt !== null}
        <span class="text-muted">Up to date. Checked {formatAgo(updates.lastCheckedAt, now)}.</span>
      {/if}
      <Button size="sm" loading={updates.checking} disabled={updates.checking} onclick={() => void updates.check('settings').then(() => (now = Math.floor(Date.now() / 1000)))}>
        {updates.checking ? 'Checking…' : 'Check now'}
      </Button>
    </div>
  </section>

  <section class="mb-5">
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={settings.editorWrap} onchange={(e) => settings.setEditorWrap(e.currentTarget.checked)} />
      Wrap long lines in editors (request body, response, code)
    </label>
  </section>

  <section class="mb-5">
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={settings.restoreTabsOnStartup} onchange={(e) => settings.setRestoreTabsOnStartup(e.currentTarget.checked)} />
      Restore open tabs on startup
    </label>
    <p class="mt-1 text-xs text-faint">Reopens each workspace's tabs, in the same order with the same unsaved changes, next time you start Slinger. Turning this off also erases what is currently stored.</p>
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
