/**
 * Launch skeleton: the static markup in index.html (tokens only, reduced-motion aware) and its removal, both by the
 * lifecycle helper and by the real App once the first workspace has loaded or startup failed.
 */
import { readFileSync } from 'node:fs'
import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockBackend } from '../dev/mockBackend'
import App from './App.svelte'
import { app } from './state.svelte'
import {
  bootSkeletonVisible,
  dismissBootSkeleton,
  FADE_MS,
  INSTANT_MS,
  markMounted,
  resetBootSkeletonForTests,
  SKELETON_ID,
} from './bootSkeleton'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const indexHtml = read('../../index.html')
const bootCss = read('../styles/boot.css')

/** Puts the skeleton from index.html into the jsdom document, as the browser would have. */
function installSkeleton() {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html')
  document.getElementById(SKELETON_ID)?.remove()
  document.body.appendChild(document.importNode(doc.getElementById(SKELETON_ID)!, true))
}

function setReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  }))
}

beforeEach(() => {
  resetBootSkeletonForTests()
  installSkeleton()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.getElementById(SKELETON_ID)?.remove()
})

describe('index.html skeleton markup', () => {
  const doc = new DOMParser().parseFromString(indexHtml, 'text/html')
  const skel = doc.getElementById(SKELETON_ID)!

  it('mirrors the app layout: top bar, sidebar with tabs, filter and ~8 tree rows, request editor and response', () => {
    expect(skel).not.toBeNull()
    expect(skel.getAttribute('aria-hidden')).toBe('true')
    expect(skel.querySelector('.bs-top .bs-top-right')).not.toBeNull()
    expect(skel.querySelector('.bs-side .bs-tabs')).not.toBeNull()
    expect(skel.querySelector('.bs-side .bs-filter')).not.toBeNull()
    expect(skel.querySelectorAll('.bs-side .bs-tree .bs-row').length).toBe(8)
    expect(skel.querySelector('.bs-main .bs-url .is-grow')).not.toBeNull()
    expect(skel.querySelector('.bs-main .bs-response')).not.toBeNull()
    // it is a sibling of the mount point, so mounting the app never replaces it
    expect(doc.getElementById('root')!.contains(skel)).toBe(false)
  })

  it('is plain HTML: no inline scripts or styles (CSP), theme applied first, its stylesheet in <head>', () => {
    for (const s of doc.querySelectorAll('script')) expect(s.getAttribute('src'), s.outerHTML).toBeTruthy()
    expect(doc.querySelectorAll('[style], style').length).toBe(0)
    const head = [...doc.head.children].map((e) => e.getAttribute('src') ?? e.getAttribute('href'))
    expect(head.indexOf('/theme-init.js')).toBeGreaterThanOrEqual(0)
    expect(head.indexOf('/src/styles/boot.css')).toBeGreaterThan(head.indexOf('/theme-init.js'))
  })

  it('every class it uses is styled by boot.css (and none collides with Tailwind utilities)', () => {
    const classes = new Set([skel, ...skel.querySelectorAll('*')].flatMap((e) => [...e.classList]))
    for (const c of classes) {
      expect(c, c).toMatch(/^(boot-skeleton|bs-|is-)/)
      expect(bootCss, c).toContain(`.${c}`)
    }
  })

  it('boot.css brings the theme tokens (once: app.css no longer imports them) and honours reduced motion', () => {
    expect(bootCss).toMatch(/@import '\.\/themes\.css';/)
    expect(read('../styles/app.css')).not.toMatch(/@import\s+['"]\.\/themes\.css/)
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(bootCss)?.[1] ?? ''
    expect(reduced).toMatch(/\.bs-block::after\s*\{[^}]*animation:\s*none/)
    expect(reduced).toMatch(/\.boot-skeleton\s*\{[^}]*transition:\s*none/)
    expect(bootCss).toMatch(/@keyframes bs-shimmer/)
  })
})

describe('dismissBootSkeleton', () => {
  it('removes the skeleton at once when data arrives within INSTANT_MS of mount', () => {
    markMounted()
    dismissBootSkeleton('ready')
    expect(bootSkeletonVisible()).toBe(false)
    expect(window.__slingerStartup).toMatchObject({ mounted: expect.any(Number), ready: expect.any(Number), removed: expect.any(Number) })
    expect(window.__slingerStartup?.faded).toBeUndefined()
  })

  it('cross-fades, then removes, when loading took longer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
    markMounted()
    vi.advanceTimersByTime(INSTANT_MS + 50)
    dismissBootSkeleton('ready')
    const el = document.getElementById(SKELETON_ID)!
    expect(el.classList.contains('is-leaving')).toBe(true)
    dismissBootSkeleton('ready') // idempotent
    vi.advanceTimersByTime(FADE_MS)
    expect(el.isConnected).toBe(true)
    vi.advanceTimersByTime(100)
    expect(bootSkeletonVisible()).toBe(false)
    expect(window.__slingerStartup?.faded).toBe(true)
  })

  it('removes on transitionend without waiting for the fallback timer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
    markMounted()
    vi.advanceTimersByTime(500)
    dismissBootSkeleton('ready')
    document.getElementById(SKELETON_ID)!.dispatchEvent(new Event('transitionend'))
    expect(bootSkeletonVisible()).toBe(false)
  })

  it('removes at once on a startup error and under prefers-reduced-motion', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
    markMounted()
    vi.advanceTimersByTime(500)
    dismissBootSkeleton('error')
    expect(bootSkeletonVisible()).toBe(false)

    installSkeleton()
    setReducedMotion(true)
    dismissBootSkeleton('ready')
    expect(bootSkeletonVisible()).toBe(false)
  })

  it('does nothing when there is no skeleton', () => {
    document.getElementById(SKELETON_ID)!.remove()
    expect(() => dismissBootSkeleton('ready')).not.toThrow()
  })
})

describe('App removes the skeleton', () => {
  beforeEach(() => {
    localStorage.clear()
    // fresh launch: the app store is a module singleton shared by the tests in this file
    app.ready = false
    app.fatalError = null
  })

  it('only after the first workspace and its collections have loaded', async () => {
    const backend = createMockBackend({ latencyMs: 0 })
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // listCollections is held back: the skeleton must outlive mount and the workspace list.
    window.slinger = { ...backend, listCollections: (id: string) => gate.then(() => backend.listCollections(id)) }
    window.__slingerMock = backend
    render(App)
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'listWorkspaces')).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(bootSkeletonVisible()).toBe(true)
    expect(screen.queryByText('Demo API')).toBeNull()

    release()
    await screen.findByText('Demo API')
    await waitFor(() => expect(bootSkeletonVisible()).toBe(false))
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument()
  })

  it('when startup fails, so the error is visible', async () => {
    const backend = createMockBackend({ latencyMs: 0 })
    backend.failAlways('listWorkspaces', { code: 'io_error', message: 'database is locked' })
    window.slinger = backend
    window.__slingerMock = backend
    render(App)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Slinger could not start')
    expect(alert).toHaveTextContent('database is locked')
    expect(bootSkeletonVisible()).toBe(false)
  })
})
