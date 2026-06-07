<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import type { WorkspaceVersioningCommit, WorkspaceVersioningStatus } from '../tauri'

  export let workspaceName: string | null = null
  export let busy = false
  export let status: WorkspaceVersioningStatus | null = null
  export let history: WorkspaceVersioningCommit[] = []

  const dispatch = createEventDispatcher<{
    refresh: void
    init: void
    commit: string
    restore: string
  }>()

  let commitMessage = ''

  $: changedFiles = status?.changed_files ?? []
  $: canCommit = Boolean(status?.initialized && commitMessage.trim() && !busy)
  $: hasChanges = changedFiles.length > 0
  $: groupedChanges = summarizeChanges(changedFiles)

  function formatTimestamp(value: number): string {
    return new Date(value * 1000).toLocaleString()
  }

  function summarizeChanges(changes: WorkspaceVersioningStatus['changed_files']): Array<{ label: string; count: number }> {
    const counts = new Map<string, number>()

    for (const change of changes) {
      const bucket = bucketLabel(change.path)
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }

    return [...counts.entries()].map(([label, count]) => ({ label, count }))
  }

  function bucketLabel(path: string): string {
    if (path === 'workspace.json' || path === 'snapshot.json') return 'Workspace'
    if (path.startsWith('collections/')) return 'Collections'
    if (path.startsWith('requests/')) return 'Requests'
    if (path.startsWith('folders/')) return 'Folders'
    if (path.startsWith('environments/')) return 'Environments'
    if (path.startsWith('environment-variables/')) return 'Variables'
    return 'Other'
  }

  function submitCommit() {
    if (!canCommit) return
    dispatch('commit', commitMessage.trim())
    commitMessage = ''
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-3">
  <div class="space-y-1">
    <h2 class="m-0 text-sm font-semibold text-[var(--text)]">Local versioning</h2>
    <p class="m-0 text-xs text-[var(--muted)]">
      {workspaceName ?? 'Select a workspace to inspect local Git history.'}
    </p>
  </div>

  {#if !workspaceName}
    <div class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--muted)]">
      Select a workspace first.
    </div>
  {:else if status}
    <div class="space-y-1 text-xs text-[var(--muted)]">
      <p class="m-0"><strong>Repo:</strong> {status.repo_path}</p>
      <p class="m-0"><strong>State:</strong> {status.initialized ? (hasChanges ? 'Changes detected' : 'Clean') : 'Not initialized'}</p>
    </div>

    {#if !status.initialized}
      <button class="primary-button h-9 w-full" type="button" on:click={() => dispatch('init')} disabled={busy}>
        Initialize local Git repo
      </button>
    {:else}
      <div class="space-y-4 overflow-hidden">
        <div class="space-y-2">
          <div class="workspace-versioning-section-header">
            <h3>Working tree</h3>
            <button class="secondary-button h-8" type="button" on:click={() => dispatch('refresh')} disabled={busy}>
              Refresh
            </button>
          </div>

          {#if groupedChanges.length > 0}
            <div class="flex flex-wrap gap-2">
              {#each groupedChanges as group}
                <span class="workspace-versioning-summary">{group.label}: {group.count}</span>
              {/each}
            </div>
          {/if}

          {#if changedFiles.length === 0}
            <p class="workspace-versioning-empty">No changed or untracked files.</p>
          {:else}
            <div class="workspace-versioning-list">
              {#each changedFiles as file}
                <div class="workspace-versioning-row">
                  <span class="workspace-versioning-badge">{file.status || '??'}</span>
                  <code>{file.path}</code>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="space-y-2">
          <h3>Create commit</h3>
          <div class="workspace-versioning-commit">
            <input
              bind:value={commitMessage}
              class="workspace-versioning-input"
              placeholder="Commit message"
              disabled={busy}
              on:keydown={(event) => event.key === 'Enter' && submitCommit()}
            />
            <button class="primary-button h-9" type="button" on:click={submitCommit} disabled={!canCommit}>
              Commit
            </button>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col space-y-2 overflow-hidden">
          <div class="workspace-versioning-section-header">
            <h3>History</h3>
          </div>

          {#if history.length === 0}
            <p class="workspace-versioning-empty">No commits yet.</p>
          {:else}
            <div class="workspace-versioning-list min-h-0 flex-1 overflow-auto">
              {#each history as entry}
                <div class="workspace-versioning-history-item">
                  <div class="workspace-versioning-history-copy">
                    <p class="workspace-versioning-history-title">{entry.message}</p>
                    <p class="workspace-versioning-history-meta">
                      <code>{entry.short_id}</code> by {entry.author} on {formatTimestamp(entry.authored_at)}
                    </p>
                  </div>
                  <button
                    class="secondary-button h-8"
                    type="button"
                    on:click={() => dispatch('restore', entry.id)}
                    disabled={busy}
                  >
                    Restore
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <p class="workspace-versioning-empty">Loading local versioning status…</p>
  {/if}
</div>

<style>
  .workspace-versioning-section-header,
  .workspace-versioning-history-item,
  .workspace-versioning-row,
  .workspace-versioning-commit {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .workspace-versioning-history-meta,
  .workspace-versioning-empty {
    margin: 0;
    color: var(--muted);
  }

  .workspace-versioning-list {
    display: grid;
    gap: 0.5rem;
  }

  .workspace-versioning-row,
  .workspace-versioning-history-item {
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--panel);
    padding: 0.65rem 0.75rem;
  }

  .workspace-versioning-row code,
  .workspace-versioning-history-meta code {
    word-break: break-all;
  }

  .workspace-versioning-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.25rem;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text);
    font-size: 0.75rem;
    font-weight: 700;
    padding: 0.2rem 0.45rem;
  }

  .workspace-versioning-summary {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--panel);
    color: var(--muted);
    font-size: 0.75rem;
    padding: 0.2rem 0.55rem;
  }

  .workspace-versioning-input {
    height: 2.25rem;
    min-width: 0;
    flex: 1;
    border: 1px solid var(--input-border);
    border-radius: 0.375rem;
    background: var(--input);
    color: var(--text);
    padding: 0 0.7rem;
    font-size: 0.95rem;
    outline: none;
  }

  .workspace-versioning-history-copy {
    min-width: 0;
    flex: 1;
  }

  .workspace-versioning-history-title {
    margin: 0;
    font-weight: 600;
  }
</style>
