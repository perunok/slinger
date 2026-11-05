/** Body > GraphQL: the mode, the query and variables editors, Fetch schema (through the normal send path) and the schema browser. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HttpRequestInput } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { newDraft, serializeDraft } from '../../lib/request'
import BodyPanel from './BodyPanel.svelte'
import ResponsePane from '../response/ResponsePane.svelte'
import { graphqlSchemas, introspectionDraft } from './graphqlSchemas.svelte'
import { tabsStore } from './tabs.svelte'

let backend: ReturnType<typeof createMockBackend>
let sent: HttpRequestInput[]

beforeEach(async () => {
  localStorage.clear()
  backend = createMockBackend({ latencyMs: 0 })
  window.slinger = backend
  window.__slingerMock = backend
  tabsStore.tabs = []
  tabsStore.activeId = null
  graphqlSchemas.clear()
  await app.init()
  sent = []
  const exec = backend.executeHttpRequest.bind(backend)
  vi.spyOn(backend, 'executeHttpRequest').mockImplementation(async (input) => {
    sent.push(structuredClone(input))
    return exec(input)
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const openDemo = () => tabsStore.openRequest(app.requests.find((r) => r.name === 'GraphQL books')!)
const editorText = (label: string) => screen.getByRole('textbox', { name: label }).textContent

describe('Body > GraphQL', () => {
  it('shows an imported GraphQL body with its query and variables; the variables are checked as JSON', async () => {
    const tab = openDemo()
    render(BodyPanel, { tab })
    expect(screen.getByRole('radio', { name: 'GraphQL' })).toBeChecked()
    expect(editorText('GraphQL query')).toContain('books(genre: $genre, first: 5)')
    expect(editorText('GraphQL variables')).toContain('"genre": "FANTASY"')
    expect(screen.getByText('Valid JSON')).toBeInTheDocument()

    tab.draft.body.graphql = { ...tab.draft.body.graphql, variables: '{"genre": ' }
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Invalid JSON/)
    tab.draft.body.graphql = { ...tab.draft.body.graphql, variables: '[1]' }
    expect(await screen.findByRole('alert')).toHaveTextContent('The variables must be a JSON object')
  })

  it('picking GraphQL turns any body into a GraphQL one; the operation name is stored when set', async () => {
    const tab = tabsStore.newTab({ draft: newDraft({ method: 'POST', url: 'https://api.test/graphql' }) })
    render(BodyPanel, { tab })
    await fireEvent.click(screen.getByRole('radio', { name: 'GraphQL' }))
    expect(tab.draft.body.kind).toBe('graphql')
    expect(screen.getByRole('textbox', { name: 'GraphQL query' })).toBeInTheDocument()
    await fireEvent.input(screen.getByRole('combobox', { name: 'GraphQL operation name' }), { target: { value: 'Books' } })
    expect(JSON.parse(serializeDraft(tab.draft).documentJson).body).toEqual({ mode: 'graphql', graphql: { query: '', variables: '', operationName: 'Books' } })
  })

  it('Fetch schema sends the introspection query like Send (POST, JSON, no scripts) and opens the schema browser', async () => {
    const runScripts = vi.spyOn(backend, 'runScripts')
    const tab = openDemo()
    // A pre-request script must not run for the introspection query.
    tab.draft.extras = { ...tab.draft.extras, scripts: [{ listen: 'prerequest', script: { type: 'text/javascript', exec: ['pm.environment.set("x", 1)'] } }] }
    render(BodyPanel, { tab })
    await fireEvent.click(screen.getByRole('button', { name: 'Fetch schema' }))
    expect(await screen.findByTestId('graphql-schema-status')).toHaveTextContent('Schema: 11 types')
    expect(runScripts).not.toHaveBeenCalled()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ method: 'POST', url: 'https://mock.slinger.local/graphql', body: { mode: 'raw', raw: { contentType: 'application/json' } } })
    const payload = JSON.parse(sent[0]!.body.raw!.content)
    expect(payload.operationName).toBe('IntrospectionQuery')
    expect(payload.query).toContain('__schema')
    // The request itself is unchanged.
    expect(tab.draft.body.graphql.query).toContain('books(genre: $genre')

    const browser = await screen.findByTestId('graphql-schema-browser')
    const types = within(browser).getByRole('list', { name: 'Schema types' })
    expect(within(types).getAllByRole('button').map((b) => b.textContent?.trim().split(/\s+/)[0]).slice(0, 2)).toEqual(['Query', 'Mutation'])
    await fireEvent.input(within(browser).getByRole('searchbox', { name: 'Filter schema types' }), { target: { value: 'boo' } })
    await fireEvent.click(within(browser).getByRole('button', { name: /^Book object/ }))
    const fields = within(browser).getByRole('list', { name: 'Fields of Book' })
    expect(fields).toHaveTextContent('The title as printed on the cover.')
    expect(fields).toHaveTextContent('Deprecated: Use `id`.')
    await fireEvent.click(within(fields).getByRole('button', { name: 'Author!' }))
    expect(within(browser).getByRole('list', { name: 'Fields of Author' })).toBeInTheDocument()
    // Kept per URL: another tab of the same URL has it without fetching again.
    expect(graphqlSchemas.get(app.workspaceId, 'https://mock.slinger.local/graphql')?.schema?.queryType).toBe('Query')
  })

  it('reports a server that does not answer with a schema', async () => {
    const tab = openDemo()
    tab.draft.url = 'https://mock.slinger.local/json'
    render(BodyPanel, { tab })
    await fireEvent.click(screen.getByRole('button', { name: 'Fetch schema' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The response is not a GraphQL introspection result'))
  })

  it('the introspection draft keeps the request (URL, headers, auth) and replaces only method and body', () => {
    const d = newDraft({ method: 'GET', url: 'https://x/graphql' })
    d.auth = { ...d.auth, kind: 'bearer', bearer: { token: '{{tok}}' } }
    const i = introspectionDraft(d)
    expect(i).toMatchObject({ method: 'POST', url: 'https://x/graphql', auth: { kind: 'bearer', bearer: { token: '{{tok}}' } }, body: { kind: 'graphql' } })
  })

  it('a 200 answer with an errors array gets a "GraphQL error" chip', async () => {
    const tab = openDemo()
    tab.draft.body.graphql = { ...tab.draft.body.graphql, query: '{ unknownField }', variables: '' }
    await tabsStore.send(tab)
    render(ResponsePane, { tab })
    expect(screen.getByTestId('status-chip')).toHaveTextContent('200')
    expect(screen.getByTestId('graphql-errors-chip')).toHaveTextContent('GraphQL error')
    tab.draft.body.graphql = { ...tab.draft.body.graphql, query: '{ books { id } }' }
    await tabsStore.send(tab)
    await waitFor(() => expect(screen.queryByTestId('graphql-errors-chip')).toBeNull())
  })
})
