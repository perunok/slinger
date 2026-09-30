import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { layeredScope, makeScope } from '../../lib/template'
import { showTooltip } from '@codemirror/view'
import { pinVariableEditor, popoverFor, templateCompletionSource, templateExtension, variableEditorFor, type TemplateHooks } from './cm/template'
import TemplateInput from './TemplateInput.svelte'

afterEach(cleanup)

const scope = makeScope('Local', [
  { key: 'baseUrl', value: 'https://api.test', secret: false },
  { key: 'apiToken', value: null, secret: true, id: 's1' },
])

function viewOf(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)
  if (!view) throw new Error('no editor view')
  return view
}
const classesFor = (container: HTMLElement) => [...container.querySelectorAll('.cm-tpl')].map((e) => [e.textContent, e.className.replace('cm-tpl ', '')])

describe('TemplateInput', () => {
  it('is an accessible single-line textbox showing its value', () => {
    render(TemplateInput, { value: 'hello', label: 'Request URL', scope })
    const box = screen.getByRole('textbox', { name: 'Request URL' })
    expect(box).toHaveTextContent('hello')
    expect(box).toHaveAttribute('aria-multiline', 'false')
  })

  it('colours tokens: green resolved, red unresolved, grey secret, built-ins', () => {
    const { container } = render(TemplateInput, { value: '{{baseUrl}}/x?a={{nope}}&t={{apiToken}}&g={{$guid}}', label: 'URL', scope })
    expect(classesFor(container)).toEqual([
      ['{{baseUrl}}', 'cm-tpl-resolved'],
      ['{{nope}}', 'cm-tpl-unresolved'],
      ['{{apiToken}}', 'cm-tpl-secret'],
      ['{{$guid}}', 'cm-tpl-builtin'],
    ])
  })

  it('reports edits through oninput without echoing them back', async () => {
    const oninput = vi.fn()
    const { container } = render(TemplateInput, { value: 'ab', label: 'URL', scope, oninput })
    const view = viewOf(container)
    view.dispatch({ changes: { from: 2, insert: 'c' }, selection: { anchor: 3 } })
    expect(oninput).toHaveBeenCalledTimes(1)
    expect(oninput).toHaveBeenCalledWith('abc')
  })

  it('keeps the caret when the parent pushes a change after it (URL <-> params sync)', async () => {
    const { container, rerender } = render(TemplateInput, { value: 'http://x?a=1', label: 'URL', scope })
    const view = viewOf(container)
    view.dispatch({ selection: { anchor: 8 } })
    await rerender({ value: 'http://x?a=1&b=2' })
    expect(view.state.doc.toString()).toBe('http://x?a=1&b=2')
    expect(view.state.selection.main.head).toBe(8)
  })

  it('re-renders decorations when the scope changes', async () => {
    const { container, rerender } = render(TemplateInput, { value: '{{later}}', label: 'URL', scope })
    expect(classesFor(container)[0][1]).toBe('cm-tpl-unresolved')
    await rerender({ scope: makeScope('Local', [{ key: 'later', value: '1', secret: false }]) })
    expect(classesFor(container)[0][1]).toBe('cm-tpl-resolved')
  })

  it('strips newlines from pasted text and calls onenter on Enter', () => {
    const onenter = vi.fn()
    const oninput = vi.fn()
    const { container } = render(TemplateInput, { value: '', label: 'URL', scope, onenter, oninput })
    const view = viewOf(container)
    view.dispatch({ changes: { from: 0, insert: 'a\r\nb\nc' } })
    expect(view.state.doc.toString()).toBe('abc')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(onenter).toHaveBeenCalledTimes(1)
  })
})

describe('template hover popover', () => {
  it('shows the resolved value and source environment', () => {
    const dom = popoverFor('baseUrl', { getScope: () => scope })
    expect(dom.textContent).toContain('https://api.test')
    expect(dom.textContent).toContain('Environment: Local')
  })
  it('masks secrets', () => {
    const dom = popoverFor('apiToken', { getScope: () => scope })
    expect(dom.textContent).toContain('••••••••')
    expect(dom.textContent).not.toContain('sk_')
    expect(dom.querySelector('[data-secret="true"]')).not.toBeNull()
  })
  it('offers to create an unresolved variable', () => {
    const onCreateVariable = vi.fn()
    const dom = popoverFor('missing', { getScope: () => scope, onCreateVariable })
    dom.querySelector<HTMLButtonElement>('button')!.click()
    expect(onCreateVariable).toHaveBeenCalledWith('missing', 'environment')
    expect(dom.textContent).toContain('Not defined in the environment "Local" or the globals')
    dom.querySelector<HTMLButtonElement>('button[data-target="globals"]')!.click()
    expect(onCreateVariable).toHaveBeenLastCalledWith('missing', 'globals')
  })
  it('names the scope a value comes from and offers the collection as a target', () => {
    const layered = layeredScope({
      environmentName: 'Local',
      environment: [{ key: 'e', value: 'env', secret: false }],
      collectionId: 'c1',
      collectionName: 'Payments',
      collection: [{ key: 'c', value: 'col', secret: false }, { key: 'e', value: 'shadowed', secret: false }],
      globals: [{ key: 'g', value: 'glob', secret: false }, { key: 's', value: null, secret: true, id: 'g1' }],
    })
    expect(popoverFor('e', { getScope: () => layered }).textContent).toContain('Environment: Local')
    expect(popoverFor('e', { getScope: () => layered }).textContent).toContain('env')
    expect(popoverFor('c', { getScope: () => layered }).textContent).toContain('Collection: Payments')
    expect(popoverFor('g', { getScope: () => layered }).textContent).toContain('Globals')
    expect(popoverFor('s', { getScope: () => layered }).textContent).toContain('Secret · Globals')
    const onCreateVariable = vi.fn()
    const dom = popoverFor('nope', { getScope: () => layered, onCreateVariable })
    expect([...dom.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.dataset.target)).toEqual(['environment', 'collection', 'globals'])
    dom.querySelector<HTMLButtonElement>('button[data-target="collection"]')!.click()
    expect(onCreateVariable).toHaveBeenCalledWith('nope', 'collection')
  })
})

describe('template autocomplete', () => {
  const run = (doc: string) => {
    const state = EditorState.create({ doc })
    return templateCompletionSource({ getScope: () => scope })(new CompletionContext(state, doc.length, false))
  }
  it('opens right after {{ with environment variables and built-ins', () => {
    const r = run('http://{{')
    expect(r?.from).toBe(9)
    const labels = r!.options.map((o) => o.label)
    expect(labels).toEqual(expect.arrayContaining(['baseUrl', 'apiToken', '$guid', '$timestamp', '$randomInt']))
  })
  it('filters by what is typed and does not trigger outside a token', () => {
    const r = run('{{bas')
    expect(r?.from).toBe(2)
    expect(run('plain text')).toBeNull()
    expect(run('{{done}} ')).toBeNull()
  })
})

describe('editing a variable from the popover', () => {
  const layered = layeredScope({
    environmentName: 'Local',
    environment: [
      { key: 'host', value: 'https://{{region}}.api.test', secret: false, id: 'e1' },
      { key: 'token', value: null, secret: true, id: 'e2' },
    ],
    collectionId: 'c1',
    collectionName: 'Drive Automation',
    collection: [{ key: 'customer', value: 'WXcrkT', secret: false, id: 'c9' }],
    local: [{ key: 'fromScript', value: '1', secret: false }],
  })
  const hooksWith = (over: Partial<TemplateHooks> = {}): TemplateHooks => ({ getScope: () => layered, onEditVariable: vi.fn(async () => {}), ...over })
  const editButton = (dom: HTMLElement) => dom.querySelector<HTMLButtonElement>('button[data-action="edit"]')
  const inputOf = (dom: HTMLElement) => dom.querySelector('input') as HTMLInputElement
  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

  it('offers Edit for defined variables of every stored scope, not for built-ins, script variables or unknown names', () => {
    const onEdit = vi.fn()
    const hooks = hooksWith()
    for (const name of ['host', 'customer']) expect(editButton(popoverFor(name, hooks, onEdit))?.textContent, name).toBe('Edit value')
    expect(editButton(popoverFor('token', hooks, onEdit))?.textContent).toBe('Set new value')
    for (const name of ['$guid', 'fromScript', 'nope']) expect(editButton(popoverFor(name, hooks, onEdit)), name).toBeNull()
    // No save hook or no way to open the editor: no button.
    expect(editButton(popoverFor('host', { getScope: () => layered }, onEdit))).toBeNull()
    expect(editButton(popoverFor('host', hooks))).toBeNull()
    editButton(popoverFor('customer', hooks, onEdit))!.click()
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('is disabled, with the reason, in a read-only workspace', () => {
    const btn = editButton(popoverFor('host', hooksWith({ editBlocked: () => 'You have viewer access to Acme.' }), vi.fn()))!
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe('You have viewer access to Acme.')
    const dom = variableEditorFor('host', hooksWith({ editBlocked: () => 'read-only' }), vi.fn())
    expect(dom.querySelector('input')).toBeNull()
    expect(dom.textContent).toContain('read-only')
  })

  it('shows the stored value (templates unresolved) and saves the new one with Enter', async () => {
    const hooks = hooksWith()
    const done = vi.fn()
    const dom = variableEditorFor('host', hooks, done)
    expect(dom.textContent).toContain('Environment: Local')
    const input = inputOf(dom)
    expect(input.type).toBe('text')
    expect(input.value).toBe('https://{{region}}.api.test')
    input.value = 'https://eu.api.test'
    key(input, 'Enter')
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true))
    expect(hooks.onEditVariable).toHaveBeenCalledWith(expect.objectContaining({ key: 'host', id: 'e1', source: 'environment' }), 'https://eu.api.test')
  })

  it('Save button saves a collection variable; an unchanged value just closes', async () => {
    const hooks = hooksWith()
    const done = vi.fn()
    const dom = variableEditorFor('customer', hooks, done)
    expect(dom.textContent).toContain('Collection: Drive Automation')
    inputOf(dom).value = 'NewName'
    dom.querySelector<HTMLButtonElement>('button[data-action="save"]')!.click()
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true))
    expect(hooks.onEditVariable).toHaveBeenCalledWith(expect.objectContaining({ key: 'customer', source: 'collection' }), 'NewName')

    const done2 = vi.fn()
    const again = variableEditorFor('customer', hooks, done2)
    key(inputOf(again), 'Enter')
    expect(done2).toHaveBeenCalledWith(false)
    expect(hooks.onEditVariable).toHaveBeenCalledTimes(1)
  })

  it('a secret starts empty (its value never reaches the editor) and needs a new value', async () => {
    const hooks = hooksWith()
    const done = vi.fn()
    const dom = variableEditorFor('token', hooks, done)
    const input = inputOf(dom)
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    key(input, 'Enter')
    expect(dom.querySelector('[role="alert"]')?.textContent).toMatch(/Type a new value/)
    expect(hooks.onEditVariable).not.toHaveBeenCalled()
    input.value = 'sk-new'
    key(input, 'Enter')
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith(true))
    expect(hooks.onEditVariable).toHaveBeenCalledWith(expect.objectContaining({ key: 'token', secret: true }), 'sk-new')
  })

  it('a failed save keeps the editor open with the message; Escape cancels', async () => {
    const hooks = hooksWith({ onEditVariable: vi.fn(async () => Promise.reject(new Error('This workspace is read-only.'))) })
    const done = vi.fn()
    const dom = variableEditorFor('host', hooks, done)
    document.body.append(dom)
    const input = inputOf(dom)
    input.value = 'x'
    key(input, 'Enter')
    await vi.waitFor(() => expect(dom.querySelector('[role="alert"]')?.textContent).toBe('This workspace is read-only.'))
    expect(done).not.toHaveBeenCalled()
    expect(input.disabled).toBe(false)
    key(input, 'Escape')
    expect(done).toHaveBeenCalledWith(false)
    dom.remove()
  })

  it('Enter and Escape do not reach the field around it (Enter would send the request)', () => {
    const outer = document.createElement('div')
    const onKey = vi.fn()
    outer.addEventListener('keydown', onKey)
    const dom = variableEditorFor('host', hooksWith(), vi.fn())
    outer.append(dom)
    key(inputOf(dom), 'Escape')
    key(inputOf(dom), 'Enter')
    expect(onKey).not.toHaveBeenCalled()
  })

  it('the pinned editor opens at the token, follows edits elsewhere and closes when the token changes', () => {
    let state = EditorState.create({ doc: 'GET {{host}}/x', extensions: templateExtension(hooksWith()) })
    const tooltips = () => state.facet(showTooltip).filter(Boolean)
    expect(tooltips()).toHaveLength(0)
    state = state.update({ effects: pinVariableEditor.of({ pos: 4, end: 12, name: 'host' }) }).state
    expect(tooltips()).toHaveLength(1)
    expect(tooltips()[0]!.pos).toBe(4)
    state = state.update({ changes: { from: 0, insert: 'X' } }).state
    expect(tooltips()[0]!.pos).toBe(5)
    state = state.update({ changes: { from: 7, to: 8, insert: 'H' } }).state
    expect(tooltips()).toHaveLength(0)
  })
})
