import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIpcApi } from '../ipc/api'
import {
  clampBounds,
  DEFAULT_BACKGROUND,
  normalizeCssColor,
  readWindowState,
  WINDOW_STATE_FILE,
  writeWindowState,
} from '../lib/windowState'
import { makeEnv, type TestEnv } from './helpers'

describe('normalizeCssColor', () => {
  it.each([
    ['#16181d', '#16181d'],
    ['#F4F5F7', '#f4f5f7'],
    ['#abc', '#aabbcc'],
    ['#abcd', '#aabbcc'],
    ['#11223344', '#112233'],
    ['  #16181d  ', '#16181d'],
    ['rgb(22, 24, 29)', '#16181d'],
    ['rgba(22, 24, 29, 0.5)', '#16181d'],
    ['rgb(22 24 29)', '#16181d'],
    ['rgb(22 24 29 / 50%)', '#16181d'],
    ['rgb(100%, 0%, 50%)', '#ff0080'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeCssColor(input)).toBe(expected)
  })

  it.each([
    '',
    'red',
    '#12',
    '#12345',
    '#gggggg',
    'rgb(256, 0, 0)',
    'rgb(-1, 0, 0)',
    'rgb(1, 2)',
    'rgb(1, 2, 3, 4, 5)',
    'rgb(1 2 3 / 4 / 5)',
    'rgb(1, 2, 3) ; background: url(x)',
    'hsl(0, 0%, 0%)',
    'var(--bg)',
    'rgb(1, 2, x)',
    'rgba(1, 2, 3, nope)',
  ])('rejects %j', (input) => {
    expect(normalizeCssColor(input)).toBeNull()
  })

  it('keeps DEFAULT_BACKGROUND in step with the light and dark themes in themes.css', () => {
    const css = readFileSync(new URL('../../src/styles/themes.css', import.meta.url), 'utf8')
    const bg = (theme: string) => new RegExp(`\\[data-theme='${theme}'\\]\\s*\\{[^}]*?--bg:\\s*(#[0-9a-f]{6})`).exec(css)?.[1]
    expect(DEFAULT_BACKGROUND).toEqual({ light: bg('light'), dark: bg('dark') })
  })
})

describe('window-state.json', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'slinger-winstate-'))
    file = join(dir, WINDOW_STATE_FILE)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips bounds, maximised and background colour', () => {
    const state = { bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: true, backgroundColor: '#16181d' }
    expect(writeWindowState(file, state)).toBe(true)
    expect(readWindowState(file)).toEqual(state)
  })

  it('creates the directory and leaves no temp file behind', () => {
    const nested = join(dir, 'a', 'b', WINDOW_STATE_FILE)
    expect(writeWindowState(nested, { maximized: false })).toBe(true)
    expect(readWindowState(nested)).toEqual({ maximized: false })
  })

  it('ignores a missing or corrupt file', () => {
    expect(readWindowState(file)).toEqual({})
    for (const junk of ['{not json', '', 'null', '[]', '42', '"x"']) {
      writeFileSync(file, junk)
      expect(readWindowState(file), junk).toEqual({})
    }
  })

  it('keeps the valid fields and drops invalid ones', () => {
    writeFileSync(file, JSON.stringify({ bounds: { x: 'a', y: 0, width: 10, height: 10 }, maximized: 'yes', backgroundColor: '#16181d', extra: 1 }))
    expect(readWindowState(file)).toEqual({ backgroundColor: '#16181d' })
    writeFileSync(file, JSON.stringify({ bounds: { x: 0, y: 0, width: 800, height: 600 }, backgroundColor: 'url(javascript:alert(1))' }))
    expect(readWindowState(file)).toEqual({ bounds: { x: 0, y: 0, width: 800, height: 600 } })
    writeFileSync(file, JSON.stringify({ bounds: { x: 0, y: 0, width: 0, height: 600 }, backgroundColor: 'rgb(1, 2, 3)' }))
    expect(readWindowState(file)).toEqual({ backgroundColor: '#010203' })
  })

  it('reports a failed write instead of throwing', () => {
    writeFileSync(join(dir, 'blocker'), 'x')
    expect(writeWindowState(join(dir, 'blocker', WINDOW_STATE_FILE), {})).toBe(false)
  })
})

describe('clampBounds', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 }
  const right = { x: 1920, y: 0, width: 1280, height: 1000 }
  const min = { width: 900, height: 600 }

  it('keeps bounds that fit', () => {
    const b = { x: 100, y: 50, width: 1400, height: 900 }
    expect(clampBounds(b, [primary], min)).toEqual(b)
  })

  it('forgets a window that is on no current display (e.g. an unplugged monitor)', () => {
    expect(clampBounds({ x: 2500, y: 100, width: 1200, height: 800 }, [primary], min)).toBeNull()
    expect(clampBounds({ x: 1915, y: 100, width: 1200, height: 800 }, [primary], min)).toBeNull() // 5 px visible
    expect(clampBounds({ x: 0, y: 0, width: 100, height: 100 }, [], min)).toBeNull()
  })

  it('moves a partly off-screen window fully inside', () => {
    expect(clampBounds({ x: 1500, y: -200, width: 1400, height: 900 }, [primary], min)).toEqual({ x: 520, y: 0, width: 1400, height: 900 })
    expect(clampBounds({ x: -300, y: 500, width: 1400, height: 900 }, [primary], min)).toEqual({ x: 0, y: 140, width: 1400, height: 900 })
  })

  it('shrinks a window larger than its display and grows one below the minimum size', () => {
    expect(clampBounds({ x: 0, y: 0, width: 3000, height: 2000 }, [primary], min)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
    expect(clampBounds({ x: 10, y: 10, width: 300, height: 200 }, [primary], min)).toEqual({ x: 10, y: 10, width: 900, height: 600 })
    // a display smaller than the minimum size wins over the minimum
    expect(clampBounds({ x: 0, y: 0, width: 1400, height: 900 }, [{ x: 0, y: 0, width: 800, height: 500 }], min)).toEqual({ x: 0, y: 0, width: 800, height: 500 })
  })

  it('uses the display the window overlaps most', () => {
    expect(clampBounds({ x: 1800, y: 100, width: 1200, height: 800 }, [primary, right], min)).toEqual({ x: 1920, y: 100, width: 1200, height: 800 })
    expect(clampBounds({ x: 1000, y: 100, width: 1200, height: 800 }, [primary, right], min)).toEqual({ x: 720, y: 100, width: 1200, height: 800 })
  })
})

describe('setWindowBackground (IPC)', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.cleanup())

  it('validates the colour and hands main a normalised #rrggbb', async () => {
    const seen: string[] = []
    const api = createIpcApi(env.core, {
      appVersion: '0',
      openExternal: async () => {},
      chooseDirectory: async () => null,
      pickFile: async () => null,
      setWindowBackground: (c) => void seen.push(c),
    })
    await api.setWindowBackground('#16181D')
    await api.setWindowBackground('rgb(244, 245, 247)')
    expect(seen).toEqual(['#16181d', '#f4f5f7'])
    for (const bad of [['red'], ['#12'], ['x'.repeat(100)], [42], [], ['#fff', '#000'], ['rgb(1,2,3); x']]) {
      await expect((api.setWindowBackground as (...a: unknown[]) => Promise<void>)(...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(seen).toHaveLength(2)
  })

  it('is a no-op without a window (tests, headless)', async () => {
    await expect(env.api.setWindowBackground('#ffffff')).resolves.toBeUndefined()
  })
})
