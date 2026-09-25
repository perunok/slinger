import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { cleanup, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeScope } from '../../lib/template'
import { popoverFor, templateCompletionSource } from './cm/template'
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
    expect(onCreateVariable).toHaveBeenCalledWith('missing')
    expect(dom.textContent).toContain('Not defined in "Local"')
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
