<script lang="ts">
  import { app } from '../../app/state.svelte'
  import { toast } from '../../app/toast.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { chooseExportFolder, saveExport } from '../../lib/exportFile'
  import { api, errorInfo } from '../../lib/ipc'
  import { formatBytes } from '../../lib/response'
  import { environmentExportFileName } from '../importexport/fileName'
  import { buildEnvironmentExport, type EnvExportResult } from './envExport'

  const env = $derived(app.environments.find((e) => e.id === ui.exportEnvironmentId) ?? null)
  const envId = $derived(env?.id ?? null)
  const fileName = $derived(env ? environmentExportFileName(env.name) : '')

  let includeSecrets = $state(false)
  let appVersion = $state('unknown')
  /** Built WITHOUT secret values: what the preview shows; secrets are only revealed when saving/copying. */
  let safe = $state.raw<EnvExportResult | null>(null)
  let loadError = $state<string | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let folder = $state<string | null>(null)

  $effect(() => {
    const id = envId
    safe = null
    loadError = null
    includeSecrets = false
    if (!id) return
    let stale = false
    void (async () => {
      try {
        appVersion = await api().getAppVersion().catch(() => 'unknown')
        const target = app.environments.find((e) => e.id === id)
        if (!target) return
        const r = await buildEnvironmentExport(api(), target, { includeSecrets: false, appVersion })
        if (!stale) safe = r
      } catch (e) {
        if (!stale) loadError = `Could not read the environment: ${errorInfo(e).message}`
      }
    })()
    return () => {
      stale = true
    }
  })

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

  function close() {
    ui.exportEnvironmentId = null
    error = null
  }

  /** The file contents; reveals secrets (main process) only when the box is ticked. */
  async function contents(): Promise<EnvExportResult> {
    if (!env) throw new Error('No environment selected')
    if (!includeSecrets && safe) return safe
    const r = await buildEnvironmentExport(api(), env, { includeSecrets, appVersion })
    if (r.missing.length > 0) {
      toast.info('Some secrets have no value on this device', `Exported empty: ${r.missing.join(', ')}`)
    }
    return r
  }

  async function save() {
    busy = true
    error = null
    try {
      const path = await saveExport(fileName, (await contents()).json)
      toast.success('Environment exported', path)
      close()
    } catch (e) {
      error = errorInfo(e).message
    } finally {
      busy = false
    }
  }

  async function copy() {
    busy = true
    error = null
    try {
      await navigator.clipboard.writeText((await contents()).json)
      toast.success('Copied to clipboard')
    } catch (e) {
      error = `Could not copy: ${errorInfo(e).message}`
    } finally {
      busy = false
    }
  }

  async function chooseFolder() {
    error = null
    try {
      folder = (await chooseExportFolder()) ?? folder
    } catch (e) {
      error = errorInfo(e).message
    }
  }
</script>

{#if env}
  <Dialog title="Export environment" onclose={close} {busy} size="md">
    <div class="flex flex-col gap-3 text-sm">
      <p>
        <span class="font-medium">{env.name}</span>
        <span class="text-muted">
          as a Postman environment{safe ? `: ${plural(safe.variables, 'variable')} (${safe.secrets} secret), ${formatBytes(new TextEncoder().encode(safe.json).length)}` : ''}
        </span>
      </p>
      <InlineError message={loadError ?? error} />
      {#if !safe && !loadError}
        <p class="flex items-center gap-2 text-xs text-muted"><Spinner /> Reading variables…</p>
      {/if}
      <label class="flex items-start gap-2">
        <input type="checkbox" bind:checked={includeSecrets} class="mt-0.5" disabled={!safe || safe.secrets === 0} />
        <span>
          Include secret values
          <span class="block text-xs text-muted">
            {#if safe && safe.secrets === 0}
              This environment has no secret variables.
            {:else}
              Off: secrets are exported by name only (type "secret", empty value); importing the file keeps the values already stored.
            {/if}
          </span>
        </span>
      </label>
      {#if includeSecrets}
        <p role="alert" data-testid="secret-warning" class="rounded border border-warning bg-warning-soft px-2 py-1.5 text-xs text-warning">
          The file will contain {plural(safe?.secrets ?? 0, 'secret value')} in plain text. Anyone who gets the file can read them: do not commit it,
          attach it to tickets or share it in chat.
        </p>
      {/if}
      <p class="text-xs text-muted">File: <span class="font-mono text-fg" data-testid="env-export-file-name">{fileName}</span></p>
      {#if safe}
        <pre class="max-h-60 overflow-auto rounded border border-border bg-raised p-2 font-mono text-xs" aria-label="Export preview">{safe.json}</pre>
        {#if includeSecrets}<p class="text-xs text-faint">Secret values are not shown in the preview.</p>{/if}
      {/if}
    </div>
    {#snippet footer()}
      {#if folder}<span class="mr-auto truncate text-xs text-muted" title={folder}>Folder: {folder}</span>{/if}
      <Button onclick={close} disabled={busy}>Close</Button>
      <Button icon="folder" onclick={chooseFolder} disabled={busy}>Choose folder…</Button>
      <Button icon="copy" onclick={copy} disabled={busy || !safe}>Copy to clipboard</Button>
      <Button variant="primary" icon="download" loading={busy} disabled={!safe} onclick={save}>Save to file</Button>
    {/snippet}
  </Dialog>
{/if}
