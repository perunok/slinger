<script lang="ts">
  /**
   * An animated character that runs across a thin track while a request is in flight: left to right, then back, lap
   * after lap (each lap a little faster, see lapMs) until the request ends. Then a short finish ('success' / 'error'),
   * drawn where the character stopped.
   *
   * Decorative only (aria-hidden): the caller keeps an accessible status text. Colours come from theme tokens through
   * currentColor (text-accent / text-danger / text-muted), so every theme and accent works.
   *
   * A lap is one CSS animation of the mover (transform only). Its `animationend` flips `direction` and starts the next
   * lap (the mover is re-keyed per lap), so `data-direction` / `data-lap` always tell where the character is heading.
   * Reduced motion: the character stands still at the start of the track with a slow pulse. A hidden window pauses
   * every animation.
   */
  import { onMount, untrack } from 'svelte'
  import { RUNNER_CHEER, RUNNER_FRAMES, RUNNER_H, RUNNER_W, lapMs, spritePixels, type LoaderCharacter, type LoaderPhase } from '../../lib/loader'

  let {
    kind,
    phase = 'running',
    startedAt = Date.now(),
    reduced = false,
    still = false,
    line = true,
    size = 'md',
    now = () => Date.now(),
    class: cls = '',
  }: {
    kind: LoaderCharacter
    phase?: LoaderPhase
    /** When the request started; later laps are faster. */
    startedAt?: number
    /** prefers-reduced-motion: no running, no finish. */
    reduced?: boolean
    /** A motionless picture (settings preview). */
    still?: boolean
    /** Draw the track line (off when the character runs on something else, e.g. a progress bar). */
    line?: boolean
    size?: 'md' | 'sm'
    now?: () => number
    class?: string
  } = $props()

  let lap = $state(0)
  let duration = $state(untrack(() => lapMs(now() - startedAt)))
  const direction = $derived(lap % 2 === 0 ? 'right' : 'left')
  let hidden = $state(typeof document !== 'undefined' && document.visibilityState === 'hidden')

  onMount(() => {
    const onVisibility = () => (hidden = document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  })

  /** The mover reached an edge: turn around and run the next (slightly faster) lap. */
  function lapDone(e: AnimationEvent) {
    if (e.target !== e.currentTarget || !running) return
    duration = lapMs(now() - startedAt)
    lap += 1
  }

  const sm = $derived(size === 'sm')
  /** Character width in px; the mover stops this far from the right so the character ends flush with the track. */
  const charW = $derived((kind === 'runner' ? 20 : kind === 'shuttle' ? 40 : 10) * (sm ? 0.5 : 1))
  const insetL = $derived(kind === 'pebble' ? (sm ? 8 : 16) : 0)
  const insetR = $derived(kind === 'pebble' ? (sm ? 6 : 12) : 0)
  const frames = RUNNER_FRAMES.map(spritePixels)
  const cheer = spritePixels(RUNNER_CHEER)
  /** No movement at all: reduced motion (with a slow pulse) or a still preview. */
  const fixed = $derived(reduced || still)
  const running = $derived(phase === 'running' && !fixed)
  const tone = $derived(phase === 'error' ? 'text-danger' : 'text-accent')
  const stars = [
    { x: 6, y: 20, d: 0 },
    { x: 19, y: 55, d: 700 },
    { x: 33, y: 12, d: 300 },
    { x: 48, y: 42, d: 1100 },
    { x: 62, y: 18, d: 500 },
    { x: 77, y: 50, d: 900 },
    { x: 91, y: 26, d: 200 },
  ]
</script>

<div
  class="slg-track relative w-full {sm ? 'h-5' : 'h-10'} {cls}"
  class:finishing={phase !== 'running' && !fixed}
  aria-hidden="true"
  data-testid="loading-character"
  data-kind={kind}
  data-phase={phase}
  data-direction={direction}
  data-lap={lap}
  data-lap-ms={duration}
  data-motion={still ? 'still' : reduced ? 'reduced' : 'full'}
  data-paused={hidden || undefined}
>
  {#if line}<span class="absolute inset-x-0 h-px bg-muted opacity-40 {sm ? 'bottom-px' : 'bottom-0.5'}"></span>{/if}

  {#if kind === 'shuttle'}
    {#each stars as s (s.x)}
      <span class="slg-star absolute h-0.5 w-0.5 rounded-full bg-muted" style="left: {s.x}%; top: {s.y}%; animation-delay: -{s.d}ms"></span>
    {/each}
  {:else if kind === 'pebble'}
    <svg class="absolute bottom-0 left-0 text-muted" width={sm ? 7 : 14} height={sm ? 10 : 20} viewBox="0 0 14 20" fill="none" stroke="currentColor" stroke-linecap="round">
      <path d="M7 19 V11 M7 11 L2.5 3 M7 11 L11.5 3" stroke-width="2.2" />
      <path class="slg-band" d="M2.5 3 L7 7 L11.5 3" stroke-width="1" />
    </svg>
    <svg class="absolute bottom-0.5 right-0 text-muted" width={sm ? 5 : 10} height={sm ? 12 : 24} viewBox="0 0 10 24" fill="none" stroke="currentColor">
      <ellipse cx="5" cy="12" rx="3.5" ry="10.5" stroke-width="1.4" />
      <ellipse cx="5" cy="12" rx="1.3" ry="4" fill="currentColor" stroke="none" />
    </svg>
  {/if}

  {#key lap}
    <div
      class="slg-mover absolute bottom-0 top-0"
      class:reverse={direction === 'left'}
      class:ease={kind === 'shuttle'}
      class:still={!running}
      style="left: {insetL}px; right: {insetR + charW}px; animation-duration: {duration}ms"
      onanimationend={lapDone}
    >
      {#if kind === 'runner'}
        <div class="slg-actor absolute bottom-0 left-0 {tone}" class:left={direction === 'left'} class:pulse={reduced && !still}>
          <div class="slg-fin runner" class:success={phase === 'success' && !fixed} class:error={phase === 'error' && !fixed}>
            <svg width={charW} height={sm ? 12 : 24} viewBox="0 0 {RUNNER_W} {RUNNER_H}" shape-rendering="crispEdges" fill="currentColor" class="block">
              {#if phase === 'success' && !fixed}
                {#each cheer as p, i (i)}
                  <rect x={p.x} y={p.y} width={p.w} height="1" style={p.tone === 'eye' ? 'fill: var(--surface)' : undefined} opacity={p.tone === 'far' ? 0.55 : undefined} />
                {/each}
              {:else}
                {#each frames as frame, f (f)}
                  <g class="slg-frame" class:shown={f === 0} class:cycling={running} style="animation-delay: -{((frames.length - f) % frames.length) * 100}ms">
                    {#each frame as p, i (i)}
                      <rect x={p.x} y={p.y} width={p.w} height="1" style={p.tone === 'eye' ? 'fill: var(--surface)' : undefined} opacity={p.tone === 'far' ? 0.55 : undefined} />
                    {/each}
                  </g>
                {/each}
              {/if}
            </svg>
          </div>
        </div>
      {:else if kind === 'shuttle'}
        <div
          class="slg-actor absolute left-0 {tone} {sm ? 'bottom-0.5' : 'bottom-1.5'}"
          class:left={direction === 'left'}
          class:turn-left={running && lap > 0 && direction === 'left'}
          class:turn-right={running && lap > 0 && direction === 'right'}
          class:pulse={reduced && !still}
        >
          <div class="slg-fin shuttle" class:success={phase === 'success' && !fixed} class:error={phase === 'error' && !fixed}>
            <div class:slg-bob={!fixed}>
              <svg width={charW} height={sm ? 10 : 20} viewBox="-10 0 40 20" class="block overflow-visible" fill="currentColor">
                <path class="slg-flame" class:flicker={running} class:out={phase !== 'running'} d="M-1 8.2 L-9 10 L-1 11.8 Z" style="fill: var(--warning)" />
                <path d="M4 7 H19 Q26.5 7.2 29 10 Q26.5 12.8 19 13 H4 Q2 13 2 10 Q2 7 4 7 Z" />
                <path d="M4.5 7 L6.5 1.8 H9.6 L11.8 7 Z" opacity="0.8" />
                <path d="M8 13 H17 L12 18.4 H7.2 Z" opacity="0.8" />
                <rect x="-1" y="8.5" width="3.4" height="3" rx="0.6" opacity="0.7" />
                <path d="M20.5 8.4 Q24.4 8.6 26.3 10 H20.5 Z" style="fill: var(--surface)" />
              </svg>
            </div>
          </div>
        </div>
      {:else}
        <div class="slg-actor absolute left-0 {tone} {sm ? 'bottom-px' : 'bottom-1'}" class:pulse={reduced && !still}>
          <div class="slg-arc" class:sm class:arcing={!fixed} style="animation-duration: {duration}ms">
            <div class="slg-fin pebble relative" class:success={phase === 'success' && !fixed} class:error={phase === 'error' && !fixed}>
              {#if running}
                <svg class="slg-trail absolute top-0" class:left={direction === 'left'} width={charW * 1.8} height={charW} viewBox="0 0 18 10" fill="currentColor">
                  <circle cx="4" cy="5" r="1.6" opacity="0.18" />
                  <circle cx="9" cy="5" r="2.3" opacity="0.3" />
                  <circle cx="14.5" cy="5" r="3" opacity="0.45" />
                </svg>
              {/if}
              <svg width={charW} height={charW} viewBox="0 0 10 10" fill="currentColor" class="block overflow-visible">
                <path class="slg-stone" class:spinning={running} d="M3 1.2 L7.2 0.8 L9.4 4 L8.4 8.2 L4.4 9.4 L0.8 7 L0.9 3.2 Z" />
                {#if phase === 'success' && !fixed}
                  <g class="slg-burst" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
                    <path d="M5 -1.5 V-4.5 M5 11.5 V14.5 M-1.5 5 H-4.5 M11.5 5 H14.5 M0.4 0.4 L-1.8 -1.8 M9.6 0.4 L11.8 -1.8 M0.4 9.6 L-1.8 11.8 M9.6 9.6 L11.8 11.8" />
                  </g>
                {/if}
              </svg>
            </div>
          </div>
        </div>
      {/if}
    </div>
  {/key}
</div>

<style>
  /* One lap: the mover spans the usable track; translating it by its own width puts the character at the far end. */
  .slg-mover {
    animation-name: slg-move;
    animation-timing-function: linear;
    animation-fill-mode: both;
    will-change: transform;
  }
  .slg-mover.ease {
    animation-timing-function: cubic-bezier(0.45, 0.05, 0.55, 0.95);
  }
  .slg-mover.reverse {
    animation-direction: reverse;
  }
  /* Finished (or reduced motion): stay where the character is. */
  .slg-mover.still {
    animation-play-state: paused;
  }
  [data-motion='reduced'] .slg-mover,
  [data-motion='reduced'] .slg-band,
  [data-motion='reduced'] .slg-star,
  [data-motion='still'] .slg-mover,
  [data-motion='still'] .slg-band,
  [data-motion='still'] .slg-star {
    animation: none;
  }
  @keyframes slg-move {
    from {
      transform: translateX(0);
    }
    to {
      transform: translateX(100%);
    }
  }

  /* Finishing: everything stays where it was while the finish plays. */
  .slg-track.finishing .slg-arc,
  .slg-track.finishing .slg-bob {
    animation-play-state: paused;
  }

  .slg-actor.left {
    transform: scaleX(-1);
  }

  /* Runner: four pixel frames, one visible at a time (0.4 s per stride cycle). */
  .slg-frame {
    opacity: 0;
  }
  .slg-frame.shown {
    opacity: 1;
  }
  .slg-frame.cycling {
    animation: slg-frame 400ms step-end infinite;
  }
  @keyframes slg-frame {
    0% {
      opacity: 1;
    }
    25%,
    100% {
      opacity: 0;
    }
  }
  .slg-fin.runner {
    transform-origin: 50% 100%;
  }
  .slg-fin.runner.success {
    animation: slg-jump 360ms ease-out both;
  }
  @keyframes slg-jump {
    0% {
      transform: translateY(0) scaleY(0.9);
    }
    45% {
      transform: translateY(-9px) scaleY(1.05);
    }
    100% {
      transform: translateY(0) scaleY(1);
    }
  }
  .slg-fin.error {
    transform-origin: 50% 100%;
    animation: slg-stumble 360ms ease-in-out both;
  }
  @keyframes slg-stumble {
    0% {
      transform: rotate(0);
    }
    30% {
      transform: rotate(18deg) translateX(2px);
    }
    55% {
      transform: rotate(-9deg);
    }
    80% {
      transform: rotate(5deg);
    }
    100% {
      transform: rotate(0);
    }
  }

  /* Shuttle: flame flicker, a gentle bob, a banked turn at each edge, a soft landing. */
  .slg-flame {
    transform-box: fill-box;
    transform-origin: 100% 50%;
    transition: opacity 150ms;
  }
  .slg-flame.flicker {
    animation: slg-flicker 140ms ease-in-out infinite alternate;
  }
  .slg-flame.out {
    opacity: 0;
  }
  @keyframes slg-flicker {
    from {
      transform: scaleX(0.55);
      opacity: 0.75;
    }
    to {
      transform: scaleX(1.15);
      opacity: 1;
    }
  }
  .slg-bob {
    animation: slg-bob 900ms ease-in-out infinite alternate;
  }
  @keyframes slg-bob {
    from {
      transform: translateY(-1px);
    }
    to {
      transform: translateY(1.5px);
    }
  }
  .slg-actor.turn-left {
    animation: slg-turn-left 280ms ease-out both;
  }
  .slg-actor.turn-right {
    animation: slg-turn-right 280ms ease-out both;
  }
  @keyframes slg-turn-left {
    0% {
      transform: scaleX(1) rotate(-16deg);
    }
    50% {
      transform: scaleX(0.15) rotate(-10deg);
    }
    100% {
      transform: scaleX(-1) rotate(0);
    }
  }
  @keyframes slg-turn-right {
    0% {
      transform: scaleX(-1) rotate(-16deg);
    }
    50% {
      transform: scaleX(-0.15) rotate(-10deg);
    }
    100% {
      transform: scaleX(1) rotate(0);
    }
  }
  .slg-fin.shuttle.success {
    animation: slg-land 360ms ease-out both;
  }
  @keyframes slg-land {
    0% {
      transform: translateY(0);
    }
    60% {
      transform: translateY(5px);
    }
    80% {
      transform: translateY(3.5px);
    }
    100% {
      transform: translateY(4px);
    }
  }
  .slg-star {
    animation: slg-twinkle 1.6s ease-in-out infinite alternate;
  }
  @keyframes slg-twinkle {
    from {
      opacity: 0.15;
    }
    to {
      opacity: 0.7;
    }
  }

  /* Pebble: launched by the slingshot, arcs across with a trail, spins, bursts on the target when done. */
  .slg-band {
    transform-box: fill-box;
    transform-origin: 50% 0;
    animation: slg-snap 320ms ease-out both;
  }
  @keyframes slg-snap {
    0% {
      transform: scaleY(2.4);
    }
    40% {
      transform: scaleY(0.5);
    }
    100% {
      transform: scaleY(1);
    }
  }
  .slg-arc.arcing {
    animation-name: slg-arc;
    animation-fill-mode: both;
  }
  .slg-arc.arcing.sm {
    animation-name: slg-arc-sm;
  }
  @keyframes slg-arc {
    0% {
      transform: translateY(0);
      animation-timing-function: cubic-bezier(0.25, 0.6, 0.5, 1);
    }
    50% {
      transform: translateY(-22px);
      animation-timing-function: cubic-bezier(0.5, 0, 0.75, 0.4);
    }
    100% {
      transform: translateY(0);
    }
  }
  @keyframes slg-arc-sm {
    0% {
      transform: translateY(0);
      animation-timing-function: cubic-bezier(0.25, 0.6, 0.5, 1);
    }
    50% {
      transform: translateY(-9px);
      animation-timing-function: cubic-bezier(0.5, 0, 0.75, 0.4);
    }
    100% {
      transform: translateY(0);
    }
  }
  .slg-trail {
    right: 100%;
  }
  .slg-trail.left {
    right: auto;
    left: 100%;
    transform: scaleX(-1);
  }
  .slg-stone {
    transform-box: fill-box;
    transform-origin: 50% 50%;
  }
  .slg-stone.spinning {
    animation: slg-spin 600ms linear infinite;
  }
  @keyframes slg-spin {
    to {
      transform: rotate(360deg);
    }
  }
  .slg-fin.pebble.success .slg-stone {
    animation: slg-pop 300ms ease-in both;
  }
  @keyframes slg-pop {
    0% {
      transform: scale(1);
    }
    40% {
      transform: scale(1.35);
    }
    100% {
      transform: scale(0);
      opacity: 0;
    }
  }
  .slg-burst {
    transform-box: fill-box;
    transform-origin: 50% 50%;
    animation: slg-burst 340ms ease-out both;
  }
  @keyframes slg-burst {
    0% {
      transform: scale(0.4);
      opacity: 1;
    }
    100% {
      transform: scale(1.5);
      opacity: 0;
    }
  }

  /* The finish plays, then the whole strip fades; the response is already visible underneath. */
  .slg-track.finishing {
    animation: slg-fade 380ms ease-in both;
  }
  @keyframes slg-fade {
    0%,
    65% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  /* Reduced motion: a still character with a slow pulse. */
  .slg-actor.pulse {
    animation: slg-pulse 1.8s ease-in-out infinite alternate;
  }
  @keyframes slg-pulse {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.45;
    }
  }

  /* Window hidden: nothing moves. */
  .slg-track[data-paused] :global(*),
  .slg-track[data-paused] {
    animation-play-state: paused !important;
  }
</style>
