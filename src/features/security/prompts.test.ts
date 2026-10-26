import { cleanup, render, screen } from '@testing-library/svelte'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { app } from '../../app/state.svelte'
import { resolveOAuth2Config } from '../../lib/oauth2'
import { newDraft, parseDocument } from '../../lib/request'
import { executeDraft } from '../requests/execute'
import { setupSync, teardownSync } from '../sync/testUtils'
import { securityPrompts } from './prompts.svelte'
import SecurityPromptHost from './SecurityPromptHost.svelte'

beforeEach(async () => {
  await setupSync()
  securityPrompts.queue = []
})
afterEach(() => {
  cleanup()
  for (const p of securityPrompts.queue) securityPrompts.answer(p.id, false)
  teardownSync()
})

const IMPORT = JSON.stringify({
  info: { name: 'Shared with me', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  event: [{ listen: 'prerequest', script: { exec: ['console.log(1)'] } }],
  item: [
    { name: 'One', request: { method: 'GET', url: 'https://mock.slinger.local/json' } },
    { name: 'Two', request: { method: 'GET', url: 'https://mock.slinger.local/text' } },
  ],
})

async function imported() {
  const res = await window.slinger.importPostmanCollection(app.workspaceId!, IMPORT)
  await app.reloadCollections()
  return res
}
const ctxOf = (r: { id: string; collectionId: string; folderId: string | null }) => ({ workspaceId: app.workspaceId!, requestId: r.id, collectionId: r.collectionId, folderId: r.folderId })
const nextPrompt = async () => {
  for (let i = 0; i < 100 && !securityPrompts.current; i++) await new Promise((r) => setTimeout(r, 5))
  return securityPrompts.current!
}

describe('script trust (the window asks once per collection)', () => {
  it('asks before running an imported collection’s scripts; allowed once, its other requests run without asking', async () => {
    const res = await imported()
    const [one, two] = res.requests
    const sending = executeDraft(parseDocument(one!), ctxOf(one!))
    const p = await nextPrompt()
    expect(p.message).toContain('Shared with me')
    // A second send of the same collection waits for the same answer.
    const sending2 = executeDraft(parseDocument(two!), ctxOf(two!))
    await new Promise((r) => setTimeout(r, 10))
    expect(securityPrompts.queue).toHaveLength(1)
    securityPrompts.answer(p.id, true)
    expect((await sending).ok).toBe(true)
    expect((await sending2).ok).toBe(true)
    expect((await executeDraft(parseDocument(one!), ctxOf(one!))).ok).toBe(true)
    expect(securityPrompts.queue).toHaveLength(0)
  })

  it('declined: nothing is sent and the outcome says why', async () => {
    const res = await imported()
    const one = res.requests[0]!
    const sending = executeDraft(parseDocument(one), ctxOf(one))
    securityPrompts.answer((await nextPrompt()).id, false)
    const out = await sending
    expect(out).toMatchObject({ ok: false, kind: 'script' })
    expect(!out.ok && out.error).toMatch(/were not allowed/)
  })

  it('an assistant’s send is refused instead of asking', async () => {
    const one = (await imported()).requests[0]!
    const out = await executeDraft(parseDocument(one), { ...ctxOf(one), source: 'mcp' })
    expect(out).toMatchObject({ ok: false, kind: 'script' })
    expect(securityPrompts.queue).toHaveLength(0)
  })
})

describe('OAuth 2.0 token origins', () => {
  it('asks before a stored token goes to a new origin; allowed, it is sent', async () => {
    const d = newDraft({ name: 'O', url: 'https://mock.slinger.local/echo' })
    d.auth = {
      ...d.auth,
      kind: 'oauth2',
      oauth2: { ...d.auth.oauth2, grantType: 'client_credentials', accessTokenUrl: 'https://auth.example.test/token', clientId: 'app', addTokenTo: 'header', headerPrefix: 'Bearer' },
    }
    await window.slinger.getOAuth2Token(resolveOAuth2Config(d.auth.oauth2, app.workspaceId!, (t) => t))
    const ctx = { workspaceId: app.workspaceId! }
    expect((await executeDraft(d, ctx)).ok).toBe(true)
    const moved = { ...d, url: 'http://127.0.0.1:9/echo' }
    // An assistant is told to ask the user; nothing is asked.
    const mcp = await executeDraft(moved, { ...ctx, source: 'mcp' })
    expect(mcp.ok).toBe(false)
    expect(securityPrompts.queue).toHaveLength(0)
    // The user is asked.
    const sending = executeDraft({ ...d, url: 'https://mock.slinger.local/echo?again' }, ctx)
    expect((await sending).ok).toBe(true)
    const elsewhere = executeDraft({ ...d, url: 'https://other.slinger.local/echo' }, ctx)
    const p = await nextPrompt()
    expect(p.message).toContain('https://other.slinger.local')
    securityPrompts.answer(p.id, false)
    expect((await elsewhere).ok).toBe(false)
  })
})

describe('SecurityPromptHost', () => {
  it('shows one prompt at a time; confirming one never answers the next', async () => {
    const user = userEvent.setup()
    render(SecurityPromptHost)
    const first = securityPrompts.ask('a', { title: 'First?', message: 'one', confirmLabel: 'Allow A' })
    const second = securityPrompts.ask('b', { title: 'Second?', message: 'two', confirmLabel: 'Allow B' })
    await user.click(await screen.findByRole('button', { name: 'Allow A' }))
    expect(await first).toBe(true)
    expect(await screen.findByRole('button', { name: 'Allow B' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await second).toBe(false)
    expect(securityPrompts.queue).toHaveLength(0)
  })
})
