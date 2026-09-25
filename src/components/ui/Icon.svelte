<script lang="ts">
  import { ICONS } from './icons'
  interface Props {
    name: string
    size?: number
    class?: string
  }
  let { name, size = 16, class: cls = '' }: Props = $props()
</script>

<svg
  class={cls}
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  <path d={ICONS[name] ?? ICONS.info} />
</svg>
