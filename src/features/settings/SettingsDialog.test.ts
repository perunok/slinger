import { fireEvent, render, screen, within } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { settings } from '../../app/settings.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { APPEARANCE_KEY } from '../../lib/appearance'
import { ACCENTS, THEMES } from '../../lib/themes'
import SettingsDialog from './SettingsDialog.svelte'

const html = document.documentElement
const stored = () => JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')

function setup() {
  window.slinger = createMockBackend({ latencyMs: 0, seed: false })
  render(SettingsDialog)
  return {
    themes: screen.getByRole('radiogroup', { name: 'Theme' }),
    accents: screen.getByRole('radiogroup', { name: 'Accent colour' }),
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
