/** Settings > Network against the mock backend (which validates like main): SSL, CA and client certificates, proxy. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ui } from '../../app/ui.svelte'
import { createMockBackend, type MockControls } from '../../dev/mockBackend'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import NetworkSettings from './NetworkSettings.svelte'
import SettingsDialog from './SettingsDialog.svelte'

let backend: SlingerIpcApi & MockControls
beforeEach(() => {
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
})
afterEach(() => cleanup())

async function setup() {
  render(NetworkSettings)
  await screen.findByTestId('verify-ssl')
}

describe('Settings > Network', () => {
  it('is a section of the Settings dialog', async () => {
    ui.settingsSection = 'network'
    render(SettingsDialog)
    expect(screen.getByRole('tab', { name: 'Network' })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByTestId('network-settings')).toBeInTheDocument()
    ui.settingsSection = 'appearance'
  })

  it('turns SSL certificate verification off and on', async () => {
    await setup()
    const box = screen.getByRole('checkbox', { name: 'SSL certificate verification' })
    expect(box).toBeChecked()
    await fireEvent.click(box)
    await waitFor(async () => expect((await backend.getNetworkSettings()).verifySsl).toBe(false))
    expect(box).not.toBeChecked()
  })

  it('adds CA certificates through the file dialog and removes them', async () => {
    await setup()
    expect(screen.getAllByText('None added.')).toHaveLength(2)
    await fireEvent.click(screen.getByTestId('add-ca'))
    const list = await screen.findByRole('list', { name: 'CA certificates' })
    expect(list).toHaveTextContent('sample-upload.png')
    expect(backend.calls.some((c) => c.method === 'pickFile')).toBe(true)
    await fireEvent.click(within(list).getByRole('button', { name: /^Remove/ }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'CA certificates' })).toBeNull())
  })

  it('adds a client certificate (PEM files, passphrase never shown again) and edits it', async () => {
    await setup()
    await fireEvent.click(screen.getByTestId('add-client-cert'))
    await fireEvent.input(screen.getByTestId('cert-host'), { target: { value: 'API.example.com' } })
    await fireEvent.input(screen.getByTestId('cert-port'), { target: { value: '99999' } })
    await fireEvent.click(screen.getByTestId('cert-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('The port must be a number from 1 to 65535')
    await fireEvent.input(screen.getByTestId('cert-port'), { target: { value: '8443' } })
    await fireEvent.click(screen.getByTestId('cert-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a certificate file and its key file')
    await fireEvent.click(screen.getByTestId('cert-choose-crt'))
    await fireEvent.click(screen.getByTestId('cert-choose-key'))
    await waitFor(() => expect(screen.queryAllByText('None chosen')).toHaveLength(0))
    await fireEvent.input(screen.getByTestId('cert-passphrase'), { target: { value: 'secret-pp' } })
    await fireEvent.click(screen.getByTestId('cert-save'))
    const list = await screen.findByRole('list', { name: 'Client certificates' })
    expect(list).toHaveTextContent('api.example.com:8443')
    expect(list).toHaveTextContent('passphrase stored')
    expect(JSON.stringify(await backend.getNetworkSettings())).not.toContain('secret-pp')

    await fireEvent.click(within(list).getByRole('button', { name: /^Edit/ }))
    expect((screen.getByTestId('cert-passphrase') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('cert-passphrase') as HTMLInputElement).placeholder).toBe('Stored; type to replace')
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Remove the stored passphrase' }))
    await fireEvent.click(screen.getByTestId('cert-save'))
    await waitFor(async () => expect((await backend.getNetworkSettings()).clientCertificates[0]).toMatchObject({ host: 'api.example.com', port: 8443, hasPassphrase: false }))
  })

  it('switches the proxy: system by default, custom after saving a URL, none', async () => {
    await setup()
    const group = screen.getByRole('radiogroup', { name: 'Proxy' })
    expect(within(group).getByRole('radio', { name: 'Use the system proxy' })).toBeChecked()
    await fireEvent.click(within(group).getByRole('radio', { name: 'Custom proxy' }))
    // Not applied until there is a URL to use.
    expect((await backend.getNetworkSettings()).proxy.mode).toBe('system')
    await fireEvent.input(screen.getByTestId('proxy-url'), { target: { value: 'socks5://p:1080' } })
    await fireEvent.click(screen.getByTestId('proxy-save'))
    expect(await screen.findByRole('alert')).toHaveTextContent('SOCKS proxies are not supported')
    await fireEvent.input(screen.getByTestId('proxy-url'), { target: { value: 'proxy.corp:3128' } })
    await fireEvent.input(screen.getByTestId('proxy-username'), { target: { value: 'me' } })
    await fireEvent.input(screen.getByTestId('proxy-password'), { target: { value: 'pw' } })
    await fireEvent.input(screen.getByTestId('proxy-bypass'), { target: { value: 'a.com, .corp' } })
    await fireEvent.click(screen.getByTestId('proxy-save'))
    await waitFor(async () =>
      expect((await backend.getNetworkSettings()).proxy).toEqual({ mode: 'custom', url: 'http://proxy.corp:3128', username: 'me', hasPassword: true, bypass: ['a.com', '.corp'] }),
    )
    expect((screen.getByTestId('proxy-url') as HTMLInputElement).value).toBe('http://proxy.corp:3128')
    expect((screen.getByTestId('proxy-password') as HTMLInputElement).value).toBe('')
    expect(screen.getByTestId('proxy-save')).toBeDisabled()
    await fireEvent.click(within(group).getByRole('radio', { name: 'No proxy' }))
    await waitFor(async () => expect((await backend.getNetworkSettings()).proxy.mode).toBe('none'))
    expect(screen.queryByTestId('proxy-url')).toBeNull()
  })

  it('shows a load failure', async () => {
    backend.failNext('getNetworkSettings', { code: 'io_error', message: 'disk on fire' })
    render(NetworkSettings)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the network settings: disk on fire')
  })
})
