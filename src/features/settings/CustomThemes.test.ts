import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settings } from '../../app/settings.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { CUSTOM_THEMES_KEY, CUSTOM_THEMES_STYLE_ID, type CustomTheme } from '../../lib/customThemes'
import QuickOpen from '../requests/QuickOpen.svelte'
import SettingsDialog from './SettingsDialog.svelte'

const html = document.documentElement
const styleText = () => document.getElementById(CUSTOM_THEMES_STYLE_ID)?.textContent ?? ''
const storedThemes = () => JSON.parse(localStorage.getItem(CUSTOM_THEMES_KEY) ?? '{"themes":[]}').themes as CustomTheme[]
Element.prototype.scrollIntoView ??= function () {}

function setup() {
  window.slinger = createMockBackend({ latencyMs: 0, seed: false })
  render(SettingsDialog)
  return { themes: screen.getByRole('radiogroup', { name: 'Theme' }) }
}

const editor = () => screen.getByTestId('custom-theme-editor')
/** Appends text to the CSS view's CodeMirror document (jsdom cannot type into it). */
function typeCss(text: string) {
  const view = EditorView.findFromDOM(editor().querySelector('.cm-editor') as HTMLElement)!
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
}
function cssDoc(): string {
  return EditorView.findFromDOM(editor().querySelector('.cm-editor') as HTMLElement)!.state.doc.toString()
}
const button = (name: string | RegExp) => screen.getByRole('button', { name })

function saved(over: Partial<CustomTheme> = {}): CustomTheme {
  const t: CustomTheme = { id: 'custom:test-1', label: 'Saved one', scheme: 'dark', base: 'nord', tokens: { bg: '#101820' }, ...over }
  settings.saveCustomTheme(t)
  return t
}

beforeEach(() => {
  localStorage.clear()
  for (const c of [...settings.customThemes]) settings.deleteCustomTheme(c.id)
  settings.setDraftTheme(null)
  settings.setTheme('dark')
  settings.setAccent('theme')
  settings.setSystemTheme('light', 'light')
  settings.setSystemTheme('dark', 'dark')
  settings.prefersLight = false
})
afterEach(() => {
  for (const c of [...settings.customThemes]) settings.deleteCustomTheme(c.id)
  settings.setTheme('system')
})

describe('creating a custom theme', () => {
  it('starts from the current theme, previews CSS edits live in the whole app, and selects it on save', async () => {
    settings.setTheme('nord')
    setup()
    await fireEvent.click(button('New custom theme'))
    expect(screen.getByRole('textbox', { name: 'Theme name' })).toHaveValue('My Nord')
    expect(screen.getByRole('combobox', { name: 'Base theme' })).toHaveValue('nord')
    expect(cssDoc()).toMatch(/^\/\* Base: Nord \(dark\)/)

    typeCss('--bg: #102030;\n--accent: #ff8800;\n')
    await waitFor(() => expect(styleText()).toContain('--bg:#102030;'))
    const draftId = html.dataset.customTheme!
    expect(draftId).toMatch(/^custom:/)
    expect(html.dataset.theme).toBe('nord')
    expect(styleText()).toContain(`[data-theme][data-custom-theme='${draftId}']:not([data-accent]){--accent:#ff8800;}`)
    expect(settings.customThemes).toHaveLength(0) // nothing saved yet

    await fireEvent.click(button('Create theme'))
    expect(screen.queryByTestId('custom-theme-editor')).toBeNull()
    expect(settings.customThemes).toEqual([{ id: draftId, label: 'My Nord', scheme: 'dark', base: 'nord', tokens: { bg: '#102030', accent: '#ff8800' } }])
    expect(settings.theme).toBe(draftId)
    expect(html.dataset.customTheme).toBe(draftId)
    expect(storedThemes()).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('slinger.appearance')!).theme).toBe(draftId)
    // the gallery lists it, marked Custom
    const custom = screen.getByRole('region', { name: 'Custom themes' })
    expect(within(custom).getByRole('radio', { name: /My Nord/ })).toBeChecked()
    expect(within(custom).getByText(/Custom · dark/)).toBeInTheDocument()
  })

  it('shows line-numbered CSS errors and blocks saving until they are fixed', async () => {
    setup()
    await fireEvent.click(button('New custom theme'))
    typeCss('--nope: red;\n--bg: url(//e.example/x);\n')
    const errors = await screen.findByTestId('theme-css-errors')
    expect(errors).toHaveTextContent('Line 3: Unknown token --nope.')
    expect(errors).toHaveTextContent('Line 4: --bg uses url(), which is not allowed')
    expect(button('Create theme')).toBeDisabled()
    expect(styleText()).not.toContain('url(')
  })

  it('cancel reverts the live preview and saves nothing', async () => {
    setup()
    await fireEvent.click(button('New custom theme'))
    typeCss('--bg: #abcdef;\n')
    await waitFor(() => expect(html.dataset.customTheme).toBeDefined())
    await fireEvent.click(button('Cancel'))
    expect(html.dataset.customTheme).toBeUndefined()
    expect(html.dataset.theme).toBe('dark')
    expect(styleText()).not.toContain('#abcdef')
    expect(settings.customThemes).toHaveLength(0)
  })

  it('can preview only in the editor instead of the whole app', async () => {
    setup()
    await fireEvent.click(button('New custom theme'))
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Preview in the whole app' }))
    typeCss('--bg: #abcdef;\n')
    await waitFor(() => expect(styleText()).toContain('#abcdef'))
    expect(html.dataset.customTheme).toBeUndefined()
    const preview = editor().querySelector('[data-custom-theme]')
    expect(preview).toHaveAttribute('data-theme', 'dark')
  })

  it('the form view edits the same token map as the CSS view', async () => {
    setup()
    await fireEvent.click(button('New custom theme'))
    typeCss('--bg: #111111;\n')
    await fireEvent.click(button('Form'))
    const form = screen.getByTestId('theme-form')
    expect(within(form).getByRole('textbox', { name: '--bg' })).toHaveValue('#111111')
    // inherited values show as placeholders
    expect(within(form).getByRole('textbox', { name: '--surface' }).getAttribute('placeholder')).toMatch(/^#/)

    await fireEvent.change(within(form).getByRole('textbox', { name: '--text' }), { target: { value: '#fafafa' } })
    await fireEvent.change(within(form).getByRole('textbox', { name: '--text-muted' }), { target: { value: 'rgb(1, 2' } })
    expect(within(form).getByRole('alert')).toHaveTextContent('--text-muted has unbalanced parentheses')
    expect(button('Create theme')).toBeDisabled()
    await fireEvent.click(button('Reset --text-muted'))
    await fireEvent.click(button('Reset --bg'))

    await fireEvent.click(button('CSS'))
    expect(cssDoc()).toContain('--text: #fafafa;')
    expect(cssDoc()).not.toContain('--bg:')
    expect(cssDoc()).not.toContain('--text-muted')
    expect(button('Create theme')).toBeEnabled()
  })

  it('shows contrast warnings with the pairs involved but still allows saving; the gallery card shows them too', async () => {
    setup()
    await fireEvent.click(button('New custom theme'))
    typeCss('--bg: #ffffff;\n--text: #ffffff;\n')
    const contrast = await screen.findByTestId('theme-contrast')
    await waitFor(() => expect(contrast).toHaveTextContent('Text on Background: 1.0:1, needs 4.5:1 (body text)'))
    expect(button('Create theme')).toBeEnabled()
    await fireEvent.click(button('Create theme'))
    const card = screen.getByRole('region', { name: 'Custom themes' })
    expect(within(card).getByTestId('theme-warnings')).toHaveTextContent(/\d+ contrast warnings/)
    expect(within(card).getByTestId('theme-warnings').getAttribute('title')).toContain('Text on Background')
  })

  it('duplicates a built-in theme from its card', async () => {
    setup()
    await fireEvent.click(button('Duplicate Dracula as a custom theme'))
    expect(screen.getByRole('textbox', { name: 'Theme name' })).toHaveValue('My Dracula')
    expect(screen.getByRole('combobox', { name: 'Base theme' })).toHaveValue('dracula')
  })
})

describe('managing custom themes', () => {
  it('edits and renames a saved theme', async () => {
    const t = saved()
    setup()
    await fireEvent.click(button('Edit Saved one'))
    expect(cssDoc()).toContain('--bg: #101820;')
    await fireEvent.input(screen.getByRole('textbox', { name: 'Theme name' }), { target: { value: 'Renamed' } })
    await fireEvent.click(button('Save theme'))
    expect(settings.customThemes).toEqual([{ ...t, label: 'Renamed' }])
    expect(storedThemes()[0]!.label).toBe('Renamed')
    expect(screen.getByRole('radio', { name: /Renamed/ })).toBeInTheDocument()
  })

  it('duplicates a custom theme with its overrides', async () => {
    saved()
    setup()
    await fireEvent.click(button('Duplicate Saved one'))
    expect(screen.getByRole('textbox', { name: 'Theme name' })).toHaveValue('Saved one copy')
    expect(cssDoc()).toContain('--bg: #101820;')
    await fireEvent.click(button('Create theme'))
    expect(settings.customThemes.map((c) => c.label)).toEqual(['Saved one', 'Saved one copy'])
  })

  it('deletes after confirmation; the selected theme falls back to its base', async () => {
    const t = saved()
    settings.setTheme(t.id)
    setup()
    await fireEvent.click(button('Delete Saved one'))
    const dialog = screen.getByRole('dialog', { name: 'Delete custom theme' })
    expect(dialog).toHaveTextContent('switches to its base theme')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(settings.customThemes).toHaveLength(0))
    expect(settings.theme).toBe('nord')
    expect(html.dataset.theme).toBe('nord')
    expect(html.dataset.customTheme).toBeUndefined()
    expect(styleText()).toBe('')
  })

  it('offers custom themes of the matching scheme for System', async () => {
    const dark = saved()
    saved({ id: 'custom:test-2', label: 'Light one', scheme: 'light', base: 'paper' })
    setup()
    const darkSelect = screen.getByRole('combobox', { name: /OS is dark/ }) as HTMLSelectElement
    const lightSelect = screen.getByRole('combobox', { name: /OS is light/ }) as HTMLSelectElement
    expect([...darkSelect.querySelectorAll('optgroup[label="Custom"] option')].map((o) => o.textContent)).toEqual(['Saved one'])
    expect([...lightSelect.querySelectorAll('optgroup[label="Custom"] option')].map((o) => o.textContent)).toEqual(['Light one'])
    settings.setTheme('system')
    await fireEvent.change(darkSelect, { target: { value: dark.id } })
    expect(html.dataset.customTheme).toBe(dark.id)
    expect(html.dataset.theme).toBe('nord')
  })
})

describe('import / export', () => {
  it('exports a .slinger-theme.json file', async () => {
    saved()
    setup()
    const write = vi.spyOn(window.slinger, 'writeExportFile')
    await fireEvent.click(button('Export Saved one'))
    await waitFor(() => expect(write).toHaveBeenCalled())
    const [name, contents] = write.mock.calls[0]!
    expect(name).toBe('Saved one.slinger-theme.json')
    expect(JSON.parse(contents)).toEqual({ format: 'slinger-theme', version: 1, label: 'Saved one', scheme: 'dark', base: 'nord', tokens: { bg: '#101820' } })
  })

  it('imports a theme file into the editor for review, reporting skipped tokens', async () => {
    setup()
    await fireEvent.click(button('Import theme'))
    const file = new File(
      [JSON.stringify({ format: 'slinger-theme', version: 1, label: 'Shared', scheme: 'light', base: 'paper', tokens: { bg: '#fafafa', text: 'url(x)' } })],
      'Shared.slinger-theme.json',
      { type: 'application/json' },
    )
    await fireEvent.change(screen.getByLabelText('Theme file'), { target: { files: [file] } })
    await screen.findByTestId('custom-theme-editor')
    expect(screen.getByRole('textbox', { name: 'Theme name' })).toHaveValue('Shared')
    expect(screen.getByRole('combobox', { name: 'Base theme' })).toHaveValue('paper')
    expect(screen.getByText(/--text uses url\(\)/)).toBeInTheDocument()
    expect(cssDoc()).toContain('--bg: #fafafa;')
    await fireEvent.click(button('Create theme'))
    expect(settings.customThemes.map((c) => [c.label, c.tokens])).toEqual([['Shared', { bg: '#fafafa' }]])
  })

  it('accepts pasted CSS and rejects pasted selectors with line numbers', async () => {
    setup()
    await fireEvent.click(button('Import theme'))
    const area = screen.getByRole('textbox', { name: 'Theme CSS or JSON' })
    await fireEvent.input(area, { target: { value: 'body { --bg: red; }' } })
    await fireEvent.click(button('Import pasted text'))
    expect(screen.getByRole('alert')).toHaveTextContent('Line 1: Selectors and { } blocks are not allowed')
    await fireEvent.input(area, { target: { value: '--bg: #0b1020;\n--text: #e6e9f5;' } })
    await fireEvent.click(button('Import pasted text'))
    await screen.findByTestId('custom-theme-editor')
    expect(screen.getByRole('textbox', { name: 'Theme name' })).toHaveValue('Imported theme')
  })
})

describe('command palette', () => {
  it('lists custom themes, marked custom, and switches to them', async () => {
    const t = saved()
    ui.quickOpen = true
    render(QuickOpen)
    const input = screen.getByRole('combobox', { name: 'Search requests and commands' })
    await fireEvent.input(input, { target: { value: '> saved one' } })
    const options = screen.queryAllByRole('option').map((o) => o.textContent?.replace(/\s+/g, ' ').trim())
    expect(options).toEqual(['Theme: Saved one custom dark theme'])
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(settings.theme).toBe(t.id)
    expect(html.dataset.customTheme).toBe(t.id)
  })
})

describe('native window background', () => {
  it('reports the custom theme --bg to main when it is applied', async () => {
    const { resetWindowBackgroundForTests } = await import('../../lib/windowBackground')
    resetWindowBackgroundForTests()
    const setWindowBackground = vi.fn(async (_c: string) => {})
    window.slinger = { ...createMockBackend({ latencyMs: 0, seed: false }), setWindowBackground }
    const t = saved({ tokens: { bg: '#123456' } })
    settings.setTheme(t.id)
    expect(setWindowBackground).toHaveBeenLastCalledWith('#123456')
  })
})
