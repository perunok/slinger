import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/svelte'
import type { HttpRequestInput } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import CookiesDialog from './CookiesDialog.svelte'
import { formInput, fromLocalInput, groupCookies, newForm, parseDomainList, toLocalInput } from './cookieView'

let backend: ReturnType<typeof createMockBackend>
let ws: string

const send = (url: string, over: Partial<HttpRequestInput> = {}) =>
  backend.executeHttpRequest({ method: 'GET', url, headers: [], auth: { kind: 'none' }, body: { mode: 'none' }, workspaceId: ws, ...over })

beforeEach(async () => {
  backend = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = backend
  await app.init()
  ws = app.workspaceId!
})
afterEach(() => cleanup())

describe('mock backend jar (parity with main)', () => {
  it('stores Set-Cookie and sends the cookies with the next request; off neither sends nor stores', async () => {
    await send('https://mock.slinger.local/cookies')
    const echoed = await send('https://mock.slinger.local/echo')
    expect(JSON.parse(echoed.bodyText!).headers.Cookie).toBe('session=abc123; theme=dark')
    const off = await send('https://mock.slinger.local/echo', { cookies: 'off' })
    expect(JSON.parse(off.bodyText!).headers.Cookie).toBeUndefined()
    const mine = await send('https://mock.slinger.local/echo', { headers: [{ key: 'Cookie', value: 'session=mine' }] })
    expect(JSON.parse(mine.bodyText!).headers.Cookie).toBe('session=mine; theme=dark')
    const list = await backend.listCookies(ws)
    expect(list.map((c) => [c.name, c.domain, c.hostOnly, c.httpOnly])).toEqual([
      ['session', 'mock.slinger.local', true, true],
      ['theme', 'mock.slinger.local', true, false],
    ])
    expect(list[0]).not.toHaveProperty('value')
    await backend.clearCookies(ws, null)
    await send('https://mock.slinger.local/cookies', { cookies: 'off' })
    expect(await backend.listCookies(ws)).toEqual([])
  })

  it('redactSecrets hides jar values unless the response set them; a deleted workspace loses its jar', async () => {
    await send('https://mock.slinger.local/cookies')
    const [hidden] = await backend.redactSecrets({ scriptSessionId: null, oauth2TokenKey: null, texts: ['abc123 dark'], cookies: { workspaceId: ws, responseSetCookies: ['theme=dark'] } })
    // "dark" is 4 characters but the response set it; "abc123" is the jar's.
    expect(hidden).toBe('[hidden] dark')
    const other = await backend.createWorkspace('Other')
    await backend.upsertCookie({ workspaceId: other.id, name: 'x', value: 'y', domain: 'example.com', hostOnly: true, path: '/', expiresAt: null, secure: false, httpOnly: false, sameSite: null })
    await backend.deleteWorkspace(other.id)
    await expect(backend.listCookies(other.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses what main refuses', async () => {
    const base = { workspaceId: ws, name: 'a', value: 'b', domain: 'co.uk', hostOnly: false, path: '/', expiresAt: null, secure: false, httpOnly: false, sameSite: null } as const
    await expect(backend.upsertCookie(base)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(backend.upsertCookie({ ...base, domain: 'example.com', value: 'a;b' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(backend.setCookieScriptDomains(ws, ['com'])).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await backend.setCookieScriptDomains(ws, ['.Example.com', 'example.com'])).toEqual(['example.com'])
  })
})

describe('Cookies dialog', () => {
  it('lists by domain with masked values; reveal, edit, delete one, delete a domain, clear all', async () => {
    await send('https://mock.slinger.local/cookies')
    await backend.upsertCookie({ workspaceId: ws, name: 'tok', value: 'other-value', domain: 'api.example.com', hostOnly: true, path: '/', expiresAt: null, secure: true, httpOnly: false, sameSite: 'Strict' })
    ui.cookiesOpen = true
    render(CookiesDialog)
    const mock = await screen.findByRole('region', { name: 'Cookies of mock.slinger.local' })
    expect(within(mock).getAllByTestId('cookie-row')).toHaveLength(2)
    expect(screen.getAllByTestId('cookie-value').map((v) => v.textContent)).toEqual(['••••••••', '••••••••', '••••••••'])

    await fireEvent.click(screen.getByRole('button', { name: 'Reveal value of session' }))
    await waitFor(() => expect(within(mock).getAllByTestId('cookie-value')[0]).toHaveTextContent('abc123'))

    // Search narrows to matching domains / names.
    await fireEvent.input(screen.getByLabelText('Search cookies'), { target: { value: 'example' } })
    expect(screen.queryByRole('region', { name: 'Cookies of mock.slinger.local' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Cookies of api.example.com' })).toBeInTheDocument()
    await fireEvent.input(screen.getByLabelText('Search cookies'), { target: { value: '' } })

    // Edit without touching the value keeps it.
    await fireEvent.click(screen.getByRole('button', { name: 'Edit tok' }))
    const form = screen.getByRole('form', { name: 'Edit cookie' })
    await fireEvent.input(within(form).getByLabelText('Path'), { target: { value: '/v2' } })
    await fireEvent.click(within(form).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Edit cookie' })).toBeNull())
    const tok = (await backend.listCookies(ws)).find((c) => c.name === 'tok')!
    expect(tok).toMatchObject({ path: '/v2', secure: true, sameSite: 'Strict' })
    expect(await backend.revealCookie(tok.id)).toBe('other-value')

    await fireEvent.click(screen.getByRole('button', { name: 'Delete theme' }))
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Cookies of mock.slinger.local' })).getAllByTestId('cookie-row')).toHaveLength(1))

    await fireEvent.click(screen.getByRole('button', { name: 'Delete the cookies of mock.slinger.local' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Cookies of mock.slinger.local' })).toBeNull())

    await fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await screen.findByText(/No cookies yet/)
    expect(await backend.listCookies(ws)).toEqual([])
  })

  it('adds a cookie, shows errors from main, and saves the scripts allow-list', async () => {
    render(CookiesDialog)
    await screen.findByText(/No cookies yet/)
    await fireEvent.click(screen.getByRole('button', { name: 'Add cookie' }))
    const form = screen.getByRole('form', { name: 'Add cookie' })
    await fireEvent.input(within(form).getByLabelText('Name'), { target: { value: 'sid' } })
    await fireEvent.input(within(form).getByLabelText('Value'), { target: { value: 'v1' } })
    await fireEvent.input(within(form).getByLabelText('Domain'), { target: { value: 'co.uk' } })
    await fireEvent.click(within(form).getByLabelText('Include subdomains'))
    await fireEvent.click(within(form).getByRole('button', { name: 'Add' }))
    expect(await within(form).findByRole('alert')).toHaveTextContent(/public suffix/)
    await fireEvent.input(within(form).getByLabelText('Domain'), { target: { value: 'Example.com' } })
    await fireEvent.click(within(form).getByRole('button', { name: 'Add' }))
    const region = await screen.findByRole('region', { name: 'Cookies of example.com' })
    expect(within(region).getByText('subdomains')).toBeInTheDocument()

    const domains = screen.getByLabelText('Domains scripts may access')
    await fireEvent.input(domains, { target: { value: 'api.example.com\n.Example.org' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save domains' }))
    await waitFor(() => expect((domains as HTMLTextAreaElement).value).toBe('api.example.com\nexample.org'))
    expect(await backend.getCookieScriptDomains(ws)).toEqual(['api.example.com', 'example.org'])
  })
})

describe('cookieView', () => {
  it('groups and searches, converts expiry, builds the input', () => {
    const c = (name: string, domain: string, path = '/') => ({ id: name, workspaceId: 'w', name, domain, hostOnly: true, path, expiresAt: null, secure: false, httpOnly: false, sameSite: null, createdAt: 0, updatedAt: 0 })
    const groups = groupCookies([c('b', 'z.com'), c('a', 'z.com'), c('x', 'a.com')], '')
    expect(groups.map((g) => [g.domain, g.cookies.map((x) => x.name)])).toEqual([
      ['a.com', ['x']],
      ['z.com', ['a', 'b']],
    ])
    expect(groupCookies([c('b', 'z.com'), c('x', 'a.com')], 'Z.C').map((g) => g.domain)).toEqual(['z.com'])
    const t = 1_900_000_020
    expect(fromLocalInput(toLocalInput(t))).toBe(t - (t % 60))
    expect(fromLocalInput('')).toBeNull()
    expect(formInput('w', { ...newForm('d.com'), name: 'n', value: null, subdomains: true, sameSite: 'Lax' })).toEqual({
      workspaceId: 'w',
      name: 'n',
      domain: 'd.com',
      hostOnly: false,
      path: '/',
      expiresAt: null,
      secure: false,
      httpOnly: false,
      sameSite: 'Lax',
    })
    expect(parseDomainList(' a.com, b.com\n\nc.com ')).toEqual(['a.com', 'b.com', 'c.com'])
  })
})
