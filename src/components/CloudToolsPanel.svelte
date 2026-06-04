<script lang="ts">
  import type { Workspace } from '../tauri'
  import type {
    CloudDeviceFlowState,
    CloudHostBinding,
    CloudHostKind,
    CloudInvite,
    CloudJoinRequest,
    CloudRealtimeTokenResponse,
    CloudSyncPullResponse,
    CloudSyncPushResponse,
    CloudUser,
    CloudWorkspace,
    CloudWorkspaceMember,
    CloudWorkspaceRole,
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
  export let selectedWorkspace: Workspace | null
  export let selectedCloudWorkspaceId: string | null
  export let setSelectedCloudWorkspaceId: (value: string | null) => void
  export let selectedCloudWorkspace: CloudWorkspace | null
  export let cloudWorkspaceMembers: CloudWorkspaceMember[]
  export let cloudWorkspaceHosts: CloudHostBinding[]
  export let cloudSyncClientId: string | null
  export let cloudSyncCheckpoint: number
  export let cloudLastInvite: CloudInvite | null
  export let cloudLastJoinRequest: CloudJoinRequest | null
  export let cloudLastPush: CloudSyncPushResponse | null
  export let cloudLastPull: CloudSyncPullResponse | null
  export let cloudLastRealtimeToken: CloudRealtimeTokenResponse | null
  export let createCloudWorkspace: (input: {
    name: string
    slug: string
    description: string
  }) => Promise<void>
  export let refreshCloudWorkspaceDetails: () => Promise<void>
  export let ensureCloudSyncClient: () => Promise<unknown>
  export let pushWorkspaceSync: () => Promise<void>
  export let pullWorkspaceSync: () => Promise<void>
  export let requestRealtimeToken: () => Promise<void>
  export let inviteCloudMember: (input: {
    email: string
    role: CloudWorkspaceRole
  }) => Promise<void>
  export let createCloudJoinRequest: (input: {
    message: string
    requestedRole: CloudWorkspaceRole
  }) => Promise<void>
  export let addCloudHost: (input: {
    host: string
    kind: CloudHostKind
  }) => Promise<void>
  export let changeCloudMemberRole: (input: {
    memberId: string
    role: CloudWorkspaceRole
    version: number
  }) => Promise<void>

  const WORKSPACE_ROLE_OPTIONS: CloudWorkspaceRole[] = ['owner', 'admin', 'editor', 'viewer']
  const HOST_KIND_OPTIONS: CloudHostKind[] = ['custom_domain', 'dedicated_subdomain']

  let copied = false
  let copiedTimeout: ReturnType<typeof setTimeout> | null = null
  let createWorkspaceName = ''
  let createWorkspaceSlug = ''
  let createWorkspaceDescription = ''
  let inviteEmail = ''
  let inviteRole: CloudWorkspaceRole = 'editor'
  let joinMessage = ''
  let joinRole: CloudWorkspaceRole = 'viewer'
  let hostName = ''
  let hostKind: CloudHostKind = 'custom_domain'
  let memberRoleDrafts: Record<string, CloudWorkspaceRole> = {}

  $: if (selectedWorkspace && !createWorkspaceName) {
    createWorkspaceName = selectedWorkspace.name
  }

  $: if (createWorkspaceName && !createWorkspaceSlug) {
    createWorkspaceSlug = slugify(createWorkspaceName)
  }

  $: memberRoleDrafts = cloudWorkspaceMembers.reduce<Record<string, CloudWorkspaceRole>>((drafts, member) => {
    drafts[member.id] = memberRoleDrafts[member.id] ?? member.role
    return drafts
  }, {})

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

  function textareaValue(event: Event): string {
    return (event.currentTarget as HTMLTextAreaElement).value
  }

  function selectValue(event: Event): string {
    return (event.currentTarget as HTMLSelectElement).value
  }

  function slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
  }

  async function copyVerificationUrl() {
    if (!deviceFlow?.verification_uri_complete) return

    await navigator.clipboard.writeText(deviceFlow.verification_uri_complete)
    copied = true
    if (copiedTimeout) clearTimeout(copiedTimeout)
    copiedTimeout = setTimeout(() => {
      copied = false
    }, 1400)
  }

  async function handleCreateWorkspace() {
    const name = createWorkspaceName.trim()
    const slug = createWorkspaceSlug.trim()
    if (!name || !slug) return

    await createCloudWorkspace({
      name,
      slug,
      description: createWorkspaceDescription,
    })
    createWorkspaceDescription = ''
  }

  async function handleInvite() {
    const email = inviteEmail.trim()
    if (!email) return

    await inviteCloudMember({
      email,
      role: inviteRole,
    })
    inviteEmail = ''
  }

  async function handleJoinRequest() {
    const message = joinMessage.trim()
    if (!message) return

    await createCloudJoinRequest({
      message,
      requestedRole: joinRole,
    })
    joinMessage = ''
  }

  async function handleAddHost() {
    const host = hostName.trim()
    if (!host) return

    await addCloudHost({
      host,
      kind: hostKind,
    })
    hostName = ''
  }

  async function handleMemberRoleUpdate(member: CloudWorkspaceMember) {
    const role = memberRoleDrafts[member.id] ?? member.role
    if (role === member.role) return

    await changeCloudMemberRole({
      memberId: member.id,
      role,
      version: member.version,
    })
  }

  function setMemberRoleDraft(memberId: string, role: CloudWorkspaceRole) {
    memberRoleDrafts = {
      ...memberRoleDrafts,
      [memberId]: role,
    }
  }

  function handleMemberRoleDraftChange(memberId: string, event: Event) {
    setMemberRoleDraft(memberId, selectValue(event) as CloudWorkspaceRole)
  }

  function handleInviteRoleChange(event: Event) {
    inviteRole = selectValue(event) as CloudWorkspaceRole
  }

  function handleJoinRoleChange(event: Event) {
    joinRole = selectValue(event) as CloudWorkspaceRole
  }

  function handleHostKindChange(event: Event) {
    hostKind = selectValue(event) as CloudHostKind
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
  <section class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
    <div class="mb-3">
      <div class="text-sm font-semibold text-[var(--text)]">Cloud Endpoint</div>
      <p class="mt-1 text-xs text-[var(--muted)]">Configure the Slinger Cloud API and desktop device name used for login, publish, and sync flows.</p>
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
            Not signed in yet.
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
        <div class="text-sm font-semibold text-[var(--text)]">Cloud Workspaces</div>
        <p class="mt-1 text-xs text-[var(--muted)]">Create a remote workspace, publish the selected local workspace, and inspect cloud-side metadata.</p>
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

      <div class="grid gap-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
        <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">Create Remote Workspace</div>
        <input
          value={createWorkspaceName}
          on:input={(event) => {
            createWorkspaceName = inputValue(event)
            createWorkspaceSlug = slugify(createWorkspaceName)
          }}
          class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 text-sm text-[var(--text)] outline-none"
          placeholder="Workspace name"
        />
        <input
          value={createWorkspaceSlug}
          on:input={(event) => (createWorkspaceSlug = slugify(inputValue(event)))}
          class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 text-sm text-[var(--text)] outline-none"
          placeholder="workspace-slug"
        />
        <textarea
          value={createWorkspaceDescription}
          on:input={(event) => (createWorkspaceDescription = textareaValue(event))}
          class="min-h-[76px] rounded border border-[var(--input-border)] bg-[var(--input)] px-3 py-2 text-sm text-[var(--text)] outline-none"
          placeholder="Optional description"
        />
        <button type="button" class="secondary-button" on:click={handleCreateWorkspace} disabled={!cloudUser || cloudBusy}>
          Create Remote Workspace
        </button>
      </div>

      <div class="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]">
        {selectedWorkspace?.name ?? 'No local workspace selected'}
      </div>

      <button
        type="button"
        class="primary-button"
        on:click={publishWorkspaceToCloud}
        disabled={!cloudUser || !selectedWorkspace || publishBusy}
      >
        {publishBusy ? 'Publishing...' : 'Publish Selected Local Workspace'}
      </button>
    </div>

    {#if selectedCloudWorkspace}
      <div class="mt-4 rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
        <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">Workspace Summary</div>
        <div class="mt-2 grid gap-1">
          <div class="text-sm font-semibold text-[var(--text)]">{selectedCloudWorkspace.name}</div>
          <div>Slug: <span class="font-mono text-[var(--text)]">{selectedCloudWorkspace.slug}</span></div>
          <div>Role: <span class="text-[var(--text)]">{selectedCloudWorkspace.role ?? selectedCloudWorkspace.effective_role ?? 'unknown'}</span></div>
          <div>Host Mode: <span class="text-[var(--text)]">{selectedCloudWorkspace.host_mode ?? 'shared'}</span></div>
          <div>Version: <span class="text-[var(--text)]">{selectedCloudWorkspace.version}</span></div>
        </div>
      </div>
    {/if}
  </section>

  <section class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
    <div class="mb-3">
      <div class="text-sm font-semibold text-[var(--text)]">Sync and Realtime</div>
      <p class="mt-1 text-xs text-[var(--muted)]">Register the desktop client, push local snapshot operations, pull remote operations, and request workspace event tokens.</p>
    </div>

    <div class="grid gap-3">
      <div class="rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
        <div>Client ID: <span class="font-mono text-[var(--text)]">{cloudSyncClientId ?? 'Not registered yet'}</span></div>
        <div class="mt-1">Checkpoint: <span class="text-[var(--text)]">{cloudSyncCheckpoint}</span></div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button type="button" class="secondary-button" on:click={ensureCloudSyncClient} disabled={!cloudUser || cloudBusy}>
          Register Sync Client
        </button>
        <button type="button" class="secondary-button" on:click={pushWorkspaceSync} disabled={!cloudUser || !selectedWorkspace || !selectedCloudWorkspace || cloudBusy}>
          Push Snapshot
        </button>
        <button type="button" class="secondary-button" on:click={pullWorkspaceSync} disabled={!cloudUser || !selectedCloudWorkspace || cloudBusy}>
          Pull Changes
        </button>
        <button type="button" class="secondary-button" on:click={requestRealtimeToken} disabled={!cloudUser || !selectedCloudWorkspace || cloudBusy}>
          Get Realtime Token
        </button>
      </div>

      {#if cloudLastPush}
        <div class="rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
          Push accepted <span class="text-[var(--text)]">{cloudLastPush.accepted.length}</span> ops, rejected <span class="text-[var(--text)]">{cloudLastPush.rejected.length}</span>.
        </div>
      {/if}

      {#if cloudLastPull}
        <div class="rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
          Pull returned <span class="text-[var(--text)]">{cloudLastPull.operations.length}</span> ops.
        </div>
      {/if}

      {#if cloudLastRealtimeToken}
        <div class="rounded border border-[var(--border)] bg-[var(--bg)] p-3 text-xs text-[var(--muted)]">
          Realtime channels: <span class="text-[var(--text)]">{cloudLastRealtimeToken.channels.join(', ')}</span>
        </div>
      {/if}
    </div>
  </section>

  <section class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
    <div class="mb-3">
      <div class="text-sm font-semibold text-[var(--text)]">Members and Access</div>
      <p class="mt-1 text-xs text-[var(--muted)]">List current members, send invites, and submit join requests against the selected cloud workspace.</p>
    </div>

    <div class="grid gap-4">
      <div class="grid gap-2">
        {#if !selectedCloudWorkspace}
          <div class="text-sm text-[var(--muted)]">Select a remote workspace to load its members.</div>
        {:else if cloudWorkspaceMembers.length === 0}
          <div class="text-sm text-[var(--muted)]">No member records loaded.</div>
        {:else}
          {#each cloudWorkspaceMembers as member (member.id)}
            <div class="rounded border border-[var(--border)] bg-[var(--bg)] p-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="truncate text-sm font-semibold text-[var(--text)]">{member.display_name ?? member.email}</div>
                  <div class="truncate text-xs text-[var(--muted)]">{member.email}</div>
                </div>
                <span class="rounded bg-[var(--surface)] px-2 py-1 text-[10px] font-semibold uppercase text-[var(--muted)]">
                  {member.status}
                </span>
              </div>

              <div class="mt-3 flex gap-2">
                <select
                  value={memberRoleDrafts[member.id] ?? member.role}
                  class="select-field h-8 flex-1 rounded px-2 text-sm outline-none"
                  on:change={(event) => handleMemberRoleDraftChange(member.id, event)}
                >
                  {#each WORKSPACE_ROLE_OPTIONS as role}
                    <option value={role}>{role}</option>
                  {/each}
                </select>
                <button
                  type="button"
                  class="secondary-button"
                  on:click={() => handleMemberRoleUpdate(member)}
                  disabled={cloudBusy || (memberRoleDrafts[member.id] ?? member.role) === member.role}
                >
                  Update
                </button>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <div class="grid gap-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
        <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">Invite Member</div>
        <input
          value={inviteEmail}
          on:input={(event) => (inviteEmail = inputValue(event))}
          class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 text-sm text-[var(--text)] outline-none"
          placeholder="user@example.com"
        />
        <select
          value={inviteRole}
          class="select-field h-9 rounded px-3 text-sm outline-none"
          on:change={handleInviteRoleChange}
        >
          {#each WORKSPACE_ROLE_OPTIONS.filter((role) => role !== 'owner') as role}
            <option value={role}>{role}</option>
          {/each}
        </select>
        <button type="button" class="secondary-button" on:click={handleInvite} disabled={!selectedCloudWorkspace || cloudBusy}>
          Send Invite
        </button>
        {#if cloudLastInvite}
          <div class="text-xs text-[var(--muted)]">Last invite: <span class="text-[var(--text)]">{cloudLastInvite.email}</span> as {cloudLastInvite.role}</div>
        {/if}
      </div>

      <div class="grid gap-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
        <div class="text-[10px] font-semibold uppercase text-[var(--muted)]">Join Request</div>
        <textarea
          value={joinMessage}
          on:input={(event) => (joinMessage = textareaValue(event))}
          class="min-h-[76px] rounded border border-[var(--input-border)] bg-[var(--input)] px-3 py-2 text-sm text-[var(--text)] outline-none"
          placeholder="I need access to review requests."
        />
        <select
          value={joinRole}
          class="select-field h-9 rounded px-3 text-sm outline-none"
          on:change={handleJoinRoleChange}
        >
          {#each WORKSPACE_ROLE_OPTIONS.filter((role) => role !== 'owner') as role}
            <option value={role}>{role}</option>
          {/each}
        </select>
        <button type="button" class="secondary-button" on:click={handleJoinRequest} disabled={!selectedCloudWorkspace || cloudBusy}>
          Submit Join Request
        </button>
        {#if cloudLastJoinRequest}
          <div class="text-xs text-[var(--muted)]">Last request: <span class="text-[var(--text)]">{cloudLastJoinRequest.status}</span> for {cloudLastJoinRequest.requested_role}</div>
        {/if}
      </div>
    </div>
  </section>

  <section class="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
    <div class="mb-3">
      <div class="text-sm font-semibold text-[var(--text)]">Workspace Hosts</div>
      <p class="mt-1 text-xs text-[var(--muted)]">Attach dedicated subdomains or custom domains to the selected cloud workspace.</p>
    </div>

    <div class="grid gap-3">
      <div class="grid gap-2 rounded border border-[var(--border)] bg-[var(--bg)] p-3">
        <input
          value={hostName}
          on:input={(event) => (hostName = inputValue(event))}
          class="h-9 rounded border border-[var(--input-border)] bg-[var(--input)] px-3 text-sm text-[var(--text)] outline-none"
          placeholder="api.customer-domain.com"
        />
        <select
          value={hostKind}
          class="select-field h-9 rounded px-3 text-sm outline-none"
          on:change={handleHostKindChange}
        >
          {#each HOST_KIND_OPTIONS as kind}
            <option value={kind}>{kind}</option>
          {/each}
        </select>
        <button type="button" class="secondary-button" on:click={handleAddHost} disabled={!selectedCloudWorkspace || cloudBusy}>
          Add Host
        </button>
      </div>

      {#if !selectedCloudWorkspace}
        <div class="text-sm text-[var(--muted)]">Select a remote workspace to load host bindings.</div>
      {:else if cloudWorkspaceHosts.length === 0}
        <div class="text-sm text-[var(--muted)]">No host bindings loaded yet.</div>
      {:else}
        <div class="space-y-2">
          {#each cloudWorkspaceHosts as host (host.id)}
            <div class="rounded border border-[var(--border)] bg-[var(--bg)] px-3 py-2">
              <div class="text-sm font-semibold text-[var(--text)]">{host.host}</div>
              <div class="mt-1 text-xs text-[var(--muted)]">{host.kind} • {host.status} • TLS {host.tls_status}</div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>
</div>
