import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import type { Environment } from '../../../shared/types'
import EnvironmentList from './EnvironmentList.svelte'

const env = (id: string, name: string) => ({ id, name }) as Environment

function setup(readOnly = false) {
  const props = {
    environments: [env('a', 'Dev'), env('b', 'Prod')],
    selectedId: 'a',
    activeId: 'a',
    readOnly,
    onselect: vi.fn(),
    onsetactive: vi.fn(),
    oncreate: vi.fn(),
    onrename: vi.fn(),
    onduplicate: vi.fn(),
    ondelete: vi.fn(),
    onexport: vi.fn(),
  }
  render(EnvironmentList, props)
  return props
}
const labels = (menu: HTMLElement) => within(menu).getAllByRole('menuitem').map((i) => i.textContent?.trim())

describe('EnvironmentList right-click menu', () => {
  it('offers the list buttons for the environment right-clicked', async () => {
    const p = setup()
    await fireEvent.contextMenu(screen.getByRole('button', { name: /Prod/ }))
    const menu = await screen.findByRole('menu')
    expect(labels(menu)).toEqual(['Set active', 'Rename…', 'Duplicate', 'Export…', 'Delete…'])
    await fireEvent.click(within(menu).getByRole('menuitem', { name: 'Set active' }))
    expect(p.onsetactive).toHaveBeenCalledWith('b')
    expect(p.onselect).not.toHaveBeenCalled()
  })

  it('opens with Shift+F10 and disables what a read-only workspace cannot do', async () => {
    const p = setup(true)
    const dev = screen.getByRole('button', { name: /Dev/ })
    await fireEvent.keyDown(dev, { key: 'F10', shiftKey: true })
    const menu = await screen.findByRole('menu')
    const item = (name: string) => within(menu).getByRole('menuitem', { name })
    expect(item('Set active')).toBeDisabled() // already active
    expect(item('Rename…')).toBeDisabled()
    expect(item('Delete…')).toBeDisabled()
    await fireEvent.click(item('Export…'))
    expect(p.onexport).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })
})
