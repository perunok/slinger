import { fireEvent, render, screen } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { settings } from '../../app/settings.svelte'
import { ui } from '../../app/ui.svelte'
import { THEMES } from '../../lib/themes'
import QuickOpen from './QuickOpen.svelte'

const html = document.documentElement
// jsdom has no layout; the list scrolls the active option into view.
Element.prototype.scrollIntoView ??= function () {}

function setup() {
  ui.quickOpen = true
  render(QuickOpen)
  const input = screen.getByRole('combobox', { name: 'Search requests and commands' })
  const type = (v: string) => fireEvent.input(input, { target: { value: v } })
  const options = () => screen.queryAllByRole('option').map((o) => o.textContent?.replace(/\s+/g, ' ').trim())
  return { input, type, options }
}

beforeEach(() => {
  localStorage.clear()
  settings.setTheme('dark')
  settings.setAccent('theme')
  settings.setLoader('random')
})

describe('quick open commands', () => {
  it('">" lists every theme and accent command', async () => {
    const { type, options } = setup()
    await type('>')
    // System + themes + Theme default + accents
    expect(options().filter((o) => o?.startsWith('Theme:'))).toHaveLength(THEMES.length + 1)
    expect(options()).toContainEqual(expect.stringMatching(/^Theme: Dark current/))
  })

  it('switches theme from the keyboard', async () => {
    const { input, type, options } = setup()
    await type('> theme drac')
    expect(options()).toEqual(['Theme: Dracula dark theme'])
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(html.dataset.theme).toBe('dracula')
    expect(settings.theme).toBe('dracula')
    expect(ui.quickOpen).toBe(false)
  })

  it('finds commands without the prefix too, and sets the accent', async () => {
    const { input, type, options } = setup()
    await type('accent vio')
    expect(options()).toEqual(['Accent: Violet accent colour'])
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(html.dataset.accent).toBe('violet')
  })

  it('filters themes by scheme', async () => {
    const { type, options } = setup()
    await type('> theme light')
    const hits = options()
    expect(hits.length).toBe(THEMES.filter((t) => t.scheme === 'light').length)
    expect(hits.every((o) => o?.includes('light theme'))).toBe(true)
  })

  it('switches the loading animation', async () => {
    const { input, type, options } = setup()
    await type('> loading')
    expect(options()).toEqual([
      'Loading animation: Random current a different character each send',
      'Loading animation: Runner pixel runner',
      'Loading animation: Shuttle space shuttle',
      'Loading animation: Pebble slingshot pebble',
      'Loading animation: Classic spinner no character',
    ])
    await type('> loading pebble')
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(settings.loader).toBe('pebble')
  })
})
