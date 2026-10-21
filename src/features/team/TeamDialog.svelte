<script lang="ts">
  /**
   * Who is in the cloud workspace of the open workspace. A live read of the member list each time it opens (and on
   * Refresh); people are added and removed in the Slinger Cloud dashboard, not here. Opened from the sync chip's
   * popover and Ctrl+K.
   */
  import { onMount } from 'svelte'
  import type { WorkspaceMember } from '../../../shared/types'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { api, errorInfo } from '../../lib/ipc'
  import { sync } from '../sync/syncStore.svelte'
  import { formatJoined, memberName, membersLabel, ROLE_HINT, ROLE_LABEL, sortMembers } from './team'

  const ws = $derived(app.workspace)
  const status = $derived(sync.current)

  let members = $state<WorkspaceMember[] | null>(null)
  let loading = $state(true)
  let error = $state<{ code: string | undefined; message: string } | null>(null)
  let seq = 0

  async function load() {
    const id = app.workspaceId
    if (!id) return
    const mine = ++seq
    loading = true
    try {
      const list = await api().listWorkspaceMembers(id)
      if (mine !== seq) return
      members = sortMembers(list)
      error = null
    } catch (e) {
      if (mine !== seq) return
      const info = errorInfo(e)
      error = { code: info.code, message: info.message }
    } finally {
      if (mine === seq) loading = false
    }
  }
  onMount(() => void load())

  const offline = $derived(error?.code === 'network_error')
  function close() {
    ui.teamOpen = false
  }
</script>

<Dialog title="Team · {status?.remoteName ?? ws?.name ?? ''}" size="md" onclose={close}>
  <div class="flex flex-col gap-3 text-sm" data-testid="team-dialog">
    <div class="flex items-center gap-2 text-xs">
      <span class="text-muted" data-testid="team-count">
        {#if members}{membersLabel(members.length)}{:else if loading}Loading…{:else}Members unknown{/if}
      </span>
      <span class="flex-1"></span>
      <Button size="sm" icon="refresh" loading={loading} onclick={load}>Refresh</Button>
      <InfoTip label="About the team">
        These are the people who can open this cloud workspace, with what each may do. Owners and admins add or remove people and change their
        roles in the Slinger Cloud dashboard; this list updates when you open it or press Refresh. Changes anyone makes sync to every member.
      </InfoTip>
    </div>

    {#if error}
      <div class="flex flex-col gap-1" data-testid="team-error">
        <InlineError message={offline ? 'You are offline or the cloud cannot be reached, so the member list could not be loaded.' : error.message} />
        {#if members}<p class="text-xs text-muted">Showing the list from the last time it loaded.</p>{/if}
      </div>
    {/if}

    {#if members && members.length > 0}
      <ul class="divide-y divide-border rounded border border-border" aria-label="Members" data-testid="team-members">
        {#each members as m (m.id)}
          <li class="flex items-center gap-3 px-3 py-2" data-testid="team-member">
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium">
                {memberName(m)}{#if m.isYou}<span class="ml-1.5 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-normal" data-testid="team-you">You</span>{/if}
              </p>
              <p class="truncate text-xs text-muted">{m.email}</p>
            </div>
            <span class="shrink-0 text-xs text-faint">{formatJoined(m.joinedAt)}</span>
            <span class="shrink-0 rounded bg-raised px-1.5 py-0.5 text-xs" title={ROLE_HINT[m.role]} data-testid="team-role">{ROLE_LABEL[m.role]}</span>
          </li>
        {/each}
      </ul>
    {:else if members}
      <p class="rounded border border-border px-3 py-4 text-center text-xs text-muted" data-testid="team-empty">No members to show.</p>
    {:else if loading}
      <p class="flex items-center gap-2 text-xs text-muted"><Spinner />Loading the members…</p>
    {/if}
  </div>
  {#snippet footer()}
    <Button onclick={close}>Close</Button>
  {/snippet}
</Dialog>
