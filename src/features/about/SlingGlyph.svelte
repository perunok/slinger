<script lang="ts">
  /**
   * Small original drawings for the manifesto: `sling` (two cords and a pouch holding a stone) as the section
   * ornament, `stone` (a pebble carrying the principle's number) per item. Theme tokens only.
   */
  interface Props {
    kind: 'sling' | 'stone'
    /** Number drawn on the stone. */
    n?: number
    size?: number
    class?: string
  }
  let { kind, n, size = 28, class: cls = '' }: Props = $props()
</script>

{#if kind === 'sling'}
  <svg class={cls} width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
    <g stroke="var(--accent-text)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="5" cy="4.5" r="1.6" />
      <circle cx="27" cy="4.5" r="1.6" />
      <path d="M6 6c1.5 6 4.5 11 7.5 15" />
      <path d="M26 6c-1.5 6-4.5 11-7.5 15" />
      <path d="M11.5 20.5c1.2 4.2 7.8 4.2 9 0" />
    </g>
    <path d="M16 18.3c2.4 0 3.6 1.4 3.4 3-.2 1.7-1.8 2.6-3.6 2.6-1.9 0-3.3-1.1-3.2-2.8.1-1.6 1.3-2.8 3.4-2.8z" fill="var(--accent)" />
    <path d="M3 29c3-1.2 6-1.2 9 0M20 29c3-1.2 6-1.2 9 0" stroke="var(--border-strong)" stroke-width="1.2" stroke-linecap="round" />
  </svg>
{:else}
  <svg class={cls} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <path
      d="M5 17.5C4.3 10.8 9.6 5 16.4 5 23 5 28 9.5 27.5 16.3 27 23 22.2 27.5 15.6 27.3 9.4 27.1 5.6 23.4 5 17.5z"
      fill="var(--accent-soft)"
      stroke="var(--accent)"
      stroke-width="1.5"
    />
    <path d="M10 11.5c1.3-1.7 3.2-2.7 5.4-2.9" fill="none" stroke="var(--surface)" stroke-width="1.4" stroke-linecap="round" opacity="0.7" />
    {#if n !== undefined}
      <text x="16.3" y="21" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)" font-family="var(--font-mono)">{n}</text>
    {/if}
  </svg>
{/if}
