/**
 * CodeMirror extension implementing `{{variable}}` behaviour: token highlighting
 * (green resolved / red unresolved / grey secret), hover popover with the resolved
 * value + source environment, autocomplete on `{{`, and a "create variable" action.
 * Shared by TemplateInput (single-line) and CodeEditor (multi-line) so both behave identically.
 */
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { RangeSetBuilder, StateEffect, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, hoverTooltip, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import {
  BUILTIN_VARIABLES,
  parseTokens,
  previewValue,
  tokenStatus,
  type TemplateScope,
  type TokenStatus,
} from '../../../lib/template'

/** Dispatch this effect after the scope changed so decorations are rebuilt. */
export const scopeChanged = StateEffect.define<null>()

export interface TemplateHooks {
  getScope: () => TemplateScope
  /** Called from the hover popover for unresolved tokens. */
  onCreateVariable?: (name: string) => void
  /** Optional plain-text suggestions for the whole field value (e.g. header names). */
  suggest?: (text: string) => string[]
}

const CLASS: Record<TokenStatus, string> = {
  resolved: 'cm-tpl cm-tpl-resolved',
  builtin: 'cm-tpl cm-tpl-builtin',
  unresolved: 'cm-tpl cm-tpl-unresolved',
  secret: 'cm-tpl cm-tpl-secret',
}

function buildDecorations(view: EditorView, hooks: TemplateHooks): DecorationSet {
  const scope = hooks.getScope()
  const b = new RangeSetBuilder<Decoration>()
  const text = view.state.doc.toString()
  for (const tok of parseTokens(text)) {
    b.add(tok.from, tok.to, Decoration.mark({ class: CLASS[tokenStatus(tok.name, scope)] }))
  }
  return b.finish()
}

function highlighter(hooks: TemplateHooks) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, hooks)
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(scopeChanged)))) {
          this.decorations = buildDecorations(u.view, hooks)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )
}

// ---------------------------------------------------------------------------
// Hover popover
// ---------------------------------------------------------------------------

export function popoverFor(name: string, hooks: TemplateHooks): HTMLElement {
  const scope = hooks.getScope()
  const status = tokenStatus(name, scope)
  const dom = document.createElement('div')
  dom.className = 'tpl-pop'
  dom.setAttribute('data-testid', 'template-popover')
  const title = document.createElement('div')
  title.className = 'tpl-pop-title'
  title.textContent = name
  dom.append(title)
  const value = previewValue(name, scope)
  const row = document.createElement('div')
  row.className = 'tpl-pop-row'
  if (status === 'unresolved') {
    row.textContent = scope.environmentName
      ? `Not defined in "${scope.environmentName}".`
      : 'No environment selected.'
    row.classList.add('tpl-pop-bad')
    dom.append(row)
    if (hooks.onCreateVariable) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'tpl-pop-btn'
      btn.textContent = `Create variable "${name}"`
      btn.addEventListener('mousedown', (e) => e.preventDefault())
      btn.addEventListener('click', () => hooks.onCreateVariable?.(name))
      dom.append(btn)
    }
  } else {
    row.textContent = value ?? ''
    row.classList.add('tpl-pop-value')
    if (status === 'secret') row.setAttribute('data-secret', 'true')
    dom.append(row)
    const src = document.createElement('div')
    src.className = 'tpl-pop-src'
    src.textContent =
      status === 'builtin' ? 'Built-in dynamic variable' : `${status === 'secret' ? 'Secret · ' : ''}Environment: ${scope.environmentName ?? '—'}`
    dom.append(src)
  }
  return dom
}

function hover(hooks: TemplateHooks) {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos)
      for (const tok of parseTokens(line.text)) {
        const from = line.from + tok.from
        const to = line.from + tok.to
        if (pos >= from && pos <= to) {
          return { pos: from, end: to, above: true, create: () => ({ dom: popoverFor(tok.name, hooks) }) }
        }
      }
      return null
    },
    { hoverTime: 250 },
  )
}

// ---------------------------------------------------------------------------
// Autocomplete
// ---------------------------------------------------------------------------

export function templateCompletionSource(hooks: TemplateHooks) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\{\{\s*[\w$.\-]*/)
    if (!m) return null
    const typed = /[\w$.\-]*$/.exec(m.text)?.[0] ?? ''
    const from = m.to - typed.length
    const scope = hooks.getScope()
    const options: Completion[] = []
    for (const v of scope.variables.values()) {
      options.push({
        label: v.key,
        type: 'variable',
        detail: v.secret ? 'secret' : (v.value ?? '').slice(0, 30),
        info: scope.environmentName ? `Environment: ${scope.environmentName}` : undefined,
        boost: 2,
        apply: applyToken,
      })
    }
    for (const b of BUILTIN_VARIABLES) {
      options.push({ label: b.name, type: 'function', detail: b.description, boost: -1, apply: applyToken })
    }
    return { from, options, validFor: /^[\w$.\-]*$/ }
  }
}

/** Inserts `name}}` (absorbing an already-present closing pair) and moves the caret after it. */
function applyToken(view: EditorView, completion: Completion, from: number, to: number) {
  const end = view.state.doc.sliceString(to, to + 2) === '}}' ? to + 2 : to
  view.dispatch({
    changes: { from, to: end, insert: completion.label + '}}' },
    selection: { anchor: from + completion.label.length + 2 },
    userEvent: 'input.complete',
  })
}

function suggestionSource(hooks: TemplateHooks) {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!hooks.suggest) return null
    const doc = ctx.state.doc.toString()
    if (doc.includes('{{')) return null // template completion owns this case
    if (!ctx.explicit && doc.length === 0) return null
    const options = hooks.suggest(doc)
    if (options.length === 0) return null
    return {
      from: 0,
      to: doc.length,
      filter: false,
      options: options.map((label) => ({ label, type: 'text' })),
    }
  }
}

export function templateExtension(hooks: TemplateHooks): Extension {
  return [
    highlighter(hooks),
    hover(hooks),
    autocompletion({ override: [templateCompletionSource(hooks), suggestionSource(hooks)], icons: false, activateOnTyping: true, closeOnBlur: true }),
  ]
}
