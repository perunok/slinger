/** The Params tab: Path Variables rows follow the URL's `:name` segments; their values and descriptions are editable. */
import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { newDraft } from '../../lib/request'
import ParamsPanel from './ParamsPanel.svelte'
import UrlBar from './UrlBar.svelte'
import { tabsStore } from './tabs.svelte'

beforeEach(async () => {
  localStorage.clear()
  const backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  await app.init()
})
afterEach(() => cleanup())

const editorOf = (name: string) => EditorView.findFromDOM(screen.getByRole('textbox', { name }).closest('.cm-editor') as HTMLElement)!
const typeInto = (name: string, text: string) => {
  const v = editorOf(name)
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
}

describe('Path Variables', () => {
  it('shows one row per :name in the URL, keeps values when the URL changes, and edits values and descriptions', async () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'https://api.test/pets' }) })
    render(UrlBar, { tab, onsend: () => {}, oncancel: () => {}, onsave: () => {} })
    render(ParamsPanel, { tab })
    expect(screen.queryByTestId('path-variables')).toBeNull()

    typeInto('Request URL', 'https://api.test/pets/:petId')
    await screen.findByTestId('path-variables')
    typeInto('Path variable petId value', '{{id}}')
    await fireEvent.input(screen.getByRole('textbox', { name: 'Path variable petId description' }), { target: { value: 'The pet' } })
    expect(tab.draft.pathVariables).toEqual([{ key: 'petId', value: '{{id}}', description: 'The pet' }])

    typeInto('Request URL', 'https://api.test/owners/:ownerId/pets/:petId?x=1')
    await screen.findByRole('textbox', { name: 'Path variable ownerId value' })
    expect(tab.draft.pathVariables).toEqual([
      { key: 'ownerId', value: '', description: '' },
      { key: 'petId', value: '{{id}}', description: 'The pet' },
    ])

    typeInto('Request URL', 'https://api.test/owners')
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId('path-variables')).toBeNull()
    expect(tab.draft.pathVariables).toEqual([])
  })
})
