<script lang="ts">
  /**
   * Release notes from the bundled CHANGELOG.md (works offline), rendered by the docs Markdown renderer (marked +
   * DOMPurify). `all`: every released version (Help > Release Notes, Ctrl+K, About). `new`: What's new after an
   * update, the versions since the last one this installation ran, with "All release notes" to see the rest.
   */
  import Button from '../../components/ui/Button.svelte'
  import Dialog from '../../components/ui/Dialog.svelte'
  import MarkdownView from '../../components/markdown/MarkdownView.svelte'
  import { entriesSince, entriesToMarkdown, releasedEntries } from '../../lib/releaseNotes'
  import { CHANGELOG } from './changelog'

  interface Props {
    view: { mode: 'all' } | { mode: 'new'; after: string | null; current: string }
    onclose: () => void
    /** Switches a What's new view to every release. */
    onshowall: () => void
  }
  let { view, onclose, onshowall }: Props = $props()

  const entries = $derived(view.mode === 'new' ? entriesSince(CHANGELOG, view.after, view.current) : releasedEntries(CHANGELOG))
  const title = $derived(view.mode === 'new' ? `What’s new in Slinger ${view.current}` : 'Release notes')
</script>

<Dialog {title} {onclose} size="lg">
  <div data-testid="release-notes" data-mode={view.mode}>
    {#if entries.length > 0}
      <MarkdownView source={entriesToMarkdown(entries)} label="Release notes" />
    {:else}
      <p class="text-sm text-muted">No release notes for this version.</p>
    {/if}
  </div>

  {#snippet footer()}
    {#if view.mode === 'new'}
      <Button onclick={onshowall}>All release notes</Button>
    {/if}
    <Button variant="primary" onclick={onclose} data-autofocus>Close</Button>
  {/snippet}
</Dialog>
