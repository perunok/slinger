import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../../app/state.svelte'
import { toast } from '../../app/toast.svelte'
import { ui } from '../../app/ui.svelte'
import { createMockBackend } from '../../dev/mockBackend'
import { importIntoEnvironment } from '../importexport/envImport'
import { parsePostmanFile } from '../importexport/parse'
import EnvironmentExportDialog from './EnvironmentExportDialog.svelte'
import { buildEnvironmentExport } from './envExport'

async function setup() {
  const mock = createMockBackend({ latencyMs: 0, seed: false })
  window.slinger = mock
  await app.init()
  toast.clear()
  const ws = app.workspaceId!
  const env = await mock.createEnvironment(ws, 'Prod ኢትዮጵያ')
  await mock.upsertEnvironmentVariable({ environmentId: env.id, key: 'baseUrl', value: 'https://api.example.com', isSecret: false })
  await mock.upsertEnvironmentVariable({ environmentId: env.id, key: 'token', value: 's3cr3t-token', isSecret: true })
  await mock.upsertEnvironmentVariable({ environmentId: env.id, key: 'zEmpty', value: '', isSecret: false })
  await app.reloadEnvironments()
  return { mock, ws, env }
}

const reveals = (mock: ReturnType<typeof createMockBackend>) => mock.calls.filter((c) => c.method === 'revealEnvironmentVariable').length

/** Imports a file's text like the Import dialog does (parse, then merge by name). */
async function importText(mock: ReturnType<typeof createMockBackend>, ws: string, text: string) {
  const parsed = parsePostmanFile(text)
  if (!parsed.ok || parsed.file.kind !== 'environment') throw new Error('not an environment file')
  return importIntoEnvironment(mock, ws, parsed.file.name, parsed.file.variables, 'overwrite')
}

async function valuesOf(mock: ReturnType<typeof createMockBackend>, environmentId: string) {
  const vars = await mock.listEnvironmentVariables(environmentId)
  return Promise.all(vars.map(async (v) => [v.key, v.isSecret, v.isSecret ? await mock.revealEnvironmentVariable(v.id) : v.value] as const))
}

beforeEach(() => {
  ui.exportEnvironmentId = null
  vi.restoreAllMocks()
})

describe('buildEnvironmentExport', () => {
  it('writes a Postman environment file; secrets are exported by name only and never revealed', async () => {
    const { mock, env } = await setup()
    const r = await buildEnvironmentExport(mock, env, { includeSecrets: false, appVersion: '0.3.2', now: new Date('2026-09-25T10:00:00Z') })
    expect(JSON.parse(r.json)).toEqual({
      id: env.id,
      name: 'Prod ኢትዮጵያ',
      values: [
        { key: 'baseUrl', value: 'https://api.example.com', type: 'default', enabled: true },
        { key: 'token', value: '', type: 'secret', enabled: true },
        { key: 'zEmpty', value: '', type: 'default', enabled: true },
      ],
      _postman_variable_scope: 'environment',
      _postman_exported_at: '2026-09-25T10:00:00.000Z',
      _postman_exported_using: 'Slinger/0.3.2',
    })
    expect(r.json).not.toContain('s3cr3t-token')
    expect(r).toMatchObject({ variables: 3, secrets: 1, revealed: 0, missing: [] })
    expect(reveals(mock)).toBe(0)
  })

  it('reveals secrets in the main process only on opt-in', async () => {
    const { mock, env } = await setup()
    const r = await buildEnvironmentExport(mock, env, { includeSecrets: true, appVersion: '1' })
    expect(JSON.parse(r.json).values[1]).toEqual({ key: 'token', value: 's3cr3t-token', type: 'secret', enabled: true })
    expect(r.revealed).toBe(1)
    expect(reveals(mock)).toBe(1)
  })

  it('round trip without secrets: a new environment gets the plain values, an existing one keeps its secret', async () => {
    const { mock, ws, env } = await setup()
    const text = (await buildEnvironmentExport(mock, env, { includeSecrets: false, appVersion: '1' })).json

    // Into the same-named environment: merged, the stored secret is kept (empty values never clear).
    const merged = await importText(mock, ws, text)
    expect(merged).toMatchObject({ environmentId: env.id, created: false, added: 0, updated: 0 })
    expect(await valuesOf(mock, env.id)).toEqual([
      ['baseUrl', false, 'https://api.example.com'],
      ['token', true, 's3cr3t-token'],
      ['zEmpty', false, ''],
    ])

    // Into a workspace without it: created; the secret key exists so {{token}} resolves once filled in.
    const other = (await mock.createWorkspace('Other')).id
    const created = await importText(mock, other, text)
    expect(created).toMatchObject({ created: true, added: 3, name: 'Prod ኢትዮጵያ' })
    expect(await valuesOf(mock, created.environmentId)).toEqual([
      ['baseUrl', false, 'https://api.example.com'],
      ['token', false, ''],
      ['zEmpty', false, ''],
    ])
  })

  it('round trip with secrets opted in: the secret is recreated as a secret with its value', async () => {
    const { mock, env } = await setup()
    const text = (await buildEnvironmentExport(mock, env, { includeSecrets: true, appVersion: '1' })).json
    const other = (await mock.createWorkspace('Other')).id
    const created = await importText(mock, other, text)
    expect(await valuesOf(mock, created.environmentId)).toEqual([
      ['baseUrl', false, 'https://api.example.com'],
      ['token', true, 's3cr3t-token'],
      ['zEmpty', false, ''],
    ])
  })
})

describe('EnvironmentExportDialog', () => {
  it('saves <name>.slinger_environment.json without secret values by default', async () => {
    const { mock, env } = await setup()
    ui.exportEnvironmentId = env.id
    render(EnvironmentExportDialog)
    expect(await screen.findByTestId('env-export-file-name')).toHaveTextContent('Prod ኢትዮጵያ.slinger_environment.json')
    expect(await screen.findByLabelText('Export preview')).not.toHaveTextContent('s3cr3t-token')
    const save = screen.getByRole('button', { name: 'Save to file' })
    await waitFor(() => expect(save).toBeEnabled())
    await fireEvent.click(save)
    await waitFor(() => expect(ui.exportEnvironmentId).toBeNull())
    const call = mock.calls.find((c) => c.method === 'writeExportFile')!
    expect(call.args[0]).toBe('Prod ኢትዮጵያ.slinger_environment.json')
    expect(call.args[1]).not.toContain('s3cr3t-token')
    expect(reveals(mock)).toBe(0)
  })

  it('"Include secret values" warns, keeps the preview masked and writes the values', async () => {
    const { mock, env } = await setup()
    ui.exportEnvironmentId = env.id
    render(EnvironmentExportDialog)
    const box = await screen.findByLabelText(/Include secret values/)
    await waitFor(() => expect(box).toBeEnabled())
    await fireEvent.click(box)
    expect(screen.getByTestId('secret-warning')).toHaveTextContent(/1 secret value in plain text/)
    expect(screen.getByLabelText('Export preview')).not.toHaveTextContent('s3cr3t-token')
    expect(reveals(mock)).toBe(0) // nothing revealed until the user saves
    await fireEvent.click(screen.getByRole('button', { name: 'Save to file' }))
    await waitFor(() => expect(ui.exportEnvironmentId).toBeNull())
    const text = mock.calls.find((c) => c.method === 'writeExportFile')!.args[1] as string
    expect(JSON.parse(text).values[1]).toMatchObject({ key: 'token', value: 's3cr3t-token', type: 'secret' })
    expect(reveals(mock)).toBe(1)
  })
})
