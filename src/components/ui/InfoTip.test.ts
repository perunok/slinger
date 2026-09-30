import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import InfoTip from './InfoTip.svelte'

afterEach(cleanup)

const text = createRawSnippet(() => ({ render: () => '<span>A request passes on a 2xx status.</span>' }))
const setup = () => render(InfoTip, { label: 'When a request passes', children: text })

describe('InfoTip', () => {
  it('hides its text until the (i) is hovered, and hides it again when the pointer leaves', async () => {
    setup()
    const button = screen.getByRole('button', { name: 'When a request passes' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await fireEvent.mouseEnter(button.parentElement!)
    expect(screen.getByRole('tooltip')).toHaveTextContent('A request passes on a 2xx status.')
    expect(button).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    await fireEvent.mouseLeave(button.parentElement!)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('shows on keyboard focus; Escape and blur hide it', async () => {
    setup()
    const button = screen.getByRole('button', { name: 'When a request passes' })
    await fireEvent.focus(button)
    expect(screen.getByRole('tooltip')).toBeInTheDocument()
    await fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
    await fireEvent.focus(button)
    await fireEvent.blur(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
