/** The Authorization tab's Digest and AWS Signature editors (0.30): fields, {{variables}}, Advanced, stored Postman shape. */
import { EditorView } from '@codemirror/view'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend } from '../../dev/mockBackend'
import { emptyAuth, newDraft, parseAuth, serializeDraft, type AuthDraft } from '../../lib/request'
import AuthPanel from './AuthPanel.svelte'
import { tabsStore } from './tabs.svelte'

beforeEach(() => {
  window.slinger = createMockBackend({ latencyMs: 0, seed: false })
  tabsStore.tabs = []
})
afterEach(() => cleanup())

const typeInto = (label: string, text: string) => {
  const v = EditorView.findFromDOM(screen.getByRole('textbox', { name: label }).closest('.cm-editor') as HTMLElement)!
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } })
}
const storedAuth = (tab: { draft: Parameters<typeof serializeDraft>[0] }) => JSON.parse(serializeDraft(tab.draft).documentJson).auth
const entry = (auth: { [k: string]: Array<{ key: string; value: unknown }> }, type: string, key: string) => auth[type]!.find((e) => e.key === key)?.value

describe('Digest editor', () => {
  it('choosing Digest shows user name and password (masked); values go into Postman\'s digest array', async () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'https://api.test/x' }) })
    render(AuthPanel, { tab })
    const kind = screen.getByLabelText('Authorization type') as HTMLSelectElement
    expect([...kind.options].map((o) => o.textContent)).toContain('Digest Auth')
    await fireEvent.change(kind, { target: { value: 'digest' } })
    expect(screen.getByTestId('digest-editor')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'About Digest auth' })).toBeInTheDocument()
    typeInto('Username', 'alice')
    typeInto('Password', '{{digestPassword}}')
    const auth = storedAuth(tab)
    expect(auth.type).toBe('digest')
    expect(entry(auth, 'digest', 'username')).toBe('alice')
    expect(entry(auth, 'digest', 'password')).toBe('{{digestPassword}}')
    expect(entry(auth, 'digest', 'algorithm')).toBe('MD5')
  })

  it('Advanced: realm, nonce, algorithm, qop, counts, opaque and "do not answer automatically"', async () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'https://api.test/x' }) })
    tab.draft.auth = { ...emptyAuth(), kind: 'digest' }
    render(AuthPanel, { tab })
    expect(screen.getByTestId('digest-advanced')).not.toHaveAttribute('open')
    await fireEvent.click(screen.getByText('Advanced'))
    typeInto('Realm', 'r@test')
    typeInto('Nonce', 'abc')
    typeInto('qop', 'auth-int')
    typeInto('Nonce count', '00000002')
    typeInto('Client nonce', 'cn')
    typeInto('Opaque', 'op')
    await fireEvent.change(screen.getByLabelText('Algorithm'), { target: { value: 'SHA-256-sess' } })
    await fireEvent.click(screen.getByTestId('digest-disable-retry'))
    const auth = storedAuth(tab)
    expect(Object.fromEntries(auth.digest.map((e: { key: string; value: unknown }) => [e.key, e.value]))).toEqual({
      algorithm: 'SHA-256-sess',
      username: '',
      password: '',
      realm: 'r@test',
      nonce: 'abc',
      qop: 'auth-int',
      nonceCount: '00000002',
      clientNonce: 'cn',
      opaque: 'op',
      disableRetryRequest: true,
    })
    expect(auth.digest.find((e: { key: string }) => e.key === 'disableRetryRequest').type).toBe('boolean')
  })

  it('an imported Digest auth shows its values; a draft from an older Slinger without the object still edits', async () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'https://api.test/x' }) })
    tab.draft.auth = { kind: 'digest' } as unknown as AuthDraft
    render(AuthPanel, { tab })
    typeInto('Username', 'bob')
    expect(entry(storedAuth(tab), 'digest', 'username')).toBe('bob')
  })
})

describe('AWS Signature editor', () => {
  it('access key, secret key, region, service and session token', async () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'https://s3.amazonaws.com/b' }) })
    render(AuthPanel, { tab })
    await fireEvent.change(screen.getByLabelText('Authorization type'), { target: { value: 'awsv4' } })
    expect(screen.getByRole('button', { name: 'About AWS Signature' })).toBeInTheDocument()
    typeInto('Access key', '{{awsKey}}')
    typeInto('Secret key', '{{awsSecret}}')
    typeInto('AWS region', 'eu-west-1')
    typeInto('Service name', 's3')
    typeInto('Session token', '{{awsSession}}')
    expect(storedAuth(tab)).toEqual({
      type: 'awsv4',
      awsv4: [
        { key: 'accessKey', value: '{{awsKey}}', type: 'string' },
        { key: 'secretKey', value: '{{awsSecret}}', type: 'string' },
        { key: 'region', value: 'eu-west-1', type: 'string' },
        { key: 'service', value: 's3', type: 'string' },
        { key: 'sessionToken', value: '{{awsSession}}', type: 'string' },
      ],
    })
  })

  it('a Postman auth that wants the signature in the query says it is sent as a header', () => {
    const tab = tabsStore.newTab({ draft: newDraft({ url: 'https://x' }) })
    tab.draft.auth = parseAuth({ type: 'awsv4', awsv4: [{ key: 'accessKey', value: 'a' }, { key: 'addAuthDataToQuery', value: true, type: 'boolean' }] })
    render(AuthPanel, { tab })
    expect(screen.getByText(/Slinger sends it in the Authorization header instead/)).toBeInTheDocument()
  })
})
