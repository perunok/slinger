import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import ImportPostmanDialog from './ImportPostmanDialog.svelte'
import { parsePostmanFile } from './parse'

const collection = (extra: object = {}) =>
  JSON.stringify({
    info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      { name: 'Dogs', item: [{ name: 'List', request: { method: 'GET', url: 'https://x.test/dogs' } }] },
      { name: 'Health', request: { method: 'GET', url: 'https://x.test/health' } },
    ],
    ...extra,
  })

async function setup() {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  await app.init()
  toast.clear()
  const onclose = vi.fn()
  render(ImportPostmanDialog, { open: true, onclose })
  return { mock, onclose }
}
async function pick(text: string, name = 'x.json') {
  const input = screen.getByLabelText('Postman file') as HTMLInputElement
  const file = new File([text], name, { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await fireEvent.change(input)
}

beforeEach(() => vi.restoreAllMocks())

describe('parsePostmanFile', () => {
  it('counts folders and requests and reads variables', () => {
    const r = parsePostmanFile(collection({ variable: [{ key: 'baseUrl', value: 'https://x.test' }, { key: '', value: 'skip' }] }))
    expect(r).toMatchObject({ ok: true, file: { kind: 'collection', name: 'Pets', folders: 1, requests: 2, variables: [{ key: 'baseUrl', value: 'https://x.test' }] } })
  })
  it('counts saved examples of the sample collection', () => {
    const r = parsePostmanFile(readFileSync(join(__dirname, '..', '..', '..', 'example-postman-collection.json'), 'utf8'))
    expect(r).toMatchObject({ ok: true, file: { kind: 'collection', requests: 8, examples: 16 } })
  })
  it('recognises environments', () => {
    const r = parsePostmanFile(JSON.stringify({ name: 'Prod', _postman_variable_scope: 'environment', values: [{ key: 'a', value: '1', type: 'default', enabled: true }, { key: 's', value: 'x', type: 'secret' }, { key: 'off', value: '', enabled: false }] }))
    expect(r).toMatchObject({ ok: true, file: { kind: 'environment', name: 'Prod', skippedDisabled: 1 } })
    if (r.ok && r.file.kind === 'environment') expect(r.file.variables.map((v) => v.secret)).toEqual([false, true])
  })
  it.each([
    ['{oops', /not valid JSON/],
    ['[1]', /not a Postman export/],
    ['{"a":1}', /no "item" array/],
    [JSON.stringify({ info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' } }), /Unsupported Postman schema/],
    [JSON.stringify({ info: { name: 'E' }, item: [] }), /no requests/],
  ])('rejects %s', (text, msg) => {
    const r = parsePostmanFile(text)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(msg)
  })
})

describe('ImportPostmanDialog', () => {
  it('shows an error for invalid JSON and keeps Import disabled', async () => {
    await setup()
    await pick('not json')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid JSON/)
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
  })

  it('rejects JSON that is not a Postman collection', async () => {
    await setup()
    await pick('{"hello": "world"}')
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not look like a Postman collection/)
  })

  it('previews and imports a collection, then reloads and closes', async () => {
    const { mock, onclose } = await setup()
    await pick(collection())
    const preview = await screen.findByLabelText('Import preview')
    expect(preview).toHaveTextContent('Pets')
    expect(preview).toHaveTextContent('Folders1')
    expect(preview).toHaveTextContent('Requests2')
    expect(preview).toHaveTextContent('none')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(app.collections.map((c) => c.name)).toContain('Pets')
    expect(app.requestsOf(app.collections.find((c) => c.name === 'Pets')!.id)).toHaveLength(2)
    expect(toast.items.some((t) => t.kind === 'success')).toBe(true)
    expect(mock.calls.some((c) => c.method === 'createEnvironment')).toBe(false)
  })

  it('creates an environment from collection variables by default and can opt out', async () => {
    const { mock, onclose } = await setup()
    await pick(collection({ variable: [{ key: 'baseUrl', value: 'https://x.test' }, { key: 'token', value: 'abc' }] }))
    expect(await screen.findByLabelText(/Create environment from collection variables/)).toBeChecked()
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const env = app.environments.find((e) => e.name === 'Pets')
    expect(env).toBeTruthy()
    const vars = await mock.listEnvironmentVariables(env!.id)
    expect(vars.map((v) => v.key).sort()).toEqual(['baseUrl', 'token'])
  })

  it('skips the environment when unchecked', async () => {
    const { mock, onclose } = await setup()
    await pick(collection({ variable: [{ key: 'a', value: '1' }] }))
    await fireEvent.click(await screen.findByLabelText(/Create environment from collection variables/))
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(mock.calls.some((c) => c.method === 'createEnvironment')).toBe(false)
  })

  it('imports a Postman environment with secret values', async () => {
    const { mock, onclose } = await setup()
    await pick(JSON.stringify({ name: 'Staging', _postman_variable_scope: 'environment', values: [{ key: 'host', value: 'h', type: 'default', enabled: true }, { key: 'pw', value: 'p', type: 'secret', enabled: true }] }))
    expect(await screen.findByLabelText('Import preview')).toHaveTextContent('Staging')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onclose).toHaveBeenCalled())
    const env = app.environments.find((e) => e.name === 'Staging')!
    const vars = await mock.listEnvironmentVariables(env.id)
    expect(vars.find((v) => v.key === 'pw')?.isSecret).toBe(true)
    expect(vars.find((v) => v.key === 'host')?.isSecret).toBe(false)
  })

  it('stays open and shows the error when the import fails', async () => {
    const { mock, onclose } = await setup()
    mock.failNext('importPostmanCollection', { code: 'invalid_input', message: 'Postman collection must contain an item array' })
    await pick(collection())
    await screen.findByLabelText('Import preview')
    await fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('must contain an item array')
    expect(onclose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()
  })
})
