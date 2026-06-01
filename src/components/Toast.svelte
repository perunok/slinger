<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte'

  export let message: string | null = null
  const dispatch = createEventDispatcher()
  let timeout: ReturnType<typeof setTimeout> | null = null

  $: if (message) {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => dispatch('dismiss'), 4000)
  }

  onDestroy(() => {
    if (timeout) clearTimeout(timeout)
  })
</script>

{#if message}
  <div class="toast-container" aria-live="polite" aria-atomic="true">
    <div class="toast-card">
      <div>{message}</div>
      <div class="toast-progress">
        <div class="toast-progress-bar"></div>
      </div>
    </div>
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: 1rem;
    right: 1rem;
    z-index: 50;
    max-width: 24rem;
    padding: 0.25rem;
    pointer-events: none;
  }

  .toast-card {
    pointer-events: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: rgba(15, 23, 42, 0.95);
    color: #f8fafc;
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 0.75rem;
    box-shadow: 0 20px 70px rgba(15, 23, 42, 0.25);
    padding: 1rem 1rem 0.8rem;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  .toast-progress {
    position: relative;
    height: 0.35rem;
    background: rgba(148, 163, 184, 0.15);
    border-radius: 9999px;
    overflow: hidden;
  }

  .toast-progress-bar {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, #38bdf8 0%, #22d3ee 100%);
    border-radius: inherit;
    animation: toast-progress 4s linear forwards;
  }

  @keyframes toast-progress {
    from {
      width: 100%;
    }
    to {
      width: 0%;
    }
  }
</style>
