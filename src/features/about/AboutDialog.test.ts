import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import ACKNOWLEDGEMENTS from 'virtual:acknowledgements'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import QuickOpen from '../requests/QuickOpen.svelte'
import TopBar from '../../app/TopBar.svelte'
import AboutDialog from './AboutDialog.svelte'
import { CREDITS, MANIFESTO, SIGN_OFF } from './credits'
import creditsSource from './credits.ts?raw'
import { formatVersionInfo } from './versionInfo'

Element.prototype.scrollIntoView ??= function () {}

let opened: string[]
let clipboard: string[]

function setup() {
  const backend = createMockBackend({ latencyMs: 0, seed: false })
  opened = []
  backend.openExternalUrl = async (url: string) => void opened.push(url)
  window.slinger = backend
  clipboard = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async (t: string) => void clipboard.push(t)) }, configurable: true })
  ui.aboutOpen = true
  return render(AboutDialog)
}

beforeEach(() => {
  toast.clear()
  ui.aboutOpen = false
  ui.quickOpen = false
})

describe('About dialog', () => {
  it('renders the header, developer, story, manifesto and acknowledgements', async () => {
    setup()
    const dialog = screen.getByRole('dialog', { name: 'About Slinger' })
    expect(within(dialog).getByRole('heading', { name: 'Slinger' })).toBeInTheDocument()
    expect(within(dialog).getByRole('img', { name: 'Slinger icon' })).toBeInTheDocument()
    expect(dialog).toHaveTextContent('A local-first API client. Small, fast, yours.')
    await waitFor(() => expect(screen.getByTestId('about-version')).toHaveTextContent('Version 0.0.0-dev'))
    for (const h of ['Developer', 'Why Slinger', 'The Sling Manifesto', 'Acknowledgements']) {
      expect(within(dialog).getByRole('heading', { name: h })).toBeInTheDocument()
    }
    expect(dialog).toHaveTextContent('Henok Moltotal')
    expect(dialog).toHaveTextContent('Creator & maintainer')
    expect(dialog).toHaveTextContent('Built with the help of AI pair programming (Claude).')
    expect(dialog).toHaveTextContent('Slinger started as a small frustration.')
    const principles = within(within(dialog).getByRole('list', { name: 'The Sling Manifesto' })).getAllByRole('listitem')
    expect(principles).toHaveLength(8)
    expect(principles[0]).toHaveTextContent('A sling is small. Carry less, hit harder.')
    expect(principles[7]).toHaveTextContent("Leave no trace you didn't choose.")
    expect(screen.getByTestId('about-signoff')).toHaveTextContent(SIGN_OFF)
    expect(dialog).not.toHaveTextContent(/Made in/i)
  })

  it('opens every link through openExternalUrl, never by navigating', async () => {
    setup()
    const dialog = screen.getByRole('dialog', { name: 'About Slinger' })
    for (const l of CREDITS.links) {
      const a = within(dialog).getByRole('link', { name: l.label })
      expect(a).toHaveAttribute('href', l.url)
      const notPrevented = await fireEvent.click(a)
      expect(notPrevented).toBe(false)
    }
    await fireEvent.click(within(dialog).getByRole('link', { name: '@perunok' }))
    await fireEvent.click(within(dialog).getByRole('link', { name: 'marked' }))
    await waitFor(() => expect(opened).toHaveLength(CREDITS.links.length + 2))
    expect(opened).toEqual([...CREDITS.links.map((l) => l.url), 'https://github.com/perunok', 'https://marked.js.org'])
    for (const url of opened) expect(url).toMatch(/^https?:\/\//)
  })

  it('copies version info with the runtime versions and nothing sensitive', async () => {
    setup()
    await fireEvent.click(screen.getByRole('button', { name: 'Copy version info' }))
    await waitFor(() => expect(clipboard).toHaveLength(1))
    expect(clipboard[0]).toBe(['Slinger: 0.0.0-dev', 'Electron: n/a', 'Chromium: n/a', 'Node: n/a', 'V8: n/a', 'OS: browser mock (unknown)'].join('\n'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(toast.items.some((t) => t.kind === 'success')).toBe(true)
  })

  it('formats real version info for a bug report', () => {
    const text = formatVersionInfo({
      app: '0.5.0',
      electron: '33.4.11',
      chrome: '130.0.6723.191',
      node: '20.18.3',
      v8: '13.0.245.25-electron.0',
      os: { platform: 'darwin', release: '24.1.0', arch: 'arm64' },
    })
    expect(text).toBe('Slinger: 0.5.0\nElectron: 33.4.11\nChromium: 130.0.6723.191\nNode: 20.18.3\nV8: 13.0.245.25-electron.0\nOS: macOS 24.1.0 (arm64)')
  })

  it('lists the key open-source packages with their licences in a collapsible section', () => {
    setup()
    const details = screen.getByText('Standing on the shoulders of').closest('details')
    expect(details).not.toBeNull()
    expect(details?.open).toBe(false)
    const names = ACKNOWLEDGEMENTS.map((a) => a.name)
    for (const key of ['electron', 'svelte', '@codemirror/view', 'quickjs-emscripten-core', 'better-sqlite3', 'marked', 'dompurify', 'zod',
      'crypto-js', 'lodash', 'moment', 'uuid', 'chai', 'tv4', 'ajv', 'xml2js', 'csv-parse', 'cheerio']) {
      expect(names, key).toContain(key)
    }
    for (const a of ACKNOWLEDGEMENTS) {
      expect(a.version, a.name).toMatch(/^\d+\.\d+/)
      expect(a.license, a.name).not.toBe('Unknown')
      expect(a.homepage, a.name).toMatch(/^https?:\/\//)
    }
    expect(ACKNOWLEDGEMENTS.find((a) => a.name === 'dompurify')?.license).toBe('(MPL-2.0 OR Apache-2.0)')
    expect(ACKNOWLEDGEMENTS.find((a) => a.name === 'lodash')?.group).toBe('sandbox')
    expect(screen.getAllByTestId('ack-item')).toHaveLength(ACKNOWLEDGEMENTS.length)
  })

  it('closes with Escape', async () => {
    setup()
    await fireEvent.keyDown(document, { key: 'Escape' })
    expect(ui.aboutOpen).toBe(false)
  })
})

describe('credits data', () => {
  it('contains no email address and only http(s) links', () => {
    expect(creditsSource).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/)
    expect(JSON.stringify(CREDITS)).not.toMatch(/mailto:|@[\w-]+\.[a-z]{2,}/i)
    for (const l of CREDITS.links) expect(l.url).toMatch(/^https:\/\//)
    expect(CREDITS.developer.github).toMatch(/^https:\/\//)
    expect(MANIFESTO).toHaveLength(8)
  })
})

describe('entry points', () => {
  it('the top bar has an "About Slinger" button', async () => {
    window.slinger = createMockBackend({ latencyMs: 0, seed: false })
    render(TopBar)
    await fireEvent.click(screen.getByRole('button', { name: 'About Slinger' }))
    expect(ui.aboutOpen).toBe(true)
  })

  it('Ctrl+K offers an "About Slinger" command', async () => {
    window.slinger = createMockBackend({ latencyMs: 0, seed: false })
    ui.quickOpen = true
    render(QuickOpen)
    const input = screen.getByRole('combobox', { name: 'Search requests and commands' })
    await fireEvent.input(input, { target: { value: 'about' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['About Slinger version, credits, manifesto'])
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(ui.aboutOpen).toBe(true)
    expect(ui.quickOpen).toBe(false)
  })
})
