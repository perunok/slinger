import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TitleBarStyle, WindowAction, WindowChrome } from '../../shared/types'
import { createIpcApi, type WindowControls } from '../ipc/api'
import { menuPoint, titleBarWindowOptions } from '../lib/titleBar'
import { makeEnv, type TestEnv } from './helpers'

describe('titleBarWindowOptions', () => {
  it('leaves the window alone with the system title bar', () => {
    for (const platform of ['linux', 'win32', 'darwin']) expect(titleBarWindowOptions('system', platform)).toEqual({})
  })

  it('Windows/Linux: no system title bar and no overlay: the page draws its own window buttons', () => {
    for (const platform of ['linux', 'win32', 'freebsd']) expect(titleBarWindowOptions('custom', platform)).toEqual({ titleBarStyle: 'hidden' })
  })

  it('macOS: traffic lights centred in the bar, overlay variables on', () => {
    expect(titleBarWindowOptions('custom', 'darwin')).toEqual({ titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 }, titleBarOverlay: true })
    expect(titleBarWindowOptions('custom', 'darwin', 48)).toMatchObject({ trafficLightPosition: { x: 14, y: 17 } })
  })
})

describe('menuPoint', () => {
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
    let closeToTray = true
    const chrome = (): WindowChrome => ({ platform: 'linux', titleBar: 'custom', preferredTitleBar: preferred, closeToTray, state: { maximized: false, fullScreen: false, focused: true } })
    const window: WindowControls = {
      chrome,
      setTitleBarStyle: (s) => {
        preferred = s
        return chrome()
      },
      setCloseToTray: (on) => {
        closeToTray = on
        return chrome()
      },
      reopen: () => void calls.push(['reopen']),
      control: (action: WindowAction) => void calls.push(['control', action]),
      showAppMenu: (x, y) => void calls.push(['menu', x, y]),
    }
    const api = createIpcApi(env.core, { appVersion: '0', openExternal: async () => {}, chooseDirectory: async () => null, pickFile: async () => null, window })
    return { api, calls }
  }
  const call = (fn: unknown, ...args: unknown[]) => (fn as (...a: unknown[]) => Promise<unknown>)(...args)

  it('reads and saves the title bar preference, with the window state', async () => {
    const { api } = withWindow()
    expect(await api.getWindowChrome()).toEqual({ platform: 'linux', titleBar: 'custom', preferredTitleBar: 'custom', closeToTray: true, state: { maximized: false, fullScreen: false, focused: true } })
    expect(await api.setTitleBarStyle('system')).toMatchObject({ preferredTitleBar: 'system' })
    for (const bad of [['frameless'], [], ['custom', 'x'], [true]]) {
      await expect(call(api.setTitleBarStyle, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
  })

  it('saves the close-to-tray preference (a boolean only)', async () => {
    const { api } = withWindow()
    expect(await api.setCloseToTray(false)).toMatchObject({ closeToTray: false })
    expect(await api.getWindowChrome()).toMatchObject({ closeToTray: false })
    for (const bad of [['false'], [], [true, true], [1]]) {
      await expect(call(api.setCloseToTray, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(await api.getWindowChrome()).toMatchObject({ closeToTray: false })
  })

  it('validates window actions and menu points before main sees them', async () => {
    const { api, calls } = withWindow()
    for (const action of ['minimize', 'toggleMaximize', 'close'] as const) await api.windowControl(action)
    await api.showAppMenu(12.5, 40)
    await api.reopenWindow()
    expect(calls).toEqual([['control', 'minimize'], ['control', 'toggleMaximize'], ['control', 'close'], ['menu', 12.5, 40], ['reopen']])
    for (const bad of [['maximize'], [], ['close', 'now'], [1]]) {
      await expect(call(api.windowControl, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    for (const bad of [[-1, 0], [0], [Number.NaN, 0], ['1', '2'], [0, 1e9]]) {
      await expect(call(api.showAppMenu, ...bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(calls).toHaveLength(5)
  })

  it('without a window: reading/saving fails with io_error, window actions are no-ops', async () => {
    await expect(env.api.getWindowChrome()).rejects.toMatchObject({ code: 'io_error' })
    await expect(env.api.setTitleBarStyle('system')).rejects.toMatchObject({ code: 'io_error' })
    await expect(env.api.setCloseToTray(false)).rejects.toMatchObject({ code: 'io_error' })
    await expect(env.api.windowControl('close')).resolves.toBeUndefined()
    await expect(env.api.showAppMenu(0, 0)).resolves.toBeUndefined()
  })
})
