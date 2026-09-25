<script lang="ts">
  /**
   * The in-flight state of the response pane: the loading animation (a character picked per send, or the classic
   * spinner), "Sending request…" with the elapsed time, and Cancel.
   *
   * Stays mounted for the whole tab. When a send ends with a response or an error, the character keeps its place for a
   * short finish, drawn over the top of the pane (pointer-events off) while the response / error is already shown
   * below, so nothing waits for the animation. Cancelling removes it at once.
   */
  import { onDestroy, untrack } from 'svelte'
  import { settings } from '../../app/settings.svelte'
  import Button from '../../components/ui/Button.svelte'
  import LoadingCharacter from '../../components/ui/LoadingCharacter.svelte'
  import Spinner from '../../components/ui/Spinner.svelte'
  import { FINISH_MS, MIN_SHOWN_FOR_FINISH_MS, formatElapsed, pickLoader, prefersReducedMotion, type LoaderKind } from '../../lib/loader'

  let {
    sending,
    outcome = null,
    startedAt = null,
    oncancel,
    rng = Math.random,
    reducedMotion,
  }: {
    sending: boolean
    /** How the send ended (read when `sending` turns false). */
    outcome?: 'success' | 'error' | 'cancelled' | null
    startedAt?: number | null
    oncancel: () => void
    /** Random source for the per-send pick (tests inject one). */
    rng?: () => number
    /** Overrides the prefers-reduced-motion media query (tests). */
    reducedMotion?: boolean
  } = $props()

  type Phase = 'idle' | 'running' | 'success' | 'error'
  let phase = $state<Phase>('idle')
  let kind = $state<LoaderKind>('classic')
  let reduced = $state(false)
  /** Bumped per send so the character starts fresh. */
  let seq = $state(0)
  let finishTimer: ReturnType<typeof setTimeout> | undefined
  let nowMs = $state(Date.now())
  let shownAt = 0

  function stopFinish() {
    clearTimeout(finishTimer)
    finishTimer = undefined
  }

  $effect.pre(() => {
    const isSending = sending
    untrack(() => {
      if (isSending) {
        if (phase === 'running') return
        stopFinish()
        reduced = reducedMotion ?? prefersReducedMotion()
        kind = pickLoader(settings.loader, rng)
        seq += 1
        nowMs = shownAt = Date.now()
        phase = 'running'
        return
      }
      if (phase !== 'running') return
      // A finish only for sends that were visible for a moment: an instant response gets no extra flourish.
      const worthIt = Date.now() - shownAt >= MIN_SHOWN_FOR_FINISH_MS
      if ((outcome === 'success' || outcome === 'error') && kind !== 'classic' && !reduced && worthIt) {
        phase = outcome
        finishTimer = setTimeout(() => (phase = 'idle'), FINISH_MS)
      } else {
        phase = 'idle'
      }
    })
  })
  onDestroy(stopFinish)

  // Elapsed time: ticks while sending, and not at all while the window is hidden.
  $effect(() => {
    if (phase !== 'running') return
    const tick = () => {
      if (document.visibilityState !== 'hidden') nowMs = Date.now()
    }
    const id = setInterval(tick, 100)
    return () => clearInterval(id)
  })

  const inFlow = $derived(sending && phase === 'running')
  const start = $derived(startedAt ?? nowMs)
</script>

{#if phase !== 'idle'}
  <div
    class={inFlow ? 'shrink-0 px-4 pb-2 pt-3' : 'pointer-events-none absolute inset-x-0 top-0 z-10 px-4 pt-3'}
    data-testid="sending"
    data-loader={kind}
    data-phase={phase}
  >
    {#if kind !== 'classic'}
      {#key seq}
        <LoadingCharacter {kind} {phase} startedAt={start} {reduced} class="max-w-xl" />
      {/key}
    {/if}
    {#if inFlow}
      <div class="flex items-center gap-3 text-sm text-muted {kind === 'classic' ? '' : 'mt-2'}">
        {#if kind === 'classic'}<span aria-hidden="true" class="flex"><Spinner /></span>{/if}
        <span role="status">Sending request…</span>
        <span class="tabular-nums text-faint" aria-hidden="true" data-testid="elapsed">{formatElapsed(nowMs - start)}</span>
        <Button size="sm" variant="danger" onclick={oncancel}>Cancel</Button>
      </div>
    {/if}
  </div>
{/if}
