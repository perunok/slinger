<script lang="ts">
  import KeyValueTable from '../../components/kv/KeyValueTable.svelte'
  import type { KvRow } from '../../lib/kv'
  import { buildUrlFromParams } from '../../lib/urlParams'
  import type { RequestTab } from './tabs.svelte'

  let { tab }: { tab: RequestTab } = $props()

  function onchange(rows: KvRow[]) {
    tab.draft.params = rows
    tab.draft.url = buildUrlFromParams(tab.draft.url, rows)
  }
</script>

<div class="p-3">
  <p class="mb-2 text-xs text-faint">Query parameters. Enabled rows are kept in sync with the URL; disabled rows are stored but not sent.</p>
  <KeyValueTable rows={tab.draft.params} {onchange} noun="Param" keyPlaceholder="Parameter" />
</div>
