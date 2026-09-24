import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dialog from './Dialog.svelte'

afterEach(cleanup)

const body = createRawSnippet(() => ({ render: () => '<div><input aria-label="first" /><input aria-label="second" /></div>' }))
const footer = createRawSnippet(() => ({ render: () => '<button>Last</button>' }))

describe('Dialog', () => {
  it('is a labelled modal, focuses its first field and closes on Escape', async () => {
    const onclose = vi.fn()
    render(Dialog, { title: 'Hello', onclose, children: body })
    const dlg = screen.getByRole('dialog', { name: 'Hello' })
    expect(dlg).toHaveAttribute('aria-modal', 'true')
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('first')))
    await fireEvent.keyDown(document, { key: 'Escape' })
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('does not close on Escape when the key was already consumed (autocomplete, menus)', async () => {
    const onclose = vi.fn()
    render(Dialog, { title: 'Hello', onclose, children: body })
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ev.preventDefault()
    document.dispatchEvent(ev)
    expect(onclose).not.toHaveBeenCalled()
  })

  it('traps Tab focus inside the dialog', async () => {
    render(Dialog, { title: 'Trap', onclose: () => {}, children: body, footer })
    const last = screen.getByRole('button', { name: 'Last' })
    last.focus()
    await fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).not.toBe(document.body)
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    const first = screen.getByRole('button', { name: 'Close dialog' })
    first.focus()
    await fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })

  it('cannot be dismissed while busy', async () => {
    const onclose = vi.fn()
    render(Dialog, { title: 'Busy', onclose, busy: true, children: body })
    await fireEvent.keyDown(document, { key: 'Escape' })
    await fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onclose).not.toHaveBeenCalled()
  })

  it('restores focus to the opener when closed', async () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = render(Dialog, { title: 'x', onclose: () => {}, children: body })
    await vi.waitFor(() => expect(document.activeElement).not.toBe(opener))
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
