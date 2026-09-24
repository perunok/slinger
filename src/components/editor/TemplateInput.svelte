<script lang="ts">
  /**
   * Single-line input with `{{variable}}` awareness. Implemented as a one-line CodeMirror
   * editor using the same extension as multi-line editors, so highlighting, hover popover
   * and autocomplete behave identically everywhere.
   */
  import { completionStatus } from '@codemirror/autocomplete'
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
  import { Compartment, EditorState, type Extension } from '@codemirror/state'
  import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view'
  import { onMount } from 'svelte'
  import { scopeStore } from '../../app/scope.svelte'
  import type { TemplateScope } from '../../lib/template'
  import { slingerTheme } from './cm/theme'
  import { scopeChanged, templateExtension } from './cm/template'
  import { applyExternalValue } from './cm/sync'

  interface Props {
    value: string
    oninput?: (value: string) => void
    /** Accessible name (there is no visible <label> for cells inside tables). */
    label: string
    placeholder?: string
    /** Override the global scope (tests, previews). */
    scope?: TemplateScope
    mono?: boolean
    disabled?: boolean
    class?: string
    id?: string
    /** Enter pressed (and no completion accepted). */
    onenter?: () => void
    /** Called when the field receives focus (used by tables to track the active row). */
    onfocus?: () => void
    onblur?: () => void
    /** Backspace on an empty field. */
    onbackspaceempty?: () => void
    /** Mask the text (secret-like inputs); tokens are still highlighted. */
    masked?: boolean
    /** Plain-text suggestions for the whole value (header names, content types). */
    suggest?: (text: string) => string[]
  }
  let {
    value,
    oninput,
    label,
    placeholder = '',
    scope,
    mono = false,
    disabled = false,
    class: cls = '',
    id,
    onenter,
    onfocus,
    onblur,
    onbackspaceempty,
    masked = false,
    suggest,
  }: Props = $props()

  let host: HTMLDivElement
  let view: EditorView | undefined
  const editable = new Compartment()
  const currentScope = () => scope ?? scopeStore.scope

  const singleLine = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr
    let multi = false
    tr.changes.iterChanges((_f, _t, _a, _b, ins) => {
      if (ins.lines > 1) multi = true
    })
    if (!multi) return tr
    // Pasted newlines become nothing so the value stays one line.
    const changes: { from: number; to: number; insert: string }[] = []
    tr.changes.iterChanges((from, to, _a, _b, ins) => {
      changes.push({ from, to, insert: ins.toString().replace(/[\r\n]+/g, '') })
    })
    return { changes, scrollIntoView: true }
  })

  function extensions(): Extension[] {
    return [
      singleLine,
      slingerTheme,
      templateExtension({ getScope: currentScope, onCreateVariable: (n) => scopeStore.createVariable?.(n), suggest: (t) => suggest?.(t) ?? [] }),
      placeholderExt(placeholder),
      EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'false', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
      EditorView.theme({
        '&': { height: 'auto' },
        '.cm-scroller': { overflow: 'hidden', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', lineHeight: '1.6' },
        '.cm-content': { padding: '0' },
        '.cm-line': { padding: '0 2px' },
      }),
      keymap.of([
        {
          key: 'Enter',
          run: () => {
            if (!onenter) return false
            onenter()
            return true
          },
        },
        {
          key: 'Escape',
          run: (v) => {
            if (completionStatus(v.state)) return false // let the popup close first
            if (v.dom.closest('[role="dialog"]')) return false // Escape closes the dialog instead
            v.contentDOM.blur()
            return true
          },
        },
        {
          key: 'Backspace',
          run: (v) => {
            if (onbackspaceempty && v.state.doc.length === 0) {
              onbackspaceempty()
              return true
            }
            return false
          },
        },
      ]),
      history(),
      // Mod-Enter is the app-wide Send shortcut; Enter is handled above.
      keymap.of([...historyKeymap, ...defaultKeymap.filter((k) => k.key !== 'Mod-Enter' && k.key !== 'Enter' && k.key !== 'Mod-/')]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          const next = u.state.doc.toString()
          if (next !== value) oninput?.(next)
        }
        if (u.focusChanged) (u.view.hasFocus ? onfocus : onblur)?.()
      }),
      editable.of(EditorView.editable.of(!disabled)),
    ]
  }

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, extensions: extensions() }),
    })
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
    void (scope ?? scopeStore.scope)
    view?.dispatch({ effects: scopeChanged.of(null) })
  })
  $effect(() => {
    const d = disabled
    view?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!d)) })
  })

  /** Move keyboard focus into the field (used by tables). */
  export function focus(pos?: 'end' | 'start') {
    if (!view) return
    view.focus()
    if (pos) view.dispatch({ selection: { anchor: pos === 'end' ? view.state.doc.length : 0 } })
  }
</script>

<div
  bind:this={host}
  {id}
  data-template-input
  class="template-input min-w-0 rounded border border-transparent px-1 focus-within:border-accent {masked ? 'is-masked' : ''} {disabled ? 'opacity-50' : ''} {cls}"
></div>
