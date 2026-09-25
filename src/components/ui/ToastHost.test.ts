import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet, tick } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import { toast } from '../../app/toast.svelte'
import Dialog from './Dialog.svelte'
import ToastHost from './ToastHost.svelte'

afterEach(() => {
  cleanup()
  toast.clear()
})

const body = createRawSnippet(() => ({ render: () => '<div>content</div>' }))

describe('ToastHost', () => {
  it('sits bottom-right and is clickable when no dialog is open', async () => {
    render(ToastHost)
    toast.success('Saved')
    await tick()
    const host = screen.getByTestId('toast-host')
    expect(host.className).toContain('right-3')
    expect(screen.getByRole('status').className).toContain('pointer-events-auto')
  })

  it('moves left and lets clicks through while a dialog is open, then returns', async () => {
    render(ToastHost)
    const dialog = render(Dialog, { title: 'Settings', onclose: () => {}, children: body })
    toast.success('Imported')
    await tick()
    const host = screen.getByTestId('toast-host')
    expect(host.className).toContain('left-3')
    expect(host.className).not.toContain('right-3')
    expect(screen.getByRole('status').className).toContain('pointer-events-none')
    dialog.unmount()
    await tick()
    expect(host.className).toContain('right-3')
    expect(screen.getByRole('status').className).toContain('pointer-events-auto')
  })
})
