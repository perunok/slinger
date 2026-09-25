import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { MENU_COMMANDS, menuCommandSchema, parseMenuCommand, type MenuCommand } from '../../shared/menu'
import { MENU_COMMAND_CHANNEL, IPC_EVENT_CHANNELS } from '../../shared/ipc-contract'
import { buildAppMenuTemplate, deliverMenuCommand, HELP_URLS, nextZoomLevel, type AppMenuOptions, type MenuCommandTarget } from '../lib/appMenu'

type Item = MenuItemConstructorOptions

function build(platform: NodeJS.Platform, extra: Partial<AppMenuOptions> = {}) {
  const send = vi.fn<(c: MenuCommand) => void>()
  const openExternal = vi.fn<(u: string) => void>()
  const zoom = vi.fn()
  const template = buildAppMenuTemplate({ platform, isPackaged: true, send, openExternal, zoom, ...extra })
  return { template, send, openExternal, zoom }
}

const plain = (label?: string) => (label ?? '').replace(/&/g, '')
const subOf = (item: Item | undefined): Item[] => (Array.isArray(item?.submenu) ? (item.submenu as Item[]) : [])
const top = (template: Item[], label: string) => template.find((i) => plain(i.label) === label)
const find = (items: Item[], label: string) => items.find((i) => i.label === label)
function all(items: Item[]): Item[] {
  return items.flatMap((i) => [i, ...all(subOf(i))])
}
const click = (item: Item | undefined) => (item?.click as unknown as () => void)()

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux']

describe('application menu template', () => {
  it('macOS: app menu, File, Edit, View, Window, Help', () => {
    const { template } = build('darwin')
    expect(template.map((i) => plain(i.label))).toEqual(['Slinger', 'File', 'Edit', 'View', 'Window', 'Help'])
    const app = subOf(top(template, 'Slinger'))
    expect(app.map((i) => i.label ?? i.role ?? i.type)).toEqual([
      'About Slinger', 'separator', 'Settings…', 'separator', 'services', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit',
    ])
    expect(find(app, 'Settings…')?.accelerator).toBe('CmdOrCtrl+,')
    const edit = subOf(top(template, 'Edit')).map((i) => i.role).filter(Boolean)
    expect(edit).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
    // Settings and Quit live in the app menu on macOS, not in File; About is not repeated under Help.
    expect(all(subOf(top(template, 'File'))).some((i) => i.role === 'quit' || i.label === 'Settings…')).toBe(false)
    expect(find(subOf(top(template, 'Help')), 'About Slinger')).toBeUndefined()
  })

  it.each(['win32', 'linux'] as const)('%s: File, Edit, View, Help with About under Help', (platform) => {
    const { template } = build(platform)
    expect(template.map((i) => plain(i.label))).toEqual(['File', 'Edit', 'View', 'Help'])
    expect(template.every((i) => i.label?.startsWith('&'))).toBe(true) // Alt mnemonics
    const file = subOf(top(template, 'File'))
    expect(file.map((i) => i.label ?? i.role ?? i.type)).toEqual([
      'New Request', 'Close Tab', 'separator', 'Import…', 'Export Collection…', 'separator', 'Settings…', 'separator', 'quit',
    ])
    const edit = subOf(top(template, 'Edit')).map((i) => i.role).filter(Boolean)
    expect(edit).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'selectAll'])
    const help = subOf(top(template, 'Help'))
    expect(help.filter((i) => i.label).map((i) => i.label)).toEqual([
      'User Guide', 'Keyboard Shortcuts', 'Release Notes', 'Report an Issue', 'View License', 'About Slinger',
    ])
  })

  it.each(PLATFORMS)('%s: View has zoom and full screen; Reload and DevTools only in development', (platform) => {
    const packaged = all(build(platform).template)
    expect(packaged.some((i) => i.role === 'reload' || i.role === 'forceReload' || i.role === 'toggleDevTools')).toBe(false)
    const view = subOf(top(build(platform).template, 'View'))
    expect(view.filter((i) => i.label).map((i) => [i.label, i.accelerator])).toEqual([
      ['Actual Size', 'CmdOrCtrl+0'], ['Zoom In', 'CmdOrCtrl+='], ['Zoom Out', 'CmdOrCtrl+-'],
    ])
    expect(view.some((i) => i.role === 'togglefullscreen')).toBe(true)
    for (const opts of [{ isPackaged: false }, { isPackaged: true, devTools: true }]) {
      const roles = all(build(platform, opts).template).map((i) => i.role)
      expect(roles).toEqual(expect.arrayContaining(['reload', 'toggleDevTools']))
    }
  })

  it.each(PLATFORMS)('%s: no Electron default help links; every link is a Slinger URL', (platform) => {
    const { template, openExternal } = build(platform)
    const items = all(template)
    expect(JSON.stringify(items.map((i) => i.label))).not.toMatch(/electron|Learn More|Documentation|Community|Search Issues/i)
    for (const label of ['User Guide', 'Release Notes', 'Report an Issue', 'View License']) click(find(items, label))
    expect(openExternal.mock.calls.map((c) => c[0])).toEqual([HELP_URLS.userGuide, HELP_URLS.releaseNotes, HELP_URLS.reportIssue, HELP_URLS.license])
    for (const url of openExternal.mock.calls.map((c) => c[0])) expect(url).toMatch(/^https:\/\/github\.com\/perunok\/slinger\//)
  })

  it.each(PLATFORMS)('%s: Ctrl/Cmd+W never closes the window', (platform) => {
    const items = all(build(platform).template)
    const closeW = items.filter((i) => typeof i.accelerator === 'string' && /^(CmdOrCtrl|CommandOrControl|Cmd|Command|Ctrl|Control)\+W$/i.test(i.accelerator))
    expect(closeW.map((i) => i.label)).toEqual(['Close Tab'])
    // The only Ctrl/Cmd+W item sends our command and is label-only (the renderer owns the key).
    expect(closeW[0]!.role).toBeUndefined()
    expect(closeW[0]!.registerAccelerator).toBe(false)
    for (const i of items.filter((i) => i.role === 'close' || i.role === 'quit')) {
      expect(i.accelerator ?? '', String(i.role)).not.toMatch(/^(CmdOrCtrl|Cmd|Ctrl)\+W$/i)
    }
    if (platform === 'darwin') expect(find(items, 'Close Window')).toMatchObject({ role: 'close', accelerator: 'Shift+CmdOrCtrl+W' })
    else expect(items.some((i) => i.role === 'close')).toBe(false)
  })

  it.each(PLATFORMS)('%s: accelerators shared with renderer shortcuts are label-only', (platform) => {
    const items = all(build(platform).template)
    // src/app/shortcuts.ts: t (new tab), w (close tab), ',' (settings), '/' (shortcuts), plus Enter/S/K/Tab (not in the menu).
    const rendererKeys = new Set(['T', 'W', ',', '/', 'Enter', 'S', 'K', 'Tab'])
    for (const i of items) {
      if (typeof i.accelerator !== 'string') continue
      const m = /^CmdOrCtrl\+(.+)$/.exec(i.accelerator)
      if (m && rendererKeys.has(m[1]!)) expect(i.registerAccelerator, i.label).toBe(false)
    }
    const shared = items.filter((i) => i.registerAccelerator === false).map((i) => i.accelerator)
    expect(new Set(shared)).toEqual(new Set(['CmdOrCtrl+T', 'CmdOrCtrl+W', 'CmdOrCtrl+,', 'CmdOrCtrl+/']))
  })

  it.each(PLATFORMS)('%s: every command item sends its command', (platform) => {
    const { template, send, zoom } = build(platform)
    const items = all(template)
    const expected: Array<[string, MenuCommand]> = [
      ['New Request', 'newRequest'],
      ['Close Tab', 'closeTab'],
      ['Import…', 'import'],
      ['Export Collection…', 'exportCollection'],
      ['Settings…', 'settings'],
      ['About Slinger', 'about'],
      ['Keyboard Shortcuts', 'shortcuts'],
    ]
    for (const [label, command] of expected) {
      send.mockClear()
      click(find(items, label))
      expect(send.mock.calls, label).toEqual([[command]])
    }
    expect(new Set(expected.map((e) => e[1]))).toEqual(new Set(MENU_COMMANDS))
    for (const [label, dir] of [['Actual Size', 'reset'], ['Zoom In', 'in'], ['Zoom Out', 'out']] as const) {
      click(find(items, label))
      expect(zoom).toHaveBeenLastCalledWith(dir)
    }
  })

  it('New Request uses the same key as the renderer (Ctrl/Cmd+T)', () => {
    for (const platform of PLATFORMS) {
      expect(find(all(build(platform).template), 'New Request')?.accelerator).toBe('CmdOrCtrl+T')
    }
  })
})

describe('menu commands', () => {
  it('travel on their own push channel', () => {
    expect(MENU_COMMAND_CHANNEL).toBe('menu:command')
    expect(IPC_EVENT_CHANNELS).toContain('menu:command')
  })

  it('zod accepts the known names and rejects anything else', () => {
    for (const c of MENU_COMMANDS) expect(parseMenuCommand(c)).toBe(c)
    for (const junk of ['quit', 'openDevTools', '', 'NEWREQUEST', null, undefined, 42, {}, ['about']]) {
      expect(parseMenuCommand(junk), String(junk)).toBeNull()
      expect(menuCommandSchema.safeParse(junk).success).toBe(false)
    }
  })

  it('zoom steps by half a level, resets to 0 and stays in range', () => {
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0.5, 'out')).toBe(0)
    expect(nextZoomLevel(3.3, 'reset')).toBe(0)
    expect(nextZoomLevel(5, 'in')).toBe(5)
    expect(nextZoomLevel(-5, 'out')).toBe(-5)
  })
})

describe('deliverMenuCommand', () => {
  const trusted = (url: string) => url.startsWith('app://slinger/')
  function fakeWindow(url = 'app://slinger/index.html', opts: { destroyed?: boolean; minimized?: boolean } = {}) {
    const send = vi.fn()
    const restore = vi.fn()
    const win: MenuCommandTarget = {
      isDestroyed: () => !!opts.destroyed,
      isMinimized: () => !!opts.minimized,
      restore,
      focus: vi.fn(),
      webContents: { isDestroyed: () => false, getURL: () => url, send },
    }
    return { win, send, restore }
  }

  it.each(MENU_COMMANDS)('sends %s on menu:command to the trusted main window', (command) => {
    const { win, send } = fakeWindow()
    expect(deliverMenuCommand(win, command, trusted)).toBe(true)
    expect(send.mock.calls).toEqual([['menu:command', command]])
  })

  it('restores a minimised window first', () => {
    const { win, restore } = fakeWindow(undefined, { minimized: true })
    deliverMenuCommand(win, 'about', trusted)
    expect(restore).toHaveBeenCalled()
  })

  it('drops the command for no window, a destroyed window, a foreign page or an unknown name', () => {
    expect(deliverMenuCommand(null, 'about', trusted)).toBe(false)
    const destroyed = fakeWindow(undefined, { destroyed: true })
    expect(deliverMenuCommand(destroyed.win, 'about', trusted)).toBe(false)
    const foreign = fakeWindow('https://evil.example/')
    expect(deliverMenuCommand(foreign.win, 'about', trusted)).toBe(false)
    const ok = fakeWindow()
    expect(deliverMenuCommand(ok.win, 'openDevTools' as MenuCommand, trusted)).toBe(false)
    for (const w of [destroyed, foreign, ok]) expect(w.send).not.toHaveBeenCalled()
  })
})
