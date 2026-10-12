import type { MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { hidesOnClose, trayIconFiles, trayMenuTemplate, type CloseContext } from '../lib/tray'

describe('closing to the tray', () => {
  const base: CloseContext = { closeToTray: true, quitting: false, reopening: false, sessionEnding: false }

  it('hides the window only when the user closes it with the setting on', () => {
    expect(hidesOnClose(base)).toBe(true)
    expect(hidesOnClose({ ...base, closeToTray: false })).toBe(false)
    expect(hidesOnClose({ ...base, quitting: true })).toBe(false) // Quit from the tray or the menu
    expect(hidesOnClose({ ...base, reopening: true })).toBe(false) // title bar change: a new window replaces it
    expect(hidesOnClose({ ...base, sessionEnding: true })).toBe(false) // logout / shutdown
  })

  it('tray menu: Open and Quit', () => {
    const open = vi.fn()
    const quit = vi.fn()
    const items = trayMenuTemplate({ open, quit })
    expect(items.map((i) => i.label ?? i.type)).toEqual(['Open Slinger', 'separator', 'Quit Slinger'])
    const click = (i: MenuItemConstructorOptions) => (i.click as unknown as () => void)()
    click(items[0]!)
    click(items[2]!)
    expect(open).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('lists running mock servers with Copy URL and Stop, sorted by port', () => {
    const copy = vi.fn()
    const stop = vi.fn()
    const items = trayMenuTemplate({
      open: vi.fn(),
      quit: vi.fn(),
      copyText: copy,
      stopMockServer: stop,
      mockServers: [
        { collectionId: 'b', collectionName: 'R&D API', port: 4011, url: 'http://127.0.0.1:4011' },
        { collectionId: 'a', collectionName: 'Shop', port: 4010, url: 'http://127.0.0.1:4010' },
      ],
    })
    expect(items.map((i) => i.label ?? i.type)).toEqual(['Open Slinger', 'separator', 'Mock servers', 'Shop · 4010', 'R&&D API · 4011', 'separator', 'Quit Slinger'])
    expect(items[2]!.enabled).toBe(false)
    const sub = items[4]!.submenu as MenuItemConstructorOptions[]
    expect(sub.map((i) => i.label)).toEqual(['Copy http://127.0.0.1:4011', 'Stop'])
    ;(sub[0]!.click as unknown as () => void)()
    ;(sub[1]!.click as unknown as () => void)()
    expect(copy).toHaveBeenCalledWith('http://127.0.0.1:4011')
    expect(stop).toHaveBeenCalledWith('b')
  })

  it('icons per platform: a macOS template image, 16 px (+32 px for HiDPI) on Windows, 32 px on Linux', () => {
    expect(trayIconFiles('darwin')).toEqual({ file: 'trayTemplate.png' })
    expect(trayIconFiles('win32')).toEqual({ file: 'tray-16.png', hiDpi: 'tray-32.png' })
    expect(trayIconFiles('linux')).toEqual({ file: 'tray-32.png' })
    // They ship from build/tray (electron-builder.yml extraResources -> resources/tray).
    for (const f of ['tray-16.png', 'tray-32.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
      expect(existsSync(join(__dirname, '..', '..', 'build', 'tray', f)), f).toBe(true)
    }
  })
})
