import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import CreateVersionDialog from './CreateVersionDialog.svelte'

function setup(oncreate = vi.fn(async () => {}), existing = ['1.0.0', '1.2.0-rc.1']) {
  const onclose = vi.fn()
  render(CreateVersionDialog, { existing, requestCount: 3, folderCount: 1, oncreate, onclose })
  const input = screen.getByLabelText('Version') as HTMLInputElement
  const submit = screen.getByRole('button', { name: 'Create version' })
  return { input, submit, oncreate, onclose }
}
const type = (el: HTMLInputElement, v: string) => fireEvent.input(el, { target: { value: v } })

describe('CreateVersionDialog', () => {
  it.each([
    ['v1.0.0', /"v"/],
    ['1.0.0+build', /Build metadata/],
    ['1.0', /MAJOR\.MINOR\.PATCH/],
    ['1.0.0', /already exists/],
  ])('rejects %s', async (text, reason) => {
    const { input, submit } = setup()
    await type(input, text)
    expect(await screen.findByText(reason)).toBeInTheDocument()
    expect(submit).toBeDisabled()
  })

  it('accepts a prerelease', async () => {
    const { input, submit } = setup()
    await type(input, '2.0.0-beta.1')
    await waitFor(() => expect(submit).toBeEnabled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('quick buttons prefill from the latest release', async () => {
    const { input } = setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Patch 1.0.1' }))
    expect(input.value).toBe('1.0.1')
    await fireEvent.click(screen.getByRole('button', { name: 'Minor 1.1.0' }))
    expect(input.value).toBe('1.1.0')
    await fireEvent.click(screen.getByRole('button', { name: 'Major 2.0.0' }))
    expect(input.value).toBe('2.0.0')
  })

  it('submits only when valid, with notes, and closes', async () => {
    const { input, submit, oncreate, onclose } = setup()
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(oncreate).not.toHaveBeenCalled()
    await type(input, '1.1.0')
    await fireEvent.input(screen.getByLabelText(/Notes/), { target: { value: ' hello ' } })
    await fireEvent.click(submit)
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(oncreate).toHaveBeenCalledWith('1.1.0', 'hello')
  })

  it('submits on Enter when valid', async () => {
    const { input, oncreate } = setup()
    await type(input, '3.0.0')
    await fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(oncreate).toHaveBeenCalledWith('3.0.0', null))
  })

  it('keeps the dialog open and shows the error on failure', async () => {
    const { input, submit, onclose } = setup(vi.fn(async () => Promise.reject(new Error('server said no'))))
    await type(input, '1.5.0')
    await fireEvent.click(submit)
    expect(await screen.findByText('server said no')).toBeInTheDocument()
    expect(onclose).not.toHaveBeenCalled()
  })
})
