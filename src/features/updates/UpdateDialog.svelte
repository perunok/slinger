<script lang="ts">
  /**
   * Update Slinger: download the new release (progress, speed, time left, cancel), then "Restart to update". The work
   * happens in the main process (services/updateInstall.ts); this only shows `updates.install` and calls the store.
   */
  import { ui } from '../../app/ui.svelte'
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import InlineError from '../../components/ui/InlineError.svelte'
  import { formatBytes } from '../../lib/response'
  import { updates } from './updates.svelte'
  import { methodNote, percent, timeLeft } from './progress'

  const s = $derived(updates.install)
  const version = $derived(s?.version ?? updates.available?.version ?? null)
  const busy = $derived(s?.phase === 'installing')
  const pct = $derived(s ? percent(s) : 0)

  function close() {
    if (!busy) ui.updateOpen = false
  }
</script>

<Dialog title="Update Slinger" size="md" onclose={close} {busy}>
  <div class="flex flex-col gap-3 text-sm" data-testid="update-dialog">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      {#if version}
        <span><span class="font-medium">Slinger {version}</span>{updates.currentVersion ? ` · you have ${updates.currentVersion}` : ''}</span>
        <button type="button" class="text-xs text-accent-text hover:underline" onclick={() => updates.openRelease(updates.available ?? updates.latest)}>Release notes</button>
      {:else}
        <span>{updates.currentVersion ? `You have Slinger ${updates.currentVersion}.` : ''}</span>
      {/if}
      {#if s?.method}
        <InfoTip label="How Slinger updates">{methodNote(s.method)}</InfoTip>
      {/if}
    </div>

    {#if !s?.method}
      <p class="text-muted" data-testid="update-unsupported">{s?.unsupportedReason ?? 'This installation cannot update itself.'} Download the new version from the release page.</p>
    {:else if s.phase === 'downloading' || s.phase === 'verifying'}
      <div class="flex flex-col gap-1.5" data-testid="update-progress">
        <div
          class="h-2 overflow-hidden rounded bg-raised"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={s.phase === 'verifying' ? 100 : pct}
        >
          <div class="h-full rounded bg-accent transition-[width] duration-200 {s.phase === 'verifying' ? 'animate-pulse' : ''}" style="width: {s.phase === 'verifying' ? 100 : pct}%"></div>
        </div>
        <p class="flex flex-wrap justify-between gap-2 text-xs text-muted" data-testid="update-progress-text">
          {#if s.phase === 'verifying'}
            <span>Checking the download…</span>
          {:else}
            <span>{s.total ? `${formatBytes(s.received)} of ${formatBytes(s.total)} (${pct}%)` : `${formatBytes(s.received)} downloaded`}</span>
            <span>{s.bytesPerSec ? `${formatBytes(s.bytesPerSec)}/s${timeLeft(s) ? ` · ${timeLeft(s)} left` : ''}` : ''}</span>
          {/if}
        </p>
      </div>
    {:else if s.phase === 'ready'}
      <p data-testid="update-ready">
        Downloaded and verified. <span class="text-muted">Restart to install it{s.method === 'deb' ? ' (your system asks for your password)' : ''}; your open tabs come back.</span>
      </p>
    {:else if s.phase === 'installing'}
      <p data-testid="update-installing">
        {s.method === 'deb' ? 'Installing… enter your password in the system dialog. Slinger restarts when it is done.' : 'Installing… Slinger restarts in a moment.'}
      </p>
    {:else if s.phase === 'error'}
      <InlineError message={s.error} />
    {:else}
      <p class="text-muted">Download the new version, then restart to install it.</p>
    {/if}
  </div>

  {#snippet footer()}
    {#if !s?.method}
      <Button onclick={close}>Close</Button>
      <Button variant="primary" icon="external" onclick={() => updates.openRelease(updates.available ?? updates.latest)}>View release</Button>
    {:else if s.phase === 'downloading' || s.phase === 'verifying'}
      <Button onclick={close}>Hide</Button>
      <Button onclick={() => void updates.cancelDownload()} disabled={s.phase === 'verifying'}>Cancel</Button>
    {:else if s.phase === 'ready'}
      <Button onclick={close}>Later</Button>
      <Button variant="primary" icon="refresh" onclick={() => void updates.restartToUpdate()}>Restart to update</Button>
    {:else if s.phase === 'installing'}
      <Button variant="primary" loading disabled>Installing…</Button>
    {:else}
      <Button onclick={close}>Close</Button>
      {#if s.phase === 'error'}<Button onclick={() => updates.openRelease(updates.available ?? updates.latest)}>View release</Button>{/if}
      <Button variant="primary" icon="download" disabled={!updates.available} onclick={() => void updates.updateNow()}>{s.phase === 'error' ? 'Try again' : 'Update now'}</Button>
    {/if}
  {/snippet}
</Dialog>
