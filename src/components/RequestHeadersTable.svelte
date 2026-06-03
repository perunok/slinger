<script lang="ts">
  import type { HeaderDocument } from '../lib/requestDocument'

  type EditableHeaderRow = HeaderDocument & {
    isNew?: boolean
  }

  export let headers: HeaderDocument[]
  export let setHeaders: (headers: HeaderDocument[]) => void

  let newHeader: HeaderDocument = { key: '', value: '' }

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value
  }

  function checkedValue(event: Event): boolean {
    return (event.currentTarget as HTMLInputElement).checked
  }

  function hasHeaderContent(header: HeaderDocument): boolean {
    return Boolean(header.key?.trim() || header.value?.trim())
  }

  function normalizedHeader(header: HeaderDocument): HeaderDocument {
    const next: HeaderDocument = {
      ...header,
      key: header.key ?? '',
      value: header.value ?? '',
    }

    if (next.disabled) {
      next.disabled = true
    } else {
      delete next.disabled
    }

    return next
  }

  function updateHeader(index: number, patch: HeaderDocument) {
    if (index === headers.length) {
      const nextHeader = normalizedHeader({ ...newHeader, ...patch })
      newHeader = nextHeader

      if (hasHeaderContent(nextHeader)) {
        setHeaders([...headers, nextHeader])
        newHeader = { key: '', value: '' }
      }

      return
    }

    setHeaders(
      headers.map((header, headerIndex) =>
        headerIndex === index ? normalizedHeader({ ...header, ...patch }) : header,
      ),
    )
  }

  function removeHeader(index: number) {
    setHeaders(headers.filter((_, headerIndex) => headerIndex !== index))
  }

  $: rows = [
    ...headers.map(normalizedHeader),
    {
      ...newHeader,
      key: newHeader.key ?? '',
      value: newHeader.value ?? '',
      isNew: true,
    },
  ] satisfies EditableHeaderRow[]
</script>

<div class="h-full overflow-auto">
  <div class="min-w-[640px] border-t border-[var(--border)] text-sm">
    <div class="grid grid-cols-[88px_minmax(180px,1fr)_minmax(240px,2fr)_44px] border-b border-[var(--border)] bg-[var(--surface)] text-xs font-semibold uppercase text-[var(--muted)]">
      <div class="px-3 py-2">Enabled</div>
      <div class="px-3 py-2">Key</div>
      <div class="px-3 py-2">Value</div>
      <div class="px-2 py-2" aria-hidden="true"></div>
    </div>

    {#each rows as row, index}
      <div class={`grid grid-cols-[88px_minmax(180px,1fr)_minmax(240px,2fr)_44px] border-b border-[var(--border)] ${row.disabled ? 'text-[var(--muted)]' : 'text-[var(--text)]'}`}>
        <label class="flex items-center px-3 py-1.5">
          <input
            type="checkbox"
            checked={!row.disabled}
            class="h-4 w-4 accent-[#3167d4]"
            aria-label={row.isNew ? 'Enable new header' : `Enable ${row.key || 'header'}`}
            on:change={(event) => updateHeader(index, { disabled: !checkedValue(event) })}
          />
        </label>
        <div class="px-1.5 py-1">
          <input
            value={row.key ?? ''}
            placeholder="Name"
            class="h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-sm outline-none placeholder:text-[var(--muted)] focus:border-[var(--input-border)] focus:bg-[var(--input)]"
            on:input={(event) => updateHeader(index, { key: inputValue(event) })}
          />
        </div>
        <div class="px-1.5 py-1">
          <input
            value={row.value ?? ''}
            placeholder="Value"
            class="h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-sm outline-none placeholder:text-[var(--muted)] focus:border-[var(--input-border)] focus:bg-[var(--input)]"
            on:input={(event) => updateHeader(index, { value: inputValue(event) })}
          />
        </div>
        <div class="flex items-center justify-center px-1 py-1">
          {#if !row.isNew}
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center rounded text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--text)]"
              aria-label={`Remove ${row.key || 'header'}`}
              title="Remove header"
              on:click={() => removeHeader(index)}
            >
              <span aria-hidden="true">x</span>
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
</div>
