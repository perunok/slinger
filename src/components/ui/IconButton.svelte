<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import Icon from './Icon.svelte'

  interface Props extends HTMLButtonAttributes {
    icon: string
    /** Accessible name (required: icon-only buttons have no text). */
    label: string
    size?: number
    active?: boolean
  }
  let { icon, label, size = 15, active = false, class: cls = '', type = 'button', ...rest }: Props = $props()
</script>

<button
  {type}
  aria-label={label}
  title={label}
  aria-pressed={active ? true : undefined}
  class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 {active ? 'bg-accent-soft text-fg' : ''} {cls}"
  {...rest}
>
  <Icon name={icon} {size} />
</button>
