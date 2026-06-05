<script lang="ts">
  import type { Workspace } from '../tauri'
  import type {
    CloudDeviceFlowState,
    CloudUser,
    CloudWorkspace,
  } from '../cloud'

  export let apiBaseUrl: string
  export let setApiBaseUrl: (value: string) => void
  export let deviceName: string
  export let setDeviceName: (value: string) => void
  export let saveCloudConfig: () => void
  export let cloudUser: CloudUser | null
  export let cloudWorkspaces: CloudWorkspace[]
  export let cloudBusy = false
  export let publishBusy = false
  export let deviceFlow: CloudDeviceFlowState | null
  export let startCloudSignIn: () => Promise<void>
  export let pollCloudSignIn: () => Promise<void>
  export let refreshCloudState: () => Promise<void>
  export let signOutCloud: () => Promise<void>
  export let publishWorkspaceToCloud: () => Promise<void>
  export let pushWorkspaceSync: () => Promise<void>
  export let pullWorkspaceSync: () => Promise<void>
  export let selectedWorkspace: Workspace | null
  export let selectedCloudWorkspaceId: string | null
  export let setSelectedCloudWorkspaceId: (value: string | null) => void
  export let selectedCloudWorkspace: CloudWorkspace | null
  export let refreshCloudWorkspaceDetails: () => Promise<void>
  export let openAdminUiHint = 'Admins create accounts, workspaces, and permissions in the admin UI. Desktop users sign in through the browser and work from this app.'

  let copied = false
  let copiedTimeout: ReturnType<typeof setTimeout> | null = null

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }

  $: remoteVersion = selectedCloudWorkspace?.version ?? null
  $: localVersion = selectedWorkspace?.version ?? null
  $: remoteWorkspaceIsNewer =
    remoteVersion !== null && localVersion !== null && remoteVersion > localVersion
  $: versionsDiffer =
    remoteVersion !== null && localVersion !== null && remoteVersion !== localVersion

  async function copyVerificationUrl() {
    if (!deviceFlow?.verification_uri_complete) return

    await navigator.clipboard.writeText(deviceFlow.verification_uri_complete)
    copied = true
    if (copiedTimeout) clearTimeout(copiedTimeout)
    copiedTimeout = setTimeout(() => {
      copied = false
    }, 1400)
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
  <section class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
    <div class="mb-3">
      <div class="text-sm font-semibold text-[var(--text)]">Cloud Endpoint</div>
      <p class="mt-1 text-xs text-[var(--muted)]">Configure the API endpoint and desktop name used for account sign-in and workspace linking.</p>
    </div>

    <div class="grid gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-semibold uppercase text-[var(--muted)]">API Base URL</span>
        <input
          value={apiBaseUrl}
          on:input={(event) => setApiBaseUrl(inputValue(event))}
          class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 text-sm text-[var(--text)] outline-none"
          placeholder="http://localhost:8787"
        />
      </label>

      <label class="grid gap-1">
        <span class="text-xs font-semibold uppercase text-[var(--muted)]">Device Name</span>
        <input
          value={deviceName}
          on:input={(event) => setDeviceName(inputValue(event))}
          class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 text-sm text-[var(--text)] outline-none"
          placeholder="Slinger Desktop"
        />
      </label>

      <div class="flex gap-2">
        <button type="button" class="secondary-button" on:click={saveCloudConfig}>
          Save Config
        </button>
        <button type="button" class="secondary-button" on:click={refreshCloudState} disabled={cloudBusy || !cloudUser}>
          Refresh
        </button>
      </div>
    </div>
  </section>

  <section class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
    <div class="mb-3 flex items-start justify-between gap-3">
      <div>
        <div class="text-sm font-semibold text-[var(--text)]">Cloud Account</div>
        <p class="mt-1 text-xs text-[var(--muted)]">
          {#if cloudUser}
            Signed in as {cloudUser.display_name} ({cloudUser.email})
          {:else}
            Accounts must be created by an admin before device sign-in will succeed.
          {/if}
        </p>
      </div>
      {#if cloudUser}
        <span class="rounded bg-[var(--surface)] px-2 py-1 text-[10px] font-semibold uppercase text-[var(--muted)]">
          {cloudUser.platform_role}
        </span>
      {/if}
    </div>

    {#if !cloudUser}
      <div class="mb-3 rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
        {openAdminUiHint}
      </div>
      <div class="flex gap-2">
        <button type="button" class="primary-button" on:click={startCloudSignIn} disabled={cloudBusy}>
          {cloudBusy ? 'Starting...' : 'Start Sign In'}
        </button>
        {#if deviceFlow}
          <button type="button" class="secondary-button" on:click={pollCloudSignIn} disabled={cloudBusy}>
            Continue
          </button>
        {/if}
      </div>
    {:else}
      <div class="flex gap-2">
        <button type="button" class="secondary-button" on:click={refreshCloudState} disabled={cloudBusy}>
          Refresh Account
        </button>
        <button type="button" class="secondary-button" on:click={signOutCloud} disabled={cloudBusy}>
          Sign Out
        </button>
      </div>
    {/if}

    {#if deviceFlow}
      <div class="mt-4 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
        <div class="text-xs font-semibold uppercase text-[var(--muted)]">Device Flow</div>
        <div class="mt-3 grid gap-3">
          <div>
            <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">User Code</div>
            <div class="mt-1 rounded bg-[var(--surface)] px-3 py-2 font-mono text-sm tracking-[0.18em] text-[var(--text)]">
              {deviceFlow.user_code}
            </div>
          </div>
          <div>
            <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">Verification URL</div>
            <div class="mt-1 break-all rounded bg-[var(--surface)] px-3 py-2 font-mono text-xs text-[var(--text)]">
              {deviceFlow.verification_uri_complete}
            </div>
          </div>
          <div class="flex gap-2">
            <button type="button" class="secondary-button" on:click={copyVerificationUrl}>
              {copied ? 'Copied' : 'Copy URL'}
            </button>
            <button type="button" class="primary-button" on:click={pollCloudSignIn} disabled={cloudBusy}>
              {cloudBusy ? 'Checking...' : 'I Completed Sign In'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  </section>

  <section class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
    <div class="mb-3 flex items-start justify-between gap-3">
      <div>
        <div class="text-sm font-semibold text-[var(--text)]">Workspace Link</div>
        <p class="mt-1 text-xs text-[var(--muted)]">Select an existing remote workspace, then link the selected local workspace to it.</p>
      </div>
      <button type="button" class="secondary-button" on:click={refreshCloudWorkspaceDetails} disabled={!cloudUser || !selectedCloudWorkspaceId || cloudBusy}>
        Refresh Details
      </button>
    </div>

    <div class="grid gap-3">
      <label class="grid gap-1">
        <span class="text-xs font-semibold uppercase text-[var(--muted)]">Selected Remote Workspace</span>
        <select
          value={selectedCloudWorkspaceId ?? ''}
          class="select-field h-9 rounded px-3 text-sm outline-none"
          on:change={(event) => setSelectedCloudWorkspaceId(selectValue(event) || null)}
          disabled={!cloudUser || cloudWorkspaces.length === 0}
        >
          <option value="">No remote workspace selected</option>
          {#each cloudWorkspaces as workspace (workspace.id)}
            <option value={workspace.id}>{workspace.name} ({workspace.slug})</option>
          {/each}
        </select>
      </label>

      <div class="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]">
        {selectedWorkspace?.name ?? 'No local workspace selected'}
      </div>

      {#if selectedWorkspace && selectedCloudWorkspace && versionsDiffer}
        <div class="rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
          <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">Version Status</div>
          <div class="mt-2">Local version: <span class="text-[var(--text)]">{localVersion}</span></div>
          <div>Remote version: <span class="text-[var(--text)]">{remoteVersion}</span></div>
          {#if remoteWorkspaceIsNewer}
            <div class="mt-2 text-[var(--text)]">A newer remote version is available for this workspace.</div>
            <button
              type="button"
              class="secondary-button mt-3"
              on:click={pullWorkspaceSync}
              disabled={!cloudUser || cloudBusy}
            >
              {cloudBusy ? 'Pulling...' : 'Pull Remote Changes'}
            </button>
          {:else}
            <div class="mt-2 text-[var(--text)]">The selected local workspace is ahead of the remote version.</div>
            <button
              type="button"
              class="secondary-button mt-3"
              on:click={pushWorkspaceSync}
              disabled={!cloudUser || cloudBusy || publishBusy}
            >
              {cloudBusy ? 'Pushing...' : 'Push Local Changes'}
            </button>
          {/if}
        </div>
      {/if}

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="primary-button"
          on:click={publishWorkspaceToCloud}
          disabled={!cloudUser || !selectedWorkspace || !selectedCloudWorkspace || publishBusy}
        >
          {publishBusy ? 'Publishing...' : 'Publish Selected Local Workspace'}
        </button>
        <button
          type="button"
          class="secondary-button"
          on:click={pushWorkspaceSync}
          disabled={!cloudUser || !selectedWorkspace || !selectedCloudWorkspace || cloudBusy || publishBusy}
        >
          {cloudBusy ? 'Pushing...' : 'Push Local Changes'}
        </button>
      </div>
    </div>

    {#if selectedCloudWorkspace}
      <div class="mt-4 rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
        <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">Selected Remote Workspace</div>
        <div class="mt-2 grid gap-1">
          <div class="text-sm font-semibold text-[var(--text)]">{selectedCloudWorkspace.name}</div>
          <div>Slug: <span class="font-mono text-[var(--text)]">{selectedCloudWorkspace.slug}</span></div>
          <div>Role: <span class="text-[var(--text)]">{selectedCloudWorkspace.role ?? selectedCloudWorkspace.effective_role ?? 'unknown'}</span></div>
          <div>Host Mode: <span class="text-[var(--text)]">{selectedCloudWorkspace.host_mode ?? 'shared'}</span></div>
          <div>Version: <span class="text-[var(--text)]">{selectedCloudWorkspace.version}</span></div>
        </div>
      </div>
    {/if}

    <div class="mt-4 rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
      Remote workspaces must already exist. Admins manage workspace creation and permissions in the admin UI.
    </div>
  </section>
</div>
