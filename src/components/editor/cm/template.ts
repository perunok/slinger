/**
 * CodeMirror extension implementing `{{variable}}` behaviour: token highlighting
 * (green resolved / red unresolved / grey secret), hover popover with the resolved
 * value + its scope (environment, collection, globals), autocomplete on `{{`, a
 * "create variable" action offering each scope, and an "Edit" action that saves a defined variable's value in place.
 * Shared by TemplateInput (single-line) and CodeEditor (multi-line) so both behave identically.
 */
import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  closeHoverTooltips,
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  showTooltip,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
import {
  BUILTIN_VARIABLES,
  parseTokens,
  previewValue,
  scopesChecked,
  sourceLabel,
  tokenStatus,
  type TemplateScope,
  type TokenStatus,
  type VariableInfo,
  type VariableTarget,
} from '../../../lib/template'

/** Dispatch this effect after the scope changed so decorations are rebuilt. */
export const scopeChanged = StateEffect.define<null>()

export interface TemplateHooks {
  getScope: () => TemplateScope
  /** Called from the hover popover for unresolved tokens, with the scope the user picked. */
  onCreateVariable?: (name: string, target: VariableTarget) => void
  /**
   * Saves a new value for a defined variable in the scope it resolves from. Rejects with an Error whose message is shown
   * in the editor. Absent: the popover has no Edit button.
   */
  onEditVariable?: (variable: VariableInfo, value: string) => Promise<void>
  /** Why variables cannot be edited right now (e.g. a read-only workspace), or null. */
  editBlocked?: () => string | null
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

/** Built-ins and script-only (local) variables have nothing to save to. */
const editable = (v: VariableInfo | undefined): v is VariableInfo => !!v && !!v.id && v.source !== 'local'

/** `onEdit` opens the pinned editor for this token (the hover itself closes as soon as the pointer leaves it). */
export function popoverFor(name: string, hooks: TemplateHooks, onEdit?: () => void): HTMLElement {
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
    row.textContent = `Not defined in ${scopesChecked(scope)}.`
    row.classList.add('tpl-pop-bad')
    dom.append(row)
    if (hooks.onCreateVariable) {
      const label = document.createElement('div')
      label.className = 'tpl-pop-src'
      label.textContent = `Create variable "${name}" in:`
      dom.append(label)
      const targets: Array<[VariableTarget, string]> = []
      if (scope.environmentName) targets.push(['environment', `Environment "${scope.environmentName}"`])
      if (scope.collectionId) targets.push(['collection', `Collection "${scope.collectionName ?? ''}"`])
      targets.push(['globals', 'Globals'])
      for (const [target, text] of targets) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'tpl-pop-btn'
        btn.dataset.target = target
        btn.textContent = text
        btn.addEventListener('mousedown', (e) => e.preventDefault())
        btn.addEventListener('click', () => hooks.onCreateVariable?.(name, target))
        dom.append(btn)
      }
    }
  } else {
    row.textContent = value ?? ''
    row.classList.add('tpl-pop-value')
    if (status === 'secret') row.setAttribute('data-secret', 'true')
    dom.append(row)
    const src = document.createElement('div')
    src.className = 'tpl-pop-src'
    const v = scope.variables.get(name)
    src.textContent = status === 'builtin' || !v ? 'Built-in dynamic variable' : `${status === 'secret' ? 'Secret · ' : ''}${sourceLabel(v, scope)}`
    dom.append(src)
    if (onEdit && hooks.onEditVariable && editable(v)) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'tpl-pop-btn'
      btn.dataset.action = 'edit'
      btn.textContent = status === 'secret' ? 'Set new value' : 'Edit value'
      const blocked = hooks.editBlocked?.() ?? null
      if (blocked) {
        btn.disabled = true
        btn.title = blocked
      }
      btn.addEventListener('mousedown', (e) => e.preventDefault())
      btn.addEventListener('click', () => onEdit())
      dom.append(btn)
    }
  }
  return dom
}

/**
 * The value editor for `{{name}}`: the stored (raw, unresolved) value, or an empty password field for a secret (its
 * value never reaches the renderer). Enter saves, Escape or leaving it cancels. `done(saved)` closes it.
 */
export function variableEditorFor(name: string, hooks: TemplateHooks, done: (saved: boolean) => void): HTMLElement {
  const scope = hooks.getScope()
  const v = scope.variables.get(name)
  const dom = document.createElement('div')
  dom.className = 'tpl-pop tpl-edit'
  dom.setAttribute('data-testid', 'template-editor')
  const title = document.createElement('div')
  title.className = 'tpl-pop-title'
  title.textContent = name
  dom.append(title)
  const src = document.createElement('div')
  src.className = 'tpl-pop-src'
  dom.append(src)
  const error = document.createElement('div')
  error.className = 'tpl-pop-bad tpl-edit-error'
  error.setAttribute('role', 'alert')
  const showError = (text: string) => {
    error.textContent = text
    if (!error.isConnected) dom.append(error)
  }
  const blocked = hooks.editBlocked?.() ?? null
  if (!editable(v) || !hooks.onEditVariable || blocked) {
    src.textContent = blocked ?? `"${name}" cannot be edited here.`
    const close = button('Close', () => done(false))
    dom.append(close)
    return dom
  }
  src.textContent = `${v.secret ? 'Secret · ' : ''}${sourceLabel(v, scope)}`

  const input = document.createElement('input')
  input.className = 'tpl-edit-input'
  input.type = v.secret ? 'password' : 'text'
  input.value = v.secret ? '' : (v.value ?? '')
  input.placeholder = v.secret ? 'New value (the current one stays hidden)' : ''
  input.spellcheck = false
  input.autocomplete = 'off'
  input.setAttribute('aria-label', `Value of ${name}`)
  dom.append(input)

  let busy = false
  const save = async () => {
    if (busy) return
    const value = input.value
    if (v.secret && value === '') {
      showError('Type a new value, or press Escape to keep the current one.')
      return
    }
    if (!v.secret && value === (v.value ?? '')) {
      done(false)
      return
    }
    busy = true
    saveBtn.disabled = cancelBtn.disabled = input.disabled = true
    saveBtn.textContent = 'Saving…'
    try {
      await hooks.onEditVariable!(v, value)
      done(true)
    } catch (e) {
      busy = false
      saveBtn.disabled = cancelBtn.disabled = input.disabled = false
      saveBtn.textContent = 'Save'
      showError(e instanceof Error ? e.message : String(e))
      input.focus()
    }
  }
  input.addEventListener('keydown', (e) => {
    // Keep Enter / Escape away from the field's own shortcuts (e.g. Enter sends the request).
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      void save()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!busy) done(false)
    }
  })
  // Clicking anywhere else cancels, like Escape.
  dom.addEventListener('focusout', (e) => {
    const next = e.relatedTarget
    if (!busy && !(next instanceof Node && dom.contains(next))) done(false)
  })
  const row = document.createElement('div')
  row.className = 'tpl-edit-actions'
  const saveBtn = button('Save', () => void save())
  saveBtn.dataset.action = 'save'
  const cancelBtn = button('Cancel', () => done(false), 'tpl-pop-btn-quiet')
  row.append(saveBtn, cancelBtn)
  dom.append(row)
  return dom
}

function button(text: string, onClick: () => void, extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `tpl-pop-btn ${extraClass}`.trim()
  btn.textContent = text
  // Keep the focus in the input (a click on Save must not count as leaving the editor).
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', onClick)
  return btn
}

// ---------------------------------------------------------------------------
// Pinned editor (stays open while typing, unlike the hover)
// ---------------------------------------------------------------------------

interface PinnedEditor {
  pos: number
  end: number
  name: string
}

/** Opens (or with null closes) the value editor for the token at pos..end. */
export const pinVariableEditor = StateEffect.define<PinnedEditor | null>()

function pinnedEditor(hooks: TemplateHooks) {
  return StateField.define<PinnedEditor | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(pinVariableEditor)) return e.value
      if (!value || !tr.docChanged) return value
      // Editing the token itself closes the editor; edits elsewhere move it along.
      if (tr.changes.touchesRange(value.pos, value.end)) return null
      return { ...value, pos: tr.changes.mapPos(value.pos, 1), end: tr.changes.mapPos(value.end, -1) }
    },
    provide: (field) =>
      showTooltip.from(field, (p) =>
        p
          ? {
              pos: p.pos,
              end: p.end,
              above: true,
              create: (view) => {
                const dom = variableEditorFor(p.name, hooks, (saved) => {
                  view.dispatch({ effects: [pinVariableEditor.of(null), ...(saved ? [scopeChanged.of(null)] : [])] })
                  if (saved) view.focus()
                })
                return { dom, mount: () => dom.querySelector<HTMLInputElement>('input')?.focus() }
              },
            }
          : null,
      ),
  })
}

function hover(hooks: TemplateHooks) {
  return hoverTooltip(
    (view, pos) => {
      const line = view.state.doc.lineAt(pos)
      for (const tok of parseTokens(line.text)) {
        const from = line.from + tok.from
        const to = line.from + tok.to
        if (pos >= from && pos <= to) {
          const edit = () => view.dispatch({ effects: [closeHoverTooltips, pinVariableEditor.of({ pos: from, end: to, name: tok.name })] })
          return { pos: from, end: to, above: true, create: () => ({ dom: popoverFor(tok.name, hooks, edit) }) }
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
        info: sourceLabel(v, scope),
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
    pinnedEditor(hooks),
    autocompletion({ override: [templateCompletionSource(hooks), suggestionSource(hooks)], icons: false, activateOnTyping: true, closeOnBlur: true }),
  ]
}
