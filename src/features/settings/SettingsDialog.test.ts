import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../../app/settings.svelte'
import { ui } from '../../app/ui.svelte'
import { windowChrome } from '../../app/windowChrome.svelte'
import { createMockBackend, type MockControls } from '../../dev/mockBackend'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import { updates } from '../updates/updates.svelte'
import { APPEARANCE_KEY } from '../../lib/appearance'
import { ACCENTS, THEMES } from '../../lib/themes'
import SettingsDialog from './SettingsDialog.svelte'

const html = document.documentElement
const stored = () => JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')

function setup(section: typeof ui.settingsSection = 'appearance') {
  ui.settingsSection = section
  window.slinger = createMockBackend({ latencyMs: 0, seed: false })
  render(SettingsDialog)
  return {
    get themes() {
      return screen.getByRole('radiogroup', { name: 'Theme' })
    },
    get accents() {
      return screen.getByRole('radiogroup', { name: 'Accent colour' })
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  settings.setTheme('system')
  settings.setAccent('theme')
  settings.setLoader('random')
  settings.setSystemTheme('light', 'light')
  settings.setSystemTheme('dark', 'dark')
  settings.prefersLight = false
})

describe('theme gallery', () => {
  it('offers System plus every theme, grouped Light / Dark, with a live preview each', () => {
    const { themes } = setup()
    expect(within(themes).getAllByRole('radio')).toHaveLength(THEMES.length + 1)
    const light = within(themes).getByRole('region', { name: 'Light themes' })
    const dark = within(themes).getByRole('region', { name: 'Dark themes' })
    expect(within(light).getAllByRole('radio')).toHaveLength(THEMES.filter((t) => t.scheme === 'light').length)
    expect(within(dark).getAllByRole('radio')).toHaveLength(THEMES.filter((t) => t.scheme === 'dark').length)
    expect(within(dark).getByRole('radio', { name: 'Dracula' })).toBeInTheDocument()
    // each preview is drawn with its own palette
    for (const t of THEMES) expect(themes.querySelector(`[data-theme-option="${t.id}"] [data-theme="${t.id}"]`)).not.toBeNull()
    expect(within(themes).getByRole('radio', { name: /System/ })).toBeChecked()
  })

  it('applies a theme instantly and persists it', async () => {
    const { themes } = setup()
    await fireEvent.click(within(themes).getByRole('radio', { name: 'Tokyo Night' }))
    expect(html.dataset.theme).toBe('tokyo-night')
    expect(within(themes).getByRole('radio', { name: 'Tokyo Night' })).toBeChecked()
    expect(stored().theme).toBe('tokyo-night')
  })

  it('filters by name and by Light / Dark', async () => {
    const { themes } = setup()
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter themes' }), { target: { value: 'catppuccin' } })
    expect(within(themes).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['catppuccin-latte', 'catppuccin-mocha', 'catppuccin-frappe'])

    await fireEvent.click(screen.getByRole('button', { name: 'Dark' }))
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(themes).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['catppuccin-mocha', 'catppuccin-frappe'])

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter themes' }), { target: { value: 'zzz' } })
    expect(within(themes).queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByText(/No themes match/)).toBeInTheDocument()
  })

  it('lets System use a chosen light and dark theme', async () => {
    setup()
    const darkSelect = screen.getByRole('combobox', { name: /OS is dark/ }) as HTMLSelectElement
    const lightSelect = screen.getByRole('combobox', { name: /OS is light/ }) as HTMLSelectElement
    // only themes of the matching scheme are offered
    expect([...darkSelect.options].every((o) => THEMES.find((t) => t.id === o.value)?.scheme === 'dark')).toBe(true)
    expect([...lightSelect.options].every((o) => THEMES.find((t) => t.id === o.value)?.scheme === 'light')).toBe(true)

    await fireEvent.change(darkSelect, { target: { value: 'nord' } })
    expect(html.dataset.theme).toBe('nord') // OS prefers dark in this test
    await fireEvent.change(lightSelect, { target: { value: 'paper' } })
    expect(html.dataset.theme).toBe('nord')
    settings.prefersLight = true
    settings.apply()
    expect(html.dataset.theme).toBe('paper')
    expect(stored()).toMatchObject({ theme: 'system', systemLight: 'paper', systemDark: 'nord' })
  })
})

describe('accent picker', () => {
  it('lists Theme default and every accent by name', () => {
    const { accents } = setup()
    const radios = within(accents).getAllByRole('radio')
    expect(radios).toHaveLength(ACCENTS.length + 1)
    expect(within(accents).getByRole('radio', { name: 'Theme default' })).toBeChecked()
    for (const a of ACCENTS) expect(within(accents).getByRole('radio', { name: a.label })).toBeInTheDocument()
  })

  it('layers the chosen accent over the theme and persists it; Theme default removes it', async () => {
    const { accents, themes } = setup()
    await fireEvent.click(within(accents).getByRole('radio', { name: 'Emerald' }))
    expect(html.dataset.accent).toBe('emerald')
    expect(stored().accent).toBe('emerald')
    // theme previews now show the chosen accent
    expect(themes.querySelector('[data-theme-option="dracula"] [data-theme="dracula"]')).toHaveAttribute('data-accent', 'emerald')

    await fireEvent.click(within(themes).getByRole('radio', { name: 'Gruvbox Dark' }))
    expect(html.dataset.accent).toBe('emerald') // accent survives a theme change

    await fireEvent.click(within(accents).getByRole('radio', { name: 'Theme default' }))
    expect(html.hasAttribute('data-accent')).toBe(false)
    expect(stored().accent).toBe('theme')
  })
})

describe('loading animation', () => {
  it('offers Random (default), the three characters and the classic spinner, and persists the choice', async () => {
    setup()
    const group = screen.getByRole('radiogroup', { name: 'Loading animation' })
    expect(within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['random', 'runner', 'shuttle', 'pebble', 'classic'])
    expect(within(group).getByRole('radio', { name: 'Random' })).toBeChecked()
    // previews: Random shows all three standing still; the selected character runs
    expect(group.querySelectorAll('[data-loader-option="random"] [data-testid="loading-character"]')).toHaveLength(3)
    expect(group.querySelector('[data-loader-option="runner"] [data-testid="loading-character"]')).toHaveAttribute('data-motion', 'still')

    await fireEvent.click(within(group).getByRole('radio', { name: 'Runner' }))
    expect(settings.loader).toBe('runner')
    expect(stored().loader).toBe('runner')
    expect(group.querySelector('[data-loader-option="runner"] [data-testid="loading-character"]')).toHaveAttribute('data-motion', 'full')

    await fireEvent.click(within(group).getByRole('radio', { name: 'Classic spinner' }))
    expect(stored()).toMatchObject({ theme: 'system', loader: 'classic' })
  })
})

describe('restore tabs on startup', () => {
  afterEach(() => settings.setRestoreTabsOnStartup(true)) // restore the default for other test files sharing this module

  it('is on by default, and turning it off persists the choice and erases stored tabs', async () => {
    localStorage.setItem('slinger.tabs.some-workspace', '{"v":1,"activeIndex":null,"tabs":[]}')
    setup('editor')
    const checkbox = screen.getByRole('checkbox', { name: /Restore open tabs on startup/ })
    expect(checkbox).toBeChecked()

    await fireEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
    expect(settings.restoreTabsOnStartup).toBe(false)
    expect(localStorage.getItem('slinger.restoreTabsOnStartup')).toBe('false')
    expect(localStorage.getItem('slinger.tabs.some-workspace')).toBeNull()
  })
})

describe('window and updates', () => {
  async function open(section: typeof ui.settingsSection): Promise<SlingerIpcApi & MockControls> {
    ui.settingsSection = section
    sessionStorage.clear()
    const backend = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = backend
    updates.resetForTests()
    await windowChrome.init()
    render(SettingsDialog)
    return backend
  }

  it('switches to the system title bar, applied by reopening the window', async () => {
    const backend = await open('layout')
    const box = screen.getByRole('checkbox', { name: 'Use the system title bar' })
    expect(box).not.toBeChecked()
    expect(screen.getByRole('button', { name: 'About the title bar' })).toBeInTheDocument()
    expect(screen.queryByTestId('titlebar-reopen')).toBeNull()
    await fireEvent.click(box)
    await screen.findByTestId('titlebar-reopen')
    expect(await backend.getWindowChrome()).toMatchObject({ preferredTitleBar: 'system' })
    const reopen = vi.spyOn(backend, 'reopenWindow').mockResolvedValue(undefined)
    await fireEvent.click(screen.getByRole('button', { name: 'Reopen window' }))
    expect(reopen).toHaveBeenCalledTimes(1)
  })

  it('turns automatic update checks off and checks on demand', async () => {
    const backend = await open('updates')
    const auto = screen.getByRole('checkbox', { name: 'Check for new releases automatically' })
    expect(auto).toBeChecked()
    await fireEvent.click(auto)
    expect(updates.auto).toBe(false)

    await fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText(/^Up to date\. Checked just now\.$/)).toBeInTheDocument()

    backend.failNext('checkForUpdates', { code: 'network_error', message: 'offline' })
    await fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Could not check: offline')).toBeInTheDocument()

    // A release found earlier stays offered even if a later check fails.
    backend.setLatestRelease('3.0.0')
    await fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    expect(await screen.findByText('Slinger 3.0.0 is available.')).toBeInTheDocument()
    const openUrl = vi.spyOn(backend, 'openExternalUrl').mockResolvedValue(undefined)
    await fireEvent.click(screen.getByRole('button', { name: 'View release' }))
    expect(openUrl).toHaveBeenCalledWith('https://github.com/perunok/slinger/releases/tag/v3.0.0')
    backend.failNext('checkForUpdates', { code: 'network_error', message: 'offline' })
    await fireEvent.click(screen.getByRole('button', { name: 'Check now' }))
    await screen.findByRole('button', { name: 'Check now' })
    expect(screen.getByText('Slinger 3.0.0 is available.')).toBeInTheDocument()

  })
})

describe('sections', () => {
  it('lists the sections at the side; each shows its own settings, and the last one stays selected', async () => {
    setup()
    const nav = screen.getByRole('tablist', { name: 'Settings sections' })
    expect(within(nav).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Appearance', 'Layout & window', 'Editor & tabs', 'Scripts', 'Updates'])
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Show sidebar/ })).toBeNull()
    await fireEvent.click(within(nav).getByRole('tab', { name: 'Layout & window' }))
    expect(screen.getByRole('checkbox', { name: /Show sidebar/ })).toBeInTheDocument()
    expect(screen.getByTestId('titlebar-layout')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Theme' })).toBeNull()
    expect(ui.settingsSection).toBe('layout')
    await fireEvent.click(within(nav).getByRole('tab', { name: 'Scripts' }))
    expect(screen.getByRole('spinbutton', { name: /Time limit per script/ })).toBeInTheDocument()
  })

  it('"Customize title bar…" opens Layout & window', () => {
    ui.settingsFocus = 'titlebar'
    window.slinger = createMockBackend({ latencyMs: 0, seed: false })
    ui.settingsSection = 'appearance'
    render(SettingsDialog)
    expect(ui.settingsSection).toBe('layout')
    expect(ui.settingsFocus).toBeNull()
    expect(screen.getByTestId('titlebar-layout')).toBeInTheDocument()
  })
})

