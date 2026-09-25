<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import Icon from './Icon.svelte'

  interface Props extends HTMLButtonAttributes {
    variant?: 'default' | 'primary' | 'danger' | 'ghost'
    size?: 'sm' | 'md'
    loading?: boolean
    icon?: string
    children?: Snippet
  }
  let { variant = 'default', size = 'md', loading = false, icon, children, class: cls = '', disabled, type = 'button', ...rest }: Props = $props()

  const variants = {
    default: 'bg-raised text-fg border-border hover:bg-hover',
    primary: 'bg-accent text-accent-fg border-transparent hover:brightness-110 font-medium',
    danger: 'bg-danger text-danger-fg border-transparent hover:brightness-110 font-medium',
    ghost: 'bg-transparent text-fg border-transparent hover:bg-hover',
  }
  const sizes = { sm: 'h-6 px-2 text-xs gap-1', md: 'h-8 px-3 gap-1.5' }
</script>

<button
  {type}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  class="inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded border transition-colors disabled:cursor-not-allowed disabled:opacity-50 {variants[variant]} {sizes[size]} {cls}"
  {...rest}
>
  {#if loading}
    <span class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true"></span>
  {:else if icon}
    <Icon name={icon} size={size === 'sm' ? 13 : 15} />
  {/if}
  {@render children?.()}
</button>
