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
  import Tabs from '../../components/ui/Tabs.svelte'
  import AccentPicker from './AccentPicker.svelte'
  import LoaderPicker from './LoaderPicker.svelte'
  import ThemeGallery from './ThemeGallery.svelte'
  import TitleBarLayoutEditor from './TitleBarLayoutEditor.svelte'
  import McpSettings from '../mcp/McpSettings.svelte'

  const SECTIONS = [
    { id: 'appearance', label: 'Appearance' },
    { id: 'layout', label: 'Layout & window' },
    { id: 'editor', label: 'Editor & tabs' },
    { id: 'scripts', label: 'Scripts' },
    { id: 'updates', label: 'Updates' },
    { id: 'mcp', label: 'AI assistants (MCP)' },
  ] as const

  let version = $state<string | null>(null)
  let titleBarItems: HTMLElement | undefined = $state()
  onMount(() => {
    // Opened from the title bar's "Customize title bar…": go straight to it.
    if (ui.settingsFocus === 'titlebar') {
      ui.settingsFocus = null
      ui.settingsSection = 'layout'
      requestAnimationFrame(() => titleBarItems?.scrollIntoView({ block: 'start' }))
    }
    api().getAppVersion().then((v) => (version = v), () => (version = null))
    // "checked 5 min ago" stays current while the dialog is open.
    const timer = setInterval(() => (now = Math.floor(Date.now() / 1000)), 30_000)
    return () => clearInterval(timer)
  })
  let now = $state(Math.floor(Date.now() / 1000))
  const runningRuns = $derived(runsStore.sessions.filter((s) => s.running).length)
</script>

<Dialog title="Settings" onclose={() => (ui.settingsOpen = false)} size="xl">
  <div class="-mx-4 -my-3 flex h-[min(70vh,44rem)] min-h-0">
    <Tabs
      label="Settings sections"
      idPrefix="settings"
      orientation="vertical"
      class="w-44 shrink-0 py-2"
      value={ui.settingsSection}
      onchange={(id) => (ui.settingsSection = id as typeof ui.settingsSection)}
      tabs={SECTIONS.map((x) => ({ id: x.id, label: x.label }))}
    />
    <div class="min-w-0 flex-1 overflow-auto px-5 py-4" role="tabpanel" id="settings-panel-{ui.settingsSection}" aria-labelledby="settings-{ui.settingsSection}">
      {#if ui.settingsSection === 'appearance'}
        <section class="mb-6">
          <h3 class="mb-2 text-sm font-semibold" id="theme-heading">Theme</h3>
          <ThemeGallery />
        </section>
        <section class="mb-6">
          <h3 class="mb-2 text-sm font-semibold" id="accent-heading">Accent colour</h3>
          <AccentPicker />
        </section>
        <section class="mb-6 grid gap-1">
          <label for="font-size" class="text-sm font-semibold">Font size: {settings.fontSize}px</label>
          <input id="font-size" type="range" min="11" max="20" step="1" value={settings.fontSize} oninput={(e) => settings.setFontSize(Number(e.currentTarget.value))} class="w-64" />
        </section>
        <section>
          <div class="mb-2 flex items-center gap-1.5">
            <h3 class="text-sm font-semibold" id="loader-heading">Loading animation</h3>
            <InfoTip label="About the loading animation">
              Shown while a request is in flight: the character runs back and forth until the response arrives. Random picks one per
              send; with reduced motion turned on in the system it stands still.
            </InfoTip>
          </div>
          <LoaderPicker />
        </section>
      {:else if ui.settingsSection === 'layout'}
        <section class="mb-6 grid gap-2" aria-labelledby="layout-heading">
          <h3 class="text-sm font-semibold" id="layout-heading">Layout</h3>
          <div class="flex flex-wrap items-center gap-4 text-sm">
            <div role="radiogroup" aria-label="Response position" class="flex flex-wrap items-center gap-4">
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
            <InfoTip label="About the response position">
              Applies to request and example tabs; each layout remembers its own divider position. Also the button on the divider, or
              Ctrl+Alt+V.
            </InfoTip>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.showSidebar} onchange={(e) => settings.setShowSidebar(e.currentTarget.checked)} />
            Show sidebar <span class="text-xs text-faint">(Ctrl+B)</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.showStatusBar} onchange={(e) => settings.setShowStatusBar(e.currentTarget.checked)} />
            Show status bar
          </label>
        </section>
        <section class="grid gap-2" aria-labelledby="window-heading">
          <h3 class="text-sm font-semibold" id="window-heading">Title bar</h3>
          {#if windowChrome.loaded}
            <div class="flex items-center gap-1.5 text-sm">
              <label class="flex items-center gap-2">
                <input type="checkbox" checked={windowChrome.preferred === 'system'} onchange={(e) => void windowChrome.setPreferred(e.currentTarget.checked ? 'system' : 'custom')} />
                Use the system title bar
              </label>
              <InfoTip label="About the title bar">
                By default Slinger's top bar is the window's title bar: drag any empty part of it to move the window, double-click it to
                maximise. {windowChrome.platform === 'darwin'
                  ? 'The traffic lights sit at its start.'
                  : 'Its minimise, maximise and close buttons and the menu button (File, Edit, View and Help menus) are title bar items you can place below.'}
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
          {/if}
          <div bind:this={titleBarItems} class="mt-1"><TitleBarLayoutEditor /></div>
        </section>
      {:else if ui.settingsSection === 'editor'}
        <section class="grid gap-3">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.editorWrap} onchange={(e) => settings.setEditorWrap(e.currentTarget.checked)} />
            Wrap long lines in editors (request body, response, code)
          </label>
          <div class="flex items-center gap-1.5 text-sm">
            <label class="flex items-center gap-2">
              <input type="checkbox" checked={settings.restoreTabsOnStartup} onchange={(e) => settings.setRestoreTabsOnStartup(e.currentTarget.checked)} />
              Restore open tabs on startup
            </label>
            <InfoTip label="About restoring tabs">
              Reopens each workspace's tabs, in the same order with the same unsaved changes, next time you start Slinger. Turning this
              off also erases what is currently stored.
            </InfoTip>
          </div>
        </section>
      {:else if ui.settingsSection === 'scripts'}
        <section class="grid gap-3">
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
            <InfoTip label="About scripts">
              Pre-request, test and workflow scripts run in an isolated sandbox without network or file access (64 MB memory per
              script); this limit stops one that runs too long.
            </InfoTip>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.scriptContinueOnError} onchange={(e) => settings.setScriptContinueOnError(e.currentTarget.checked)} />
            Send the request even when a pre-request script fails
          </label>
        </section>
      {:else if ui.settingsSection === 'mcp'}
        <McpSettings {now} />
      {:else}
        <section class="grid gap-2" aria-labelledby="updates-heading">
          <h3 class="sr-only" id="updates-heading">Updates</h3>
          <div class="flex items-center gap-1.5 text-sm">
            <label class="flex items-center gap-2">
              <input type="checkbox" checked={updates.auto} onchange={(e) => updates.setAuto(e.currentTarget.checked)} />
              Check for new releases automatically
            </label>
            <InfoTip label="About update checks">
              Once a day Slinger asks GitHub which version of Slinger is the latest release (github.com/perunok/slinger) and shows a
              notification when there is a newer one. The request sends nothing about you or your data. Nothing is downloaded or
              installed: the notification links to the release page. Help &gt; Check for Updates… checks right away.
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
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <span class="mr-auto text-xs text-faint">Slinger {version ?? ''}</span>
    <Button variant="primary" onclick={() => (ui.settingsOpen = false)}>Done</Button>
  {/snippet}
</Dialog>
