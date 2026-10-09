<script lang="ts">
  /** Mounted once by App: starts the sync store, loads the status of the open workspace, hosts the flow dialogs. */
  import { onDestroy, onMount } from 'svelte'
  import { app } from '../../app/state.svelte'
  import { ui } from '../../app/ui.svelte'
  import ConflictsDialog from './ConflictsDialog.svelte'
  import LinkDialog from './LinkDialog.svelte'
  import PublishDialog from './PublishDialog.svelte'
  import { sync } from './syncStore.svelte'

  onMount(() => void sync.init())
  onDestroy(() => sync.dispose())

  $effect(() => {
    const id = app.workspaceId
    if (id) void sync.ensureStatus(id)
  })

  /** While signed in, look for newly shared cloud workspaces: now, every few minutes and when the window comes back. */
  const SHARE_CHECK_MS = 5 * 60_000
  const FOCUS_MIN_GAP_MS = 60_000
  $effect(() => {
    if (!sync.signedIn) return
    let last = 0
    const check = () => {
      last = Date.now()
      void sync.checkShares()
    }
    const onFocus = () => {
      if (Date.now() - last >= FOCUS_MIN_GAP_MS) check()
    }
    check()
    const timer = setInterval(check, SHARE_CHECK_MS)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  })
</script>

{#if ui.conflictsOpen}<ConflictsDialog />{/if}
{#if ui.publishOpen}<PublishDialog />{/if}
{#if ui.linkOpen}<LinkDialog />{/if}
