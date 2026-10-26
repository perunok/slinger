import { describe, expect, it } from 'vitest'
import { EnvModel, VARIABLE_CONFLICT_MESSAGE } from './envModel.svelte'
import type { VarBackend, VarRecord, VarUpsert } from './varBackends'

/** An in-memory backend with the same optimistic-concurrency rule as main (expectedVersion must match). */
function fakeBackend(initial: Omit<VarRecord, 'version'>[] = []) {
  const store = new Map<string, VarRecord>(initial.map((r) => [r.id, { ...r, version: 1 }]))
  const secrets = new Map<string, string>()
  const calls: VarUpsert[] = []
  let n = 0
  const backend: VarBackend = {
    kind: 'environment',
    secrets: true,
    enabledColumn: false,
    list: async () => [...store.values()].map((r) => ({ ...r })),
    upsert: async (_owner, row) => {
      calls.push({ ...row })
      const existing = row.variableId ? store.get(row.variableId) : undefined
      if (existing && row.expectedVersion !== undefined && row.expectedVersion !== existing.version) {
        throw { name: 'IpcError', code: 'version_conflict', message: 'modified elsewhere', details: { expectedVersion: row.expectedVersion, currentVersion: existing.version } }
      }
      const id = existing?.id ?? `v${++n}`
      const keep = row.isSecret && row.value === '' && existing
      if (row.isSecret && !keep) secrets.set(id, row.value)
      const rec: VarRecord = {
        id,
        key: row.key,
        value: row.isSecret ? null : row.value,
        isSecret: row.isSecret,
        secretMissing: false,
        enabled: row.enabled,
        version: (existing?.version ?? 0) + 1,
      }
      store.set(id, rec)
      return { ...rec }
    },
    remove: async (id) => void store.delete(id),
    reveal: async (id) => secrets.get(id) ?? '',
    changed: () => {},
  }
  /** Someone else (sync, a script) writes the variable. */
  const writeElsewhere = (id: string, value: string) => {
    const r = store.get(id)!
    store.set(id, { ...r, value, version: r.version + 1 })
  }
  return { backend, store, calls, writeElsewhere }
}

const plain = (id: string, key: string, value: string): Omit<VarRecord, 'version'> => ({ id, key, value, isSecret: false, secretMissing: false, enabled: true })

async function loaded(initial: Omit<VarRecord, 'version'>[] = []) {
  const f = fakeBackend(initial)
  const model = new EnvModel(0, f.backend)
  await model.load('env1')
  return { ...f, model }
}

describe('EnvModel', () => {
  it('loads the variables plus one blank row for typing a new one', async () => {
    const { model } = await loaded([plain('a', 'host', 'x')])
    expect(model.rows.map((r) => [r.key, r.value, r.version])).toEqual([
      ['host', 'x', 1],
      ['', '', undefined],
    ])
  })

  it('an update sends the version it was loaded at and then follows the stored version', async () => {
    const { model, calls } = await loaded([plain('a', 'host', 'x')])
    const rid = model.rows[0].rid
    model.edit(rid, { value: 'y' })
    expect((await model.flush()).ok).toBe(true)
    model.edit(rid, { value: 'z' })
    expect((await model.flush()).ok).toBe(true)
    expect(calls.map((c) => [c.value, c.expectedVersion])).toEqual([
      ['y', 1],
      ['z', 2],
    ])
    expect(model.rows[0].version).toBe(3)
  })

  it('a new variable is created without expectedVersion and gets the new id and version', async () => {
    const { model, calls } = await loaded()
    const rid = model.rows[0].rid
    model.edit(rid, { key: 'token', value: 't' })
    expect((await model.flush()).ok).toBe(true)
    expect(calls[0]).toMatchObject({ key: 'token', variableId: undefined })
    expect(calls[0].expectedVersion).toBeUndefined()
    expect(model.rows[0]).toMatchObject({ id: 'v1', version: 1 })
    expect(model.rows).toHaveLength(2) // a fresh blank row follows
  })

  it('a variable changed elsewhere is not overwritten silently; Retry overwrites it on purpose', async () => {
    const { model, store, writeElsewhere } = await loaded([plain('a', 'host', 'x')])
    const rid = model.rows[0].rid
    writeElsewhere('a', 'from-sync')
    model.edit(rid, { value: 'mine' })
    const res = await model.flush()
    expect(res.ok).toBe(false)
    expect(model.stateOf(rid)).toBe('error')
    expect(model.errorOf(rid)).toBe(VARIABLE_CONFLICT_MESSAGE)
    expect(store.get('a')!.value).toBe('from-sync')
    expect(model.rows[0].value).toBe('mine') // the user's edit is kept

    await model.queue.retry(rid)
    expect(model.stateOf(rid)).toBe('saved')
    expect(store.get('a')).toMatchObject({ value: 'mine', version: 3 })
  })

  it('a saved secret value is cleared from the row (never kept in memory)', async () => {
    const { model, store } = await loaded()
    const rid = model.rows[0].rid
    model.edit(rid, { key: 'token' })
    model.toggleSecret(rid)
    model.edit(rid, { value: 's3cret' })
    expect((await model.flush()).ok).toBe(true)
    expect(model.rows[0]).toMatchObject({ value: '', serverSecret: true, secretTouched: false })
    expect(store.get('v1')).toMatchObject({ isSecret: true, value: null })
  })

  it('removing a stored variable deletes it', async () => {
    const { model, store } = await loaded([plain('a', 'host', 'x')])
    model.remove(model.rows[0].rid)
    expect((await model.flush()).ok).toBe(true)
    expect(store.has('a')).toBe(false)
    expect(model.rows.map((r) => r.key)).toEqual([''])
  })

  it('discard drops unsaved edits', async () => {
    const { model, calls } = await loaded([plain('a', 'host', 'x')])
    model.edit(model.rows[0].rid, { value: 'y' })
    model.discard()
    expect((await model.flush()).ok).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
