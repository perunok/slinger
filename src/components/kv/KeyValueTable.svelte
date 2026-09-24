<script lang="ts">
  /**
   * Editable key/value table shared by params, headers, form-data and urlencoded bodies.
   * Rows are keyed by stable ids so focus survives every state update; a blank row is always
   * kept at the end; a bulk-edit mode edits the same rows as text.
   */
  import { EditorView } from '@codemirror/view'
  import { api, errorInfo } from '../../lib/ipc'
  import { toast } from '../../app/toast.svelte'
  import {
    ensureTrailingEmpty,
    findDuplicateKeys,
    isDuplicate,
    isEmptyRow,
    parseBulk,
    removeRow,
    serializeBulk,
    updateRow,
    type KvRow,
  } from '../../lib/kv'
  import { suggestHeaderNames, suggestHeaderValues } from '../../lib/headers'
  import CodeEditor from '../editor/CodeEditor.svelte'
  import TemplateInput from '../editor/TemplateInput.svelte'
  import Button from '../ui/Button.svelte'
  import Icon from '../ui/Icon.svelte'
  import IconButton from '../ui/IconButton.svelte'

  interface Props {
    rows: KvRow[]
    onchange: (rows: KvRow[]) => void
    /** Noun used in accessible labels, e.g. "Header". */
    noun: string
    description?: boolean
    /** Allow rows to be text or file (form-data). */
    fileFields?: boolean
    suggestions?: 'headers' | 'none'
    duplicates?: 'none' | 'exact' | 'case-insensitive'
    keyPlaceholder?: string
    valuePlaceholder?: string
    /** Lets parents show read-only "auto" rows above the editable ones. */
    readonly?: boolean
  }
  let {
    rows,
    onchange,
    noun,
    description = true,
    fileFields = false,
    suggestions = 'none',
    duplicates = 'none',
    keyPlaceholder = 'Key',
    valuePlaceholder = 'Value',
    readonly = false,
  }: Props = $props()

  let bulk = $state(false)
  let bulkText = $state('')
  let tableEl = $state<HTMLElement>()

  const dupSet = $derived(duplicates === 'none' ? new Set<string>() : findDuplicateKeys(rows, duplicates === 'case-insensitive'))

  function emit(next: KvRow[]) {
    onchange(ensureTrailingEmpty(next))
  }
  function patch(id: string, p: Partial<KvRow>) {
    emit(updateRow(rows, id, p))
  }
  function remove(id: string) {
    onchange(removeRow(rows, id))
  }

  function toggleBulk() {
    if (!bulk) bulkText = serializeBulk(rows)
    bulk = !bulk
  }
  function onBulk(text: string) {
    bulkText = text
    onchange(parseBulk(text, rows))
  }

  function focusCell(col: 'key' | 'value', index: number) {
    const target = rows[index]
    if (!target || !tableEl) return
    const cm = tableEl.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(target.id)}"] [data-col="${col}"] .cm-editor`)
    const view = cm ? EditorView.findFromDOM(cm) : null
    if (!view) return
    view.focus()
    view.dispatch({ selection: { anchor: view.state.doc.length } })
  }

  const keySuggest = (t: string) => (suggestions === 'headers' ? suggestHeaderNames(t) : [])
  function valueSuggest(row: KvRow) {
    return (t: string) => (suggestions === 'headers' ? suggestHeaderValues(row.key, t) : [])
  }

  function basename(path: string): string {
    return path.split(/[\\/]/).pop() ?? path
  }

  async function chooseFile(row: KvRow) {
    try {
      const path = await api().pickFile({ title: `Choose a file for "${row.key || noun}"` })
      if (path) patch(row.id, { filePath: path, kind: 'file' })
    } catch (e) {
      toast.error('Could not open the file picker', errorInfo(e).message)
    }
  }
</script>

<div class="flex min-h-0 flex-col" data-testid="kv-table">
  <div class="flex items-center justify-end gap-1 px-1 pb-1">
    <Button size="sm" variant="ghost" icon={bulk ? 'list' : 'edit'} onclick={toggleBulk} aria-pressed={bulk}>
      {bulk ? 'Key-value edit' : 'Bulk edit'}
    </Button>
  </div>

  {#if bulk}
    <div class="h-48 overflow-hidden rounded border border-border">
      <CodeEditor
        value={bulkText}
        onchange={onBulk}
        label="{noun} bulk edit"
        lineNumbers={false}
        templates
        placeholder="key: value  (prefix a line with // to disable it)"
      />
    </div>
    <p class="mt-1 text-xs text-faint">One <code>key: value</code> per line. Lines starting with <code>//</code> or <code>#</code> are disabled.</p>
  {:else}
    <table bind:this={tableEl} class="w-full table-fixed border-collapse text-sm">
      <thead class="text-left text-xs text-faint">
        <tr>
          <th class="w-8 px-1 py-1 font-normal"><span class="sr-only">Enabled</span></th>
          <th class="px-1 py-1 font-normal">{keyPlaceholder}</th>
          {#if fileFields}<th class="w-20 px-1 py-1 font-normal">Type</th>{/if}
          <th class="px-1 py-1 font-normal">{valuePlaceholder}</th>
          {#if description}<th class="w-1/4 px-1 py-1 font-normal">Description</th>{/if}
          <th class="w-8 px-1 py-1 font-normal"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row, i (row.id)}
          {@const blank = isEmptyRow(row)}
          {@const dup = isDuplicate(row, dupSet, duplicates === 'case-insensitive')}
          <tr class="border-t border-border {row.enabled ? '' : 'opacity-60'}" data-row-id={row.id}>
            <td class="px-1 text-center">
              <input
                type="checkbox"
                checked={row.enabled}
                disabled={readonly}
                aria-label="{noun} {i + 1} enabled"
                onchange={(e) => patch(row.id, { enabled: e.currentTarget.checked })}
                class={blank ? 'invisible' : ''}
              />
            </td>
            <td class="px-1 py-0.5" data-col="key">
              <div class="flex items-center gap-1">
                <TemplateInput
                  class="flex-1 {dup ? '!border-warning' : ''}"
                  value={row.key}
                  label="{noun} {i + 1} key"
                  placeholder={keyPlaceholder}
                  suggest={keySuggest}
                  oninput={(v) => patch(row.id, { key: v })}
                  onenter={() => focusCell('key', i + 1)}
                  disabled={readonly}
                />
                {#if dup}
                  <span title="Duplicate {noun.toLowerCase()} name" class="text-warning"><Icon name="alert" size={13} /><span class="sr-only">Duplicate {noun.toLowerCase()} name</span></span>
                {/if}
              </div>
            </td>
            {#if fileFields}
              <td class="px-1">
                <select
                  class="w-full !px-1 text-xs"
                  aria-label="{noun} {i + 1} type"
                  value={row.kind}
                  disabled={readonly}
                  onchange={(e) => patch(row.id, { kind: e.currentTarget.value === 'file' ? 'file' : 'text' })}
                >
                  <option value="text">Text</option>
                  <option value="file">File</option>
                </select>
              </td>
            {/if}
            <td class="px-1 py-0.5" data-col="value">
              {#if fileFields && row.kind === 'file'}
                <div class="flex items-center gap-1">
                  <Button size="sm" icon="upload" onclick={() => chooseFile(row)} disabled={readonly}>{row.filePath ? 'Change' : 'Choose file'}</Button>
                  <span class="min-w-0 truncate text-xs text-muted" title={row.filePath}>{row.filePath ? basename(row.filePath) : 'No file selected'}</span>
                </div>
              {:else}
                <TemplateInput
                  class="w-full"
                  value={row.value}
                  label="{noun} {i + 1} value"
                  placeholder={valuePlaceholder}
                  suggest={valueSuggest(row)}
                  oninput={(v) => patch(row.id, { value: v })}
                  onenter={() => focusCell('value', i + 1)}
                  disabled={readonly}
                />
              {/if}
            </td>
            {#if description}
              <td class="px-1 py-0.5">
                <input
                  type="text"
                  class="w-full !border-transparent !bg-transparent focus:!border-accent"
                  aria-label="{noun} {i + 1} description"
                  placeholder="Description"
                  value={row.description}
                  disabled={readonly}
                  oninput={(e) => patch(row.id, { description: e.currentTarget.value })}
                />
              </td>
            {/if}
            <td class="px-1 text-center">
              {#if !blank && !readonly}
                <IconButton icon="trash" label="Remove {noun.toLowerCase()} {i + 1}" size={14} onclick={() => remove(row.id)} />
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
