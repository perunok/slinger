import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockBackend } from '../../dev/mockBackend'
import { dataRows, ensureTrailingEmpty, newRow, type KvRow } from '../../lib/kv'
import KeyValueTable from './KeyValueTable.svelte'

afterEach(cleanup)
beforeEach(() => {
  window.slinger = createMockBackend({ latencyMs: 0 })
})

const viewFor = (label: string) => EditorView.findFromDOM(screen.getByRole('textbox', { name: label }).closest('.cm-editor') as HTMLElement)!

function setup(rows: KvRow[], props: Record<string, unknown> = {}) {
  const onchange = vi.fn()
  const utils = render(KeyValueTable, { rows: ensureTrailingEmpty(rows), onchange, noun: 'Header', ...props })
  return { onchange, ...utils }
}

describe('KeyValueTable', () => {
  it('always shows a trailing blank row and typing into it emits data plus a fresh blank row', () => {
    const { onchange } = setup([newRow({ key: 'A', value: '1' })])
    expect(screen.getAllByRole('textbox', { name: /Header \d+ key/ })).toHaveLength(2)
    viewFor('Header 2 key').dispatch({ changes: { from: 0, insert: 'B' } })
    const next = onchange.mock.calls[0][0] as KvRow[]
    expect(dataRows(next).map((r) => r.key)).toEqual(['A', 'B'])
    expect(next.at(-1)?.key).toBe('') // auto-appended blank row
  })

  it('keeps row identity so focus survives updates (keyed rows)', async () => {
    const rows = ensureTrailingEmpty([newRow({ key: 'A', value: '1' })])
    const { onchange, rerender } = setup(rows)
    const before = screen.getByRole('textbox', { name: 'Header 1 value' })
    viewFor('Header 1 value').dispatch({ changes: { from: 1, insert: '2' } })
    const next = onchange.mock.calls[0][0] as KvRow[]
    await rerender({ rows: next })
    expect(screen.getByRole('textbox', { name: 'Header 1 value' })).toBe(before)
  })

  it('toggles enabled, removes rows and never shows remove/enable for the blank row', async () => {
    const a = newRow({ key: 'A', value: '1' })
    const { onchange } = setup([a])
    await fireEvent.click(screen.getByLabelText('Header 1 enabled'))
    expect((onchange.mock.calls[0][0] as KvRow[])[0].enabled).toBe(false)
    await fireEvent.click(screen.getByRole('button', { name: 'Remove header 1' }))
    const after = onchange.mock.calls[1][0] as KvRow[]
    expect(dataRows(after)).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Remove header 2' })).toBeNull()
  })

  it('warns about duplicate header names case-insensitively', () => {
    setup([newRow({ key: 'Accept', value: 'a' }), newRow({ key: 'accept', value: 'b' })], { duplicates: 'case-insensitive' })
    expect(screen.getAllByText('Duplicate header name')).toHaveLength(2)
  })

  it('does not warn for duplicate param names when duplicates are allowed', () => {
    setup([newRow({ key: 'a' }), newRow({ key: 'a' })], { noun: 'Param', duplicates: 'none' })
    expect(screen.queryByText('Duplicate param name')).toBeNull()
  })

  it('bulk edit round-trips rows, keeping disabled ones', async () => {
    const { onchange } = setup([newRow({ key: 'A', value: '1' }), newRow({ key: 'B', value: '2', enabled: false })])
    await fireEvent.click(screen.getByRole('button', { name: /Bulk edit/ }))
    const view = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Header bulk edit' }).closest('.cm-editor') as HTMLElement)!
    expect(view.state.doc.toString()).toBe('A: 1\n//B: 2')
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nC: 3' } })
    const rows = dataRows(onchange.mock.calls.at(-1)![0] as KvRow[])
    expect(rows.map((r) => [r.key, r.value, r.enabled])).toEqual([['A', '1', true], ['B', '2', false], ['C', '3', true]])
  })

  it('form-data rows can switch to a file and pick one', async () => {
    const { onchange } = setup([newRow({ key: 'avatar' })], { noun: 'Field', fileFields: true })
    await fireEvent.change(screen.getByLabelText('Field 1 type'), { target: { value: 'file' } })
    expect((onchange.mock.calls[0][0] as KvRow[])[0].kind).toBe('file')
  })

  it('shows a chosen file and lets the user pick via the native dialog', async () => {
    const { onchange } = setup([newRow({ key: 'avatar', kind: 'file' })], { noun: 'Field', fileFields: true })
    await fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))
    await vi.waitFor(() => expect(onchange).toHaveBeenCalled())
    const row = (onchange.mock.calls[0][0] as KvRow[])[0]
    expect(row.filePath).toMatch(/^\/home\/user\//)
  })

  it('flags a saved file path that is not granted in this session and re-grants it on Choose again', async () => {
    const { onchange } = setup([newRow({ key: 'avatar', kind: 'file', filePath: '/home/user/old/photo.png' })], { noun: 'Field', fileFields: true })
    await vi.waitFor(() => expect(screen.getByTestId('file-status')).toHaveTextContent('file not granted'))
    expect(screen.getByTestId('file-status')).toHaveTextContent('photo.png')
    await fireEvent.click(screen.getByRole('button', { name: 'Choose again' }))
    await vi.waitFor(() => expect(onchange).toHaveBeenCalled())
    expect((onchange.mock.calls[0][0] as KvRow[])[0].filePath).toMatch(/^\/home\/user\/Documents\//)
  })

  it('does not flag a file picked in this session', async () => {
    const { onchange, rerender } = setup([newRow({ key: 'avatar', kind: 'file' })], { noun: 'Field', fileFields: true })
    await fireEvent.click(screen.getByRole('button', { name: 'Choose file' }))
    await vi.waitFor(() => expect(onchange).toHaveBeenCalled())
    await rerender({ rows: onchange.mock.calls[0][0] })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByTestId('file-status')).not.toHaveTextContent('not granted')
  })

  it('offers header name suggestions', () => {
    // Suggestions are wired through the same CodeMirror completion source as templates.
    setup([], { suggestions: 'headers' })
    expect(screen.getByRole('textbox', { name: 'Header 1 key' })).toBeInTheDocument()
  })
})
