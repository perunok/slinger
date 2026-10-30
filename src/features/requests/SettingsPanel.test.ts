/** The request Settings tab: timeout, SSL verification and the redirect settings (Postman protocolProfileBehavior). */
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend } from '../../dev/mockBackend'
import { newDraft, serializeDraft } from '../../lib/request'
import SettingsPanel from './SettingsPanel.svelte'
import { tabsStore } from './tabs.svelte'

beforeEach(() => {
  window.slinger = createMockBackend({ latencyMs: 0, seed: false })
  tabsStore.tabs = []
})
afterEach(() => cleanup())

const doc = (tab: { draft: Parameters<typeof serializeDraft>[0] }) => JSON.parse(serializeDraft(tab.draft).documentJson)

describe('request Settings tab', () => {
  it('shows the defaults and stores only changed settings, in Postman shape', async () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'https://api.test/x' }) })
    render(SettingsPanel, { tab })
    const follow = screen.getByRole('checkbox', { name: 'Automatically follow redirects' })
    const original = screen.getByRole('checkbox', { name: 'Follow the original HTTP method' })
    const keepAuth = screen.getByRole('checkbox', { name: 'Keep the Authorization header on redirects to another site' })
    const referer = screen.getByRole('checkbox', { name: 'Remove the Referer header on redirects' })
    const ssl = screen.getByRole('combobox', { name: 'SSL certificate verification' }) as HTMLSelectElement
    const max = screen.getByRole('spinbutton', { name: 'Maximum number of redirects' }) as HTMLInputElement
    expect(follow).toBeChecked()
    expect(original).not.toBeChecked()
    expect(keepAuth).not.toBeChecked()
    expect(referer).not.toBeChecked()
    expect(ssl.value).toBe('default')
    expect(max.value).toBe('')
    expect(max.placeholder).toBe('10')
    expect(doc(tab)).not.toHaveProperty('protocolProfileBehavior')

    await fireEvent.click(original)
    await fireEvent.change(ssl, { target: { value: 'off' } })
    await fireEvent.change(max, { target: { value: '3' } })
    expect(doc(tab).protocolProfileBehavior).toEqual({ followOriginalHttpMethod: true, strictSSL: false, maxRedirects: 3 })

    // Following off: the other redirect settings do not apply and are disabled.
    await fireEvent.click(follow)
    expect(follow).not.toBeChecked()
    expect(original).toBeDisabled()
    expect(max).toBeDisabled()
    expect(doc(tab).protocolProfileBehavior).toMatchObject({ followRedirects: false })
    await fireEvent.click(follow)
    expect(doc(tab).protocolProfileBehavior).not.toHaveProperty('followRedirects')
  })

  it('shows imported values', () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'x', protocolProfileBehavior: { strictSSL: true, followAuthorizationHeader: true, maxRedirects: 0 } }) })
    render(SettingsPanel, { tab })
    expect((screen.getByRole('combobox', { name: 'SSL certificate verification' }) as HTMLSelectElement).value).toBe('on')
    expect(screen.getByRole('checkbox', { name: 'Keep the Authorization header on redirects to another site' })).toBeChecked()
    expect((screen.getByRole('spinbutton', { name: 'Maximum number of redirects' }) as HTMLInputElement).value).toBe('0')
  })
})
