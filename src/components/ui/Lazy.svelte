<script lang="ts" generics="P extends Record<string, unknown>">
  /**
   * Renders a component that is loaded on first use (a separate chunk), so rarely opened views and dialogs do not
   * weigh on startup. `load` is the `() => import('...')` of the component; the import is cached by the browser.
   */
  import type { Component } from 'svelte'

  interface Props {
    load: () => Promise<{ default: Component<P> }>
    props?: P
  }
  let { load, props = {} as P }: Props = $props()
  const loaded = $derived(load())
</script>

{#await loaded then mod}
  <mod.default {...props} />
{:catch err}
  <p role="alert" class="m-4 text-sm text-danger">Could not load this view: {err instanceof Error ? err.message : String(err)}</p>
{/await}
