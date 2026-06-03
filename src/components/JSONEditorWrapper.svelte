<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { createJSONEditor, type Content, type JsonEditor, Mode } from 'vanilla-jsoneditor'
  import BuiltinVariableMenu from './BuiltinVariableMenu.svelte'
  import {
    builtinVariableSuggestions,
    builtinVariableToken,
    isBuiltinVariable,
  } from '../lib/builtinVariables'
  import 'vanilla-jsoneditor/themes/jse-theme-dark.css'

  export let value: string
  export let isValidJson: boolean
  export let onChange: (value: string) => void
  export let className = ''

  let containerRef: HTMLDivElement
  let wrapperRef: HTMLDivElement
  let editorRef: JsonEditor | null = null
  let editorValue = ''
  const mode = Mode.text
  type TextInputTarget = HTMLInputElement | HTMLTextAreaElement
  type VariableMenuState = {
    query: string
    start: number
    end: number
    x: number
    y: number
    target: TextInputTarget | null
    textNode: Text | null
  }
  type HighlightRegistry = {
    set: (name: string, highlight: unknown) => void
    delete: (name: string) => void
  }
  type HighlightConstructor = new (...ranges: Range[]) => unknown

  const BUILTIN_HIGHLIGHT_NAME = 'slinger-builtin-variable'
  let variableMenu: VariableMenuState | null = null
  let selectedVariableIndex = 0

  function contentFromValue(nextValue: string): Content {
    if (isValidJson) {
      try {
        return { json: JSON.parse(nextValue) }
      } catch {
        return { text: nextValue }
      }
    }

    return { text: nextValue }
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

  function menuPosition(rect: DOMRect): { x: number; y: number } {
    const wrapperRect = wrapperRef.getBoundingClientRect()
    const width = 288
    const x = Math.max(8, Math.min(rect.left - wrapperRect.left, wrapperRect.width - width - 8))

    return {
      x,
      y: rect.bottom - wrapperRect.top + 6,
    }
  }

  function activeTextInput(): TextInputTarget | null {
    const activeElement = document.activeElement
    if (
      (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) &&
      containerRef.contains(activeElement)
    ) {
      return activeElement
    }

    return null
  }

  function customHighlightApi(): {
    registry: HighlightRegistry
    HighlightCtor: HighlightConstructor
  } | null {
    const css = CSS as typeof CSS & { highlights?: HighlightRegistry }
    const HighlightCtor = (window as typeof window & { Highlight?: HighlightConstructor }).Highlight

    if (!css.highlights || !HighlightCtor) return null

    return {
      registry: css.highlights,
      HighlightCtor,
    }
  }

  function textNodes(root: Node): Text[] {
    const nodes: Text[] = []
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()

    while (node) {
      nodes.push(node as Text)
      node = walker.nextNode()
    }

    return nodes
  }

  function refreshBuiltinHighlights() {
    const api = customHighlightApi()
    if (!api || !containerRef) return

    const ranges: Range[] = []

    for (const textNode of textNodes(containerRef)) {
      const text = textNode.textContent ?? ''

      for (const match of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
        if (!isBuiltinVariable(match[1])) continue

        const start = match.index ?? 0
        const range = document.createRange()
        range.setStart(textNode, start)
        range.setEnd(textNode, start + match[0].length)
        ranges.push(range)
      }
    }

    if (ranges.length > 0) {
      api.registry.set(BUILTIN_HIGHLIGHT_NAME, new api.HighlightCtor(...ranges))
    } else {
      api.registry.delete(BUILTIN_HIGHLIGHT_NAME)
    }
  }

  function scheduleBuiltinHighlightRefresh() {
    window.setTimeout(refreshBuiltinHighlights, 0)
  }

  function selectionIsInsideEditor(selection: Selection): boolean {
    const anchorNode = selection.anchorNode
    if (!anchorNode || !containerRef.contains(anchorNode)) return false

    const element = anchorNode.nodeType === Node.ELEMENT_NODE
      ? (anchorNode as Element)
      : anchorNode.parentElement

    return Boolean(element?.closest('[contenteditable="true"], .cm-content'))
  }

  function closeVariableMenu() {
    variableMenu = null
    selectedVariableIndex = 0
  }

  function updateVariableMenu() {
    const target = activeTextInput()

    if (target) {
      const caretIndex = target.selectionStart ?? target.value.length
      const match = variableMatch(target.value, caretIndex)
      if (!match || builtinVariableSuggestions(match.query).length === 0) {
        closeVariableMenu()
        return
      }

      variableMenu = {
        ...match,
        ...menuPosition(target.getBoundingClientRect()),
        target,
        textNode: null,
      }
      selectedVariableIndex = 0
      return
    }

    const selection = window.getSelection()
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0 || !selectionIsInsideEditor(selection)) {
      closeVariableMenu()
      return
    }

    const textNode = selection.anchorNode
    if (!(textNode instanceof Text)) {
      closeVariableMenu()
      return
    }

    const caretIndex = selection.anchorOffset
    const match = variableMatch(textNode.textContent ?? '', caretIndex)
    if (!match || builtinVariableSuggestions(match.query).length === 0) {
      closeVariableMenu()
      return
    }

    const range = selection.getRangeAt(0).cloneRange()
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    const fallbackRect = (textNode.parentElement ?? containerRef).getBoundingClientRect()

    variableMenu = {
      ...match,
      ...menuPosition(rect.width || rect.height ? rect : fallbackRect),
      target: null,
      textNode,
    }
    selectedVariableIndex = 0
  }

  function handleEditorInput() {
    window.setTimeout(updateVariableMenu, 0)
    scheduleBuiltinHighlightRefresh()
  }

  function handleEditorKeyup() {
    window.setTimeout(updateVariableMenu, 0)
    scheduleBuiltinHighlightRefresh()
  }

  function handleEditorClick() {
    window.setTimeout(updateVariableMenu, 0)
  }

  function handleEditorKeydown(event: KeyboardEvent) {
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
      insertBuiltinVariable(variableSuggestions[selectedVariableIndex]?.name ?? variableSuggestions[0].name)
    }
  }

  function insertBuiltinVariable(name: string) {
    if (!variableMenu) return

    const token = builtinVariableToken(name)

    if (variableMenu.target) {
      const target = variableMenu.target
      const nextValue = [
        target.value.slice(0, variableMenu.start),
        token,
        target.value.slice(variableMenu.end),
      ].join('')
      const caretIndex = variableMenu.start + token.length

      target.value = nextValue
      target.focus()
      target.setSelectionRange(caretIndex, caretIndex)
      target.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: token,
        inputType: 'insertText',
      }))
      closeVariableMenu()
      return
    }

    if (variableMenu.textNode) {
      const editableElement = variableMenu.textNode.parentElement?.closest('[contenteditable="true"], .cm-content') as HTMLElement | null
      const selection = window.getSelection()
      const range = document.createRange()

      editableElement?.focus()
      range.setStart(variableMenu.textNode, variableMenu.start)
      range.setEnd(variableMenu.textNode, variableMenu.end)
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.execCommand('insertText', false, token)
      closeVariableMenu()
    }
  }

  onMount(() => {
    editorValue = value
    editorRef = createJSONEditor({
      target: containerRef,
      props: {
        content: contentFromValue(editorValue),
        mode,
        mainMenuBar: true,
        navigationBar: true,
        statusBar: true,
        askToFormat: true,
        indentation: 2,
        onChange: (updatedContent) => {
          const nextValue = 'json' in updatedContent
            ? JSON.stringify(updatedContent.json, null, 2)
            : updatedContent.text
          if (nextValue !== editorValue) {
            editorValue = nextValue
            onChange(nextValue)
          }
        },
      },
    })
    containerRef.addEventListener('input', handleEditorInput, true)
    containerRef.addEventListener('keydown', handleEditorKeydown, true)
    containerRef.addEventListener('keyup', handleEditorKeyup, true)
    containerRef.addEventListener('click', handleEditorClick, true)
    scheduleBuiltinHighlightRefresh()
  })

  onDestroy(() => {
    containerRef?.removeEventListener('input', handleEditorInput, true)
    containerRef?.removeEventListener('keydown', handleEditorKeydown, true)
    containerRef?.removeEventListener('keyup', handleEditorKeyup, true)
    containerRef?.removeEventListener('click', handleEditorClick, true)
    customHighlightApi()?.registry.delete(BUILTIN_HIGHLIGHT_NAME)
    editorRef?.destroy()
    editorRef = null
  })

  $: if (editorRef && value !== editorValue) {
    editorValue = value
    editorRef.updateProps({ content: contentFromValue(editorValue), mode })
    scheduleBuiltinHighlightRefresh()
  }
  $: variableSuggestions = variableMenu ? builtinVariableSuggestions(variableMenu.query) : []
  $: if (selectedVariableIndex >= variableSuggestions.length) selectedVariableIndex = 0
</script>

<div bind:this={wrapperRef} class="relative h-full min-h-0">
  <div bind:this={containerRef} class={`json-editor-wrapper jse-theme-dark ${className}`} />
  {#if variableMenu && variableSuggestions.length > 0}
    <BuiltinVariableMenu
      suggestions={variableSuggestions}
      selectedIndex={selectedVariableIndex}
      selectVariable={insertBuiltinVariable}
      style={`position: absolute; left: ${variableMenu.x}px; top: ${variableMenu.y}px;`}
    />
  {/if}
</div>
