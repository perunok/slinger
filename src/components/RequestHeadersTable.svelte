<script lang="ts">
  import { tick } from 'svelte'
  import BuiltinVariableMenu from './BuiltinVariableMenu.svelte'
  import {
    builtinVariableSuggestions,
    builtinVariableToken,
    isBuiltinVariable,
  } from '../lib/builtinVariables'
  import type { HeaderDocument } from '../lib/requestDocument'

  type EditableHeaderRow = HeaderDocument & {
    isNew?: boolean
  }
  type HeaderValuePart = {
    text: string
    builtin: boolean
  }

  export let headers: HeaderDocument[]
  export let setHeaders: (headers: HeaderDocument[]) => void

  let newHeader: HeaderDocument = { key: '', value: '' }
  let activeValueInput: HTMLInputElement | null = null
  let variableMenu: {
    index: number
    query: string
    start: number
    end: number
  } | null = null
  let selectedVariableIndex = 0

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

  function variableMatch(value: string, caretIndex: number): { query: string; start: number; end: number } | null {
    const beforeCaret = value.slice(0, caretIndex)
    const match = beforeCaret.match(/\{\{\s*([\w.-]*)$/)
    if (!match) return null

    return {
      query: match[1] ?? '',
      start: caretIndex - match[0].length,
      end: caretIndex,
    }
  }

  function headerValueParts(value: string): HeaderValuePart[] {
    const parts: HeaderValuePart[] = []
    let lastIndex = 0

    for (const match of value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      const index = match.index ?? 0
      if (index > lastIndex) {
        parts.push({ text: value.slice(lastIndex, index), builtin: false })
      }

      parts.push({
        text: match[0],
        builtin: isBuiltinVariable(match[1]),
      })
      lastIndex = index + match[0].length
    }

    if (lastIndex < value.length) {
      parts.push({ text: value.slice(lastIndex), builtin: false })
    }

    return parts.length > 0 ? parts : [{ text: value, builtin: false }]
  }

  function updateVariableMenu(input: HTMLInputElement, index: number) {
    activeValueInput = input
    const caretIndex = input.selectionStart ?? input.value.length
    const match = variableMatch(input.value, caretIndex)

    if (!match || builtinVariableSuggestions(match.query).length === 0) {
      variableMenu = null
      selectedVariableIndex = 0
      return
    }

    variableMenu = {
      index,
      ...match,
    }
    selectedVariableIndex = 0
  }

  function handleValueInput(event: Event, index: number) {
    const input = event.currentTarget as HTMLInputElement
    updateHeader(index, { value: input.value })
    updateVariableMenu(input, index)
  }

  function handleValueFocus(event: FocusEvent, index: number) {
    updateVariableMenu(event.currentTarget as HTMLInputElement, index)
  }

  function handleValueCursorChange(event: Event, index: number) {
    updateVariableMenu(event.currentTarget as HTMLInputElement, index)
  }

  function closeVariableMenu() {
    variableMenu = null
    selectedVariableIndex = 0
  }

  async function insertBuiltinVariable(name: string) {
    if (!variableMenu || !activeValueInput) return

    const token = builtinVariableToken(name)
    const nextValue = [
      activeValueInput.value.slice(0, variableMenu.start),
      token,
      activeValueInput.value.slice(variableMenu.end),
    ].join('')
    const caretIndex = variableMenu.start + token.length

    updateHeader(variableMenu.index, { value: nextValue })
    closeVariableMenu()
    await tick()
    activeValueInput.focus()
    activeValueInput.setSelectionRange(caretIndex, caretIndex)
  }

  function handleValueKeydown(event: KeyboardEvent) {
    if (!variableMenu || variableSuggestions.length === 0) return

    if (event.key === 'Escape') {
      event.preventDefault()
      closeVariableMenu()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selectedVariableIndex = (selectedVariableIndex + 1) % variableSuggestions.length
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      selectedVariableIndex =
        (selectedVariableIndex - 1 + variableSuggestions.length) % variableSuggestions.length
      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      void insertBuiltinVariable(variableSuggestions[selectedVariableIndex]?.name ?? variableSuggestions[0].name)
    }
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
  $: variableSuggestions = variableMenu ? builtinVariableSuggestions(variableMenu.query) : []
  $: if (selectedVariableIndex >= variableSuggestions.length) selectedVariableIndex = 0
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
        <div class="relative px-1.5 py-1">
          {#if row.value}
            <div class="pointer-events-none absolute inset-x-1.5 top-1 h-8 overflow-hidden rounded px-2 font-mono text-sm leading-8 whitespace-pre text-[var(--text)]">
              {#each headerValueParts(row.value ?? '') as part, partIndex (`${index}-${partIndex}-${part.text}`)}
                <span style={part.builtin ? 'color: var(--variable-builtin);' : ''}>{part.text}</span>
              {/each}
            </div>
          {/if}
          <input
            value={row.value ?? ''}
            placeholder="Value"
            class={`relative h-8 w-full rounded border border-transparent bg-transparent px-2 font-mono text-sm outline-none placeholder:text-[var(--muted)] focus:border-[var(--input-border)] ${row.value ? 'text-transparent caret-[var(--text)]' : 'text-[var(--text)] focus:bg-[var(--input)]'}`}
            on:input={(event) => handleValueInput(event, index)}
            on:focus={(event) => handleValueFocus(event, index)}
            on:click={(event) => handleValueCursorChange(event, index)}
            on:keyup={(event) => handleValueCursorChange(event, index)}
            on:keydown={handleValueKeydown}
            on:blur={() => window.setTimeout(closeVariableMenu, 120)}
          />
          {#if variableMenu?.index === index && variableSuggestions.length > 0}
            <div class="absolute left-1.5 top-[calc(100%-0.125rem)]">
              <BuiltinVariableMenu
                suggestions={variableSuggestions}
                selectedIndex={selectedVariableIndex}
                selectVariable={(name) => void insertBuiltinVariable(name)}
              />
            </div>
          {/if}
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
