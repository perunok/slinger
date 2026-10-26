import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import ContextMenu from './ContextMenu.svelte'
import { isMenuKey, menuPoint } from './contextMenu'

describe('ContextMenu', () => {
  it('moves focus over separators to the item Enter runs', async () => {
    const second = vi.fn()
    const first = vi.fn()
    render(ContextMenu, {
      x: 10,
      y: 10,
      onclose: () => {},
      items: [
        { label: 'First', action: first },
        { separator: true, label: '' },
        { label: 'Second', action: second },
        { label: 'Third' },
      ],
    })
    await Promise.resolve()
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }))
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }))
    await fireEvent.keyDown(screen.getByRole('menu'), { key: 'Enter' })
    expect(second).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
  })
})

describe('context menu helpers', () => {
  it('recognises Shift+F10 and the Menu key only', () => {
    expect(isMenuKey(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true }))).toBe(true)
    expect(isMenuKey(new KeyboardEvent('keydown', { key: 'ContextMenu' }))).toBe(true)
    expect(isMenuKey(new KeyboardEvent('keydown', { key: 'F10' }))).toBe(false)
  })

  it('opens at the pointer, or under the element for the keyboard', () => {
    expect(menuPoint(new MouseEvent('contextmenu', { clientX: 40, clientY: 50 }))).toEqual({ x: 40, y: 50 })
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ left: 100, bottom: 30 }) as DOMRect
    expect(menuPoint(new KeyboardEvent('keydown', { key: 'ContextMenu' }), el)).toEqual({ x: 124, y: 30 })
  })
})
