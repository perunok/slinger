<script lang="ts">
  /** Request documentation (Postman `description`, Markdown), rendered by default; see components/markdown. */
  import DocsEditor from '../../components/markdown/DocsEditor.svelte'
  import { readDescription } from '../../lib/description'
  import ReadOnlyNote from '../sync/ReadOnlyNote.svelte'
  import { sync } from '../sync/syncStore.svelte'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()
  const format = $derived(readDescription(tab.draft.descriptionSource).format)
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if sync.blocked}<ReadOnlyNote class="mx-3 mt-2" />{/if}
  <DocsEditor
    value={tab.draft.description}
    onchange={(v) => (tab.draft.description = v)}
    {format}
    readOnly={sync.blocked}
    readOnlyReason={sync.blockedMessage}
    mode={tab.docsMode}
    onmodechange={(m) => (tab.docsMode = m)}
    label="Request documentation"
    idPrefix="req-{tab.id}"
    hint="Saved with the request · exported to Postman as its description"
    class="min-h-0 flex-1"
  />
</div>
