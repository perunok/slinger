import { fireEvent, render, screen } from '@testing-library/svelte'
import { beforeEach, describe, expect, it } from 'vitest'
import { settings } from '../../app/settings.svelte'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { newMcpRequestDraft } from '../../lib/mcpRequest'
import { serializeDraft } from '../../lib/request'
import { THEMES } from '../../lib/themes'
import QuickOpen from './QuickOpen.svelte'
import { tabsStore } from './tabs.svelte'

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

describe('quick open requests', () => {
  it('finds MCP requests by method and opens them in the MCP editor', async () => {
    const backend = createMockBackend({ latencyMs: 0, seed: false })
    window.slinger = backend
    window.__slingerMock = backend
    tabsStore.tabs = []
    tabsStore.activeId = null
    await app.init()
    const ws = app.workspaceId!
    const col = await backend.createCollection(ws, 'Tools')
    const s = serializeDraft({ ...newMcpRequestDraft('Weather'), url: 'https://mcp.test/mcp' })
    await backend.createRequest({ workspaceId: ws, collectionId: col.id, folderId: null, name: s.name, method: s.method, url: s.url, documentJson: s.documentJson })
    await backend.createRequest({ workspaceId: ws, collectionId: col.id, folderId: null, name: 'Plain', method: 'GET', url: 'https://x.test', documentJson: '{}' })
    await app.reloadCollections()
    const { input, type, options } = setup()
    await type('mcp')
    expect(options()[0]).toMatch(/^MCP Weather/)
    expect(options().some((o) => o?.includes('Plain'))).toBe(false)
    expect(screen.getAllByRole('option')[0].querySelector('span')).toHaveStyle({ color: 'var(--m-other)' })
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(tabsStore.active?.draft.mcp).toMatchObject({ transport: 'http' })
    expect(tabsStore.active?.title).toBe('Weather')
  })
})
