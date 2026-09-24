<script lang="ts">
  /**
   * Multi-line CodeMirror 6 editor used for request bodies, responses, snippets and docs.
   * Caret-safe: external value changes are applied as minimal diffs.
   */
  import { closeBrackets } from '@codemirror/autocomplete'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
  import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from '@codemirror/search'
  import { Compartment, EditorState, type Extension } from '@codemirror/state'
  import {
    drawSelection,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    keymap,
    lineNumbers as lineNumbersExt,
    placeholder as placeholderExt,
  } from '@codemirror/view'
  import { onMount } from 'svelte'
  import { scopeStore } from '../../app/scope.svelte'
  import type { TemplateScope } from '../../lib/template'
  import { languageExtension, type EditorLanguage } from './cm/languages'
  import { applyExternalValue } from './cm/sync'
  import { scopeChanged, templateExtension } from './cm/template'
  import { slingerTheme } from './cm/theme'

  interface Props {
    value: string
    onchange?: (value: string) => void
    language?: EditorLanguage
    readOnly?: boolean
    wrap?: boolean
    lineNumbers?: boolean
    fold?: boolean
    /** Highlight `{{variables}}` and offer autocomplete/hover. */
    templates?: boolean
    placeholder?: string
    label: string
    scope?: TemplateScope
    class?: string
    autoFocus?: boolean
  }
  let {
    value,
    onchange,
    language = 'text',
    readOnly = false,
    wrap = false,
    lineNumbers = true,
    fold = false,
    templates = false,
    placeholder = '',
    label,
    scope,
    class: cls = '',
    autoFocus = false,
  }: Props = $props()

  let host: HTMLDivElement
  let view: EditorView | undefined
  const langC = new Compartment()
  const wrapC = new Compartment()
  const roC = new Compartment()
  const currentScope = () => scope ?? scopeStore.scope

  function baseExtensions(): Extension[] {
    return [
      slingerTheme,
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      lineNumbers ? [lineNumbersExt(), highlightActiveLineGutter()] : [],
      fold ? foldGutter() : [],
      readOnly ? [] : closeBrackets(),
      templates ? templateExtension({ getScope: currentScope, onCreateVariable: (n) => scopeStore.createVariable?.(n) }) : [],
      placeholder ? placeholderExt(placeholder) : [],
      EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      keymap.of([...searchKeymap, ...foldKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const next = u.state.doc.toString()
          if (next !== value) onchange?.(next)
        }
      }),
      langC.of(languageExtension(language)),
      wrapC.of(wrap ? EditorView.lineWrapping : []),
      roC.of([EditorState.readOnly.of(readOnly)]),
    ]
  }

  onMount(() => {
    view = new EditorView({ parent: host, state: EditorState.create({ doc: value, extensions: baseExtensions() }) })
    if (autoFocus) view.focus()
    return () => {
      view?.destroy()
      view = undefined
    }
  })

  $effect(() => {
    const v = value
    if (view) applyExternalValue(view, v)
  })
  $effect(() => {
    const l = language
    view?.dispatch({ effects: langC.reconfigure(languageExtension(l)) })
  })
  $effect(() => {
    const w = wrap
    view?.dispatch({ effects: wrapC.reconfigure(w ? EditorView.lineWrapping : []) })
  })
  $effect(() => {
    const r = readOnly
    view?.dispatch({ effects: roC.reconfigure([EditorState.readOnly.of(r)]) })
  })
  $effect(() => {
    void (scope ?? scopeStore.scope)
    view?.dispatch({ effects: scopeChanged.of(null) })
  })

  export function openSearch() {
    if (view) {
      view.focus()
      openSearchPanel(view)
    }
  }
  export function focus() {
    view?.focus()
  }
  export function getView(): EditorView | undefined {
    return view
  }
</script>

<div bind:this={host} class="code-editor h-full min-h-0 overflow-hidden {cls}"></div>
