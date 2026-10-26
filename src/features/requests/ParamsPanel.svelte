<script lang="ts">
  import KeyValueTable from '../../components/kv/KeyValueTable.svelte'
  import InfoTip from '../../components/ui/InfoTip.svelte'
  import type { KvRow } from '../../lib/kv'
  import type { PathVariable } from '../../lib/pathVariables'
  import { buildUrlFromParams } from '../../lib/urlParams'
  import PathVariablesTable from './PathVariablesTable.svelte'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()

  function onchange(rows: KvRow[]) {
    tab.draft.params = rows
    tab.draft.url = buildUrlFromParams(tab.draft.url, rows)
  }
  function onpathchange(rows: PathVariable[]) {
    tab.draft.pathVariables = rows
  }
</script>

<div class="p-3">
  <p class="mb-2 text-xs text-faint">Query parameters. Enabled rows are kept in sync with the URL; disabled rows are stored but not sent.</p>
  <KeyValueTable rows={tab.draft.params} {onchange} noun="Param" keyPlaceholder="Parameter" />
  {#if tab.draft.pathVariables.length > 0}
    <div class="mt-4 mb-1 flex items-center gap-1">
      <h3 class="text-xs font-semibold text-muted">Path Variables</h3>
      <InfoTip label="About path variables">
        A path segment written <code>:name</code> in the URL (as in <code>/pets/:petId</code>) is a path variable: it is
        replaced by its value, URL-encoded, when the request is sent. Add or remove <code>:name</code> in the URL to add or
        remove a row. Values can use <code>{'{{variables}}'}</code>; a variable without a value is sent as written, with a
        warning.
      </InfoTip>
    </div>
    <PathVariablesTable rows={tab.draft.pathVariables} onchange={onpathchange} />
  {/if}
</div>
