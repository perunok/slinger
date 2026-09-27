<script lang="ts">
  /**
   * Non-blocking heads-up shown above a request (or example) editor whose serialized document is over cloud
   * sync's per-request cap (electron/sync/mapping.ts `LIMITS.documentJsonBytes`, shared/syncLimits.ts). Saved
   * examples live inside the same document, so a request with large ones can cross the cap invisibly; without
   * this, the first sign is the item silently quarantined as "Rejected by the cloud" (ConflictCard) after the
   * next sync. Only shown for a workspace linked to cloud sync.
   */
  import { app } from '../../app/state.svelte'
  import Icon from '../../components/ui/Icon.svelte'
  import { locateExample, readExamples, serializeExample, syncSizeWarning, updateExamples } from '../../lib/examples'
  import { serializeDraft } from '../../lib/request'
  import type { RequestTab } from '../requests/tabs.svelte'
  import { sync } from './syncStore.svelte'

  let { tab }: { tab: RequestTab } = $props()

  /** The document that would be saved right now: the whole request, or (for an example tab) that edit projected into the parent's. */
  function projectedDocumentJson(): string | null {
    if (!tab.example) return serializeDraft(tab.draft).documentJson
    const parent = app.requestById(tab.requestId)
    if (!parent || !tab.exampleDraft) return null
    const ex = tab.example
    const serialized = serializeExample(ex.original, ex.baseline, { response: tab.exampleDraft, request: tab.draft })
    const list = readExamples(parent.documentJson)
    const found = locateExample(list, ex)
    const index = found ? found.index : list.length
    return updateExamples(parent.documentJson, (l) => {
      const next = [...l]
      next[index] = serialized
      return next
    })
  }

  const warning = $derived.by(() => {
    if (!sync.current?.linked) return null
    const doc = projectedDocumentJson()
    return doc ? syncSizeWarning(doc) : null
  })
</script>

{#if warning}
  <p role="status" data-testid="sync-size-warning" class="flex items-center gap-1.5 border-b border-warning bg-warning-soft px-3 py-1.5 text-xs text-fg">
    <span class="shrink-0 text-warning"><Icon name="alert" size={14} /></span>
    <span class="min-w-0 flex-1">{warning}</span>
  </p>
{/if}
