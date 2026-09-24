<script lang="ts">
  /** Server URL, device name, sign-in / signed-in identity and sign-out. */
  import Button from '../../components/ui/Button.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { errorInfo } from '../../lib/ipc'
  import { sync } from '../sync/syncStore.svelte'
  import DeviceSignIn from './DeviceSignIn.svelte'
  import { isInsecureRemote, isValidBaseUrl } from './url'

  let url = $state('')
  let device = $state('')
  let seeded = false
  let error = $state<string | null>(null)
  let saving = $state(false)

  // Seed the form once the main-process config has loaded; later edits belong to the user.
  $effect(() => {
    const c = sync.config
    if (c && !seeded) {
      seeded = true
      url = c.apiBaseUrl
      device = c.deviceName
    }
  })

  const session = $derived(sync.session)
  const signedIn = $derived(session?.status === 'signedIn')
  const signingIn = $derived(sync.signIn.phase === 'waiting' || sync.signIn.phase === 'starting')
  const locked = $derived(signedIn || signingIn)
  const dirty = $derived(!!sync.config && (url.trim().replace(/\/+$/, '') !== sync.config.apiBaseUrl || device.trim() !== sync.config.deviceName))
  const urlInvalid = $derived(url.trim() !== '' && !isValidBaseUrl(url))
  const insecure = $derived(isValidBaseUrl(url) && isInsecureRemote(url))

  /** Returns true when the form values are saved (or unchanged). */
  async function save(): Promise<boolean> {
    error = null
    if (!isValidBaseUrl(url)) {
      error = 'The server URL must start with http:// or https://'
      return false
    }
    if (!dirty) return true
    saving = true
    try {
      const saved = await sync.saveConfig({ apiBaseUrl: url, deviceName: device })
      url = saved.apiBaseUrl
      device = saved.deviceName
      return true
    } catch (e) {
      error = errorInfo(e).message
      return false
    } finally {
      saving = false
    }
  }
</script>

<section class="space-y-3" aria-labelledby="cloud-account-h">
  <h3 id="cloud-account-h" class="text-xs font-semibold uppercase tracking-wide text-muted">Account</h3>

  <div class="grid gap-2">
    <label class="text-xs text-muted" for="cloud-url">API base URL</label>
    <input id="cloud-url" type="text" class="field" spellcheck="false" autocomplete="off" bind:value={url} disabled={locked} aria-invalid={urlInvalid || undefined} aria-describedby={insecure ? 'cloud-url-warn' : undefined} />
    {#if insecure}
      <p id="cloud-url-warn" class="rounded border border-warning bg-warning-soft px-2 py-1 text-xs text-warning">
        This server uses plain http. Your sign-in and workspace content would travel unencrypted; use https unless it is a local development server.
      </p>
    {/if}
    <label class="text-xs text-muted" for="cloud-device">Device name</label>
    <input id="cloud-device" type="text" class="field" autocomplete="off" bind:value={device} disabled={locked} />
    {#if dirty && !locked}
      <div><Button size="sm" loading={saving} onclick={save}>Save server settings</Button></div>
    {/if}
  </div>

  {#if sync.serverUnsupported}
    <p role="alert" data-testid="protocol-warning" class="rounded border border-danger bg-danger-soft px-3 py-2 text-sm text-danger">
      This server is too old for collection sync: it does not support sync protocol version 2. Ask its administrator to upgrade
      Slinger Cloud. Your workspaces keep working locally and nothing is lost.
    </p>
  {/if}

  {#if !session}
    <p class="text-sm text-muted" role="status">Checking session…</p>
  {:else if signedIn}
    <div class="flex items-center justify-between gap-2 rounded border border-border bg-raised px-3 py-2">
      <div class="min-w-0 text-sm">
        <p class="truncate">Signed in as <span class="font-medium">{session.user?.displayName || session.user?.email}</span>
          {#if session.user?.displayName}<span class="text-xs text-muted">({session.user.email})</span>{/if}</p>
        {#if session.offline}<p class="text-xs text-warning" role="status">Offline: the server cannot be reached right now.</p>{/if}
      </div>
      <Button size="sm" onclick={() => sync.signOut()}>Sign out</Button>
    </div>
  {:else}
    <DeviceSignIn beforeStart={save} />
  {/if}
  <InlineError message={error} />
</section>
