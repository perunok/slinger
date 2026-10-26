<script lang="ts">
  /**
   * Path variables of a request: one row per `:name` segment of the URL (the URL decides which rows exist, so keys are
   * not editable here); values (may hold `{{variables}}`) and descriptions are.
   */
  import TemplateInput from '../../components/editor/TemplateInput.svelte'
  import type { PathVariable } from '../../lib/pathVariables'

  interface Props {
    rows: PathVariable[]
    onchange: (rows: PathVariable[]) => void
  }
  let { rows, onchange }: Props = $props()

  function patch(key: string, p: Partial<PathVariable>) {
    onchange(rows.map((r) => (r.key === key ? { ...r, ...p } : r)))
  }
</script>

<table class="w-full table-fixed border-collapse text-sm" data-testid="path-variables">
  <thead class="text-left text-xs text-faint">
    <tr>
      <th class="w-8 px-1 py-1 font-normal"><span class="sr-only">Placeholder</span></th>
      <th class="px-1 py-1 font-normal">Key</th>
      <th class="px-1 py-1 font-normal">Value</th>
      <th class="w-1/4 px-1 py-1 font-normal">Description</th>
      <th class="w-8 px-1 py-1 font-normal"><span class="sr-only">Actions</span></th>
    </tr>
  </thead>
  <tbody>
    {#each rows as row (row.key)}
      <tr class="border-t border-border">
        <td></td>
        <td class="truncate px-1 py-0.5 font-mono text-xs text-muted" title=":{row.key}">{row.key}</td>
        <td class="px-1 py-0.5">
          <TemplateInput class="w-full" value={row.value} label="Path variable {row.key} value" placeholder="Value" oninput={(v) => patch(row.key, { value: v })} />
        </td>
        <td class="px-1 py-0.5">
          <input
            type="text"
            class="w-full border-transparent bg-transparent focus:border-accent"
            aria-label="Path variable {row.key} description"
            placeholder="Description"
            value={row.description}
            oninput={(e) => patch(row.key, { description: e.currentTarget.value })}
          />
        </td>
        <td></td>
      </tr>
    {/each}
  </tbody>
</table>
