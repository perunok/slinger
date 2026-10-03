import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TitleBarOverlayStyle, TitleBarStyle, WindowChrome } from '../../shared/types'
import { createIpcApi, type WindowControls } from '../ipc/api'
import { DEFAULT_TITLE_BAR_COLORS, menuPoint, overlayOptions, titleBarWindowOptions } from '../lib/titleBar'
import { makeEnv, type TestEnv } from './helpers'

const colors = DEFAULT_TITLE_BAR_COLORS.dark

describe('titleBarWindowOptions', () => {
  it('leaves the window alone with the system title bar', () => {
    for (const platform of ['linux', 'win32', 'darwin']) expect(titleBarWindowOptions('system', platform, colors)).toEqual({})
  })

  it('Windows/Linux: hidden title bar with the system buttons drawn over the top bar in its colours', () => {
    for (const platform of ['linux', 'win32', 'freebsd']) {
      expect(titleBarWindowOptions('custom', platform, colors)).toEqual({
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#1e2127', symbolColor: '#e4e7ec', height: 40 },
      })
    }
    expect(titleBarWindowOptions('custom', 'linux', colors, 48)).toMatchObject({ titleBarOverlay: { height: 48 } })
  })

  it('macOS: traffic lights centred in the bar, overlay variables on', () => {
    expect(titleBarWindowOptions('custom', 'darwin', colors)).toEqual({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 14, y: 13 },
      titleBarOverlay: true,
    })
  })
})

describe('overlayOptions / menuPoint', () => {
  it('scales the bar height by the page zoom and keeps it within bounds', () => {
    expect(overlayOptions(colors, 40, 1).height).toBe(40)
    expect(overlayOptions(colors, 40, 1.44).height).toBe(58)
    expect(overlayOptions(colors, 40, 0.1).height).toBe(16)
    expect(overlayOptions(colors, 400, 2).height).toBe(200)
    expect(overlayOptions(colors, 40, Number.NaN).height).toBe(40)
  })

  it('converts a CSS point to window coordinates', () => {
    expect(menuPoint(10, 40, 1)).toEqual({ x: 10, y: 40 })
    expect(menuPoint(10, 40, 1.2)).toEqual({ x: 12, y: 48 })
    expect(menuPoint(10, 40, 0)).toEqual({ x: 10, y: 40 })
  })
})

describe('window chrome (IPC)', () => {
  let env: TestEnv
  beforeEach(() => {
    env = makeEnv()
  })
  afterEach(() => env.cleanup())

  function withWindow() {
    const calls: unknown[][] = []
    let preferred: TitleBarStyle = 'custom'
    const chrome = (): WindowChrome => ({ platform: 'linux', titleBar: 'custom', preferredTitleBar: preferred })
    const window: WindowControls = {
      chrome,
      setTitleBarStyle: (s) => {
        preferred = s
        return chrome()
      },
      reopen: () => void calls.push(['reopen']),
      setTitleBarOverlay: (s: TitleBarOverlayStyle) => void calls.push(['overlay', s]),
      showAppMenu: (x, y) => void calls.push(['menu', x, y]),
    }
    const api = createIpcApi(env.core, { appVersion: '0', openExternal: async () => {}, chooseDirectory: async () => null, pickFile: async () => null, window })
    return { api, calls }
  }
  const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args)

  it('reads and saves the title bar preference', async () => {
    const { api } = withWindow()
    expect(await api.getWindowChrome()).toEqual({ platform: 'linux', titleBar: 'custom', preferredTitleBar: 'custom' })
    expect(await api.setTitleBarStyle('system')).toEqual({ platform: 'linux', titleBar: 'custom', preferredTitleBar: 'system' })
    for (const bad of [['frameless'], [], ['custom', 'x'], [true]]) {
      await expect(call(api.setTitleBarStyle, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('validates overlay colours and menu points before main sees them', async () => {
    const { api, calls } = withWindow()
    await api.setTitleBarOverlay({ color: 'rgb(255, 255, 255)', symbolColor: '#1C2330', height: 40 })
    await api.showAppMenu(12.5, 40)
    await api.reopenWindow()
    expect(calls).toEqual([['overlay', { color: '#ffffff', symbolColor: '#1c2330', height: 40 }], ['menu', 12.5, 40], ['reopen']])
    for (const bad of [
      [{ color: 'red', symbolColor: '#000', height: 40 }],
      [{ color: '#fff', symbolColor: '#000', height: 4 }],
      [{ color: '#fff', symbolColor: '#000', height: 40, extra: 1 }],
      [{ color: '#fff', symbolColor: 'url(x)', height: 40 }],
    ]) {
      await expect(call(api.setTitleBarOverlay, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    for (const bad of [[-1, 0], [0], [Number.NaN, 0], ['1', '2'], [0, 1e9]]) {
      await expect(call(api.showAppMenu, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(calls).toHaveLength(3)
  })

  it('without a window: reading/saving fails with io_error, cosmetic calls are no-ops', async () => {
    await expect(env.api.getWindowChrome()).rejects.toMatchObject({ code: 'io_error' })
    await expect(env.api.setTitleBarStyle('system')).rejects.toMatchObject({ code: 'io_error' })
    await expect(env.api.setTitleBarOverlay({ color: '#fff', symbolColor: '#000', height: 40 })).resolves.toBeUndefined()
    await expect(env.api.showAppMenu(0, 0)).resolves.toBeUndefined()
  })
})
