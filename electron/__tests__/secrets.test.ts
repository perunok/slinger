import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IpcError } from '../../shared/types'
import { KeychainSecretStore, MemorySecretStore } from '../services/secrets'
import { makeEnv, scaffold, type TestEnv } from './helpers'

let env: TestEnv
beforeEach(() => {
  env = makeEnv()
})
afterEach(() => env.cleanup())

const SECRET = 'sk-live-TOPSECRET-123'

async function envWithSecret() {
  const { workspace } = await scaffold(env)
  const environment = await env.api.createEnvironment(workspace.id, 'Prod')
  const secretVar = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'API_KEY', value: SECRET, isSecret: true })
  const plainVar = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'HOST', value: 'example.com', isSecret: false })
  return { workspace, environment, secretVar, plainVar }
}

describe('environment secrets', () => {
  it('stores the secret only in the keychain; the row has value NULL and a secret_ref', async () => {
    const { secretVar } = await envWithSecret()
    const row = env.core.db.prepare('SELECT value, is_secret, secret_ref FROM environment_variables WHERE id = ?').get(secretVar.id) as {
      value: string | null
      is_secret: number
      secret_ref: string
    }
    expect(row).toEqual({ value: null, is_secret: 1, secret_ref: `slinger:env-var:${secretVar.id}` })
    expect(env.secrets.get(row.secret_ref)).toBe(SECRET)
  })

  it('never leaks the secret in upsert results, lists, or anywhere in the SQLite file', async () => {
    const { environment, secretVar } = await envWithSecret()
    expect(secretVar).toMatchObject({ value: null, isSecret: true, maskedValue: '••••••••' })

    const listed = await env.api.listEnvironmentVariables(environment.id)
    expect(JSON.stringify(listed)).not.toContain(SECRET)
    const s = listed.find((v) => v.key === 'API_KEY')!
    expect(s).toMatchObject({ value: null, isSecret: true, maskedValue: '••••••••' })
    const p = listed.find((v) => v.key === 'HOST')!
    expect(p).toMatchObject({ value: 'example.com', isSecret: false, maskedValue: null })

    // Exhaustive: no table in the database contains the secret.
    const tables = env.core.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    for (const { name } of tables) {
      expect(JSON.stringify(env.core.db.prepare(`SELECT * FROM "${name}"`).all()), name).not.toContain(SECRET)
    }
  })

  it('reveals the value only through revealEnvironmentVariable', async () => {
    const { secretVar, plainVar } = await envWithSecret()
    expect(await env.api.revealEnvironmentVariable(secretVar.id)).toBe(SECRET)
    expect(await env.api.revealEnvironmentVariable(plainVar.id)).toBe('example.com')
  })

  it('reveal reports not_found when the keychain entry is missing', async () => {
    const { secretVar } = await envWithSecret()
    env.secrets.entries.clear()
    await expect(env.api.revealEnvironmentVariable(secretVar.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('deleting a secret variable removes the keychain entry and hides the row', async () => {
    const { environment, secretVar } = await envWithSecret()
    await env.api.deleteEnvironmentVariable(secretVar.id)
    expect(env.secrets.entries.size).toBe(0)
    expect((await env.api.listEnvironmentVariables(environment.id)).map((v) => v.key)).toEqual(['HOST'])
    await expect(env.api.revealEnvironmentVariable(secretVar.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('deleting the environment purges its secrets', async () => {
    const { environment } = await envWithSecret()
    await env.api.deleteEnvironment(environment.id)
    expect(env.secrets.entries.size).toBe(0)
  })

  it('upsert updates in place by key or variableId; empty value keeps the current secret', async () => {
    const { environment, secretVar } = await envWithSecret()
    const kept = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'API_KEY', value: '', isSecret: true, variableId: secretVar.id })
    expect(kept.id).toBe(secretVar.id)
    expect(kept.version).toBe(2)
    expect(await env.api.revealEnvironmentVariable(secretVar.id)).toBe(SECRET)

    const rotated = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'API_KEY', value: 'new-secret', isSecret: true })
    expect(rotated.id).toBe(secretVar.id) // matched by key
    expect(await env.api.revealEnvironmentVariable(secretVar.id)).toBe('new-secret')
    expect((await env.api.listEnvironmentVariables(environment.id)).length).toBe(2)
  })

  it('converts between secret and plain values without leaving stale copies', async () => {
    const { environment, secretVar, plainVar } = await envWithSecret()
    // secret -> plain (empty value keeps the value, which is now stored in the row)
    const plain = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'API_KEY', value: '', isSecret: false, variableId: secretVar.id })
    expect(plain).toMatchObject({ isSecret: false, value: SECRET, maskedValue: null })
    expect(env.secrets.entries.size).toBe(0)
    // plain -> secret: leaves the row, moves to keychain
    const secret = await env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'HOST', value: '', isSecret: true, variableId: plainVar.id })
    expect(secret).toMatchObject({ isSecret: true, value: null })
    expect(env.core.db.prepare('SELECT value FROM environment_variables WHERE id = ?').get(plainVar.id)).toEqual({ value: null })
    expect(await env.api.revealEnvironmentVariable(plainVar.id)).toBe('example.com')
  })

  it('rejects empty new secrets, duplicate keys on rename, and variables from other environments', async () => {
    const { workspace, environment, secretVar } = await envWithSecret()
    await expect(env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'EMPTY', value: '', isSecret: true })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.upsertEnvironmentVariable({ environmentId: environment.id, key: 'HOST', value: 'x', isSecret: false, variableId: secretVar.id })).rejects.toMatchObject({ code: 'invalid_input' })
    const other = await env.api.createEnvironment(workspace.id, 'Other')
    await expect(env.api.upsertEnvironmentVariable({ environmentId: other.id, key: 'API_KEY', value: 'x', isSecret: false, variableId: secretVar.id })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('generic secure store passthrough', () => {
  it('round-trips arbitrary keys', async () => {
    expect(await env.api.secureStoreGet('cloud:token')).toBeNull()
    await env.api.secureStoreSet('cloud:token', 'abc')
    expect(await env.api.secureStoreGet('cloud:token')).toBe('abc')
    await env.api.secureStoreDelete('cloud:token')
    expect(await env.api.secureStoreGet('cloud:token')).toBeNull()
  })

  it('cannot read, write or delete the environment-secret namespace (mask bypass)', async () => {
    const { secretVar } = await envWithSecret()
    const key = `slinger:env-var:${secretVar.id}`
    await expect(env.api.secureStoreGet(key)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.secureStoreSet(key, 'x')).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.secureStoreDelete(key)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(env.api.secureStoreGet('SLINGER:ENV-VAR:whatever')).rejects.toMatchObject({ code: 'invalid_input' })
    expect(env.secrets.get(key)).toBe(SECRET)
  })
})

describe('KeychainSecretStore', () => {
  it('uses service "Slinger" with the key as the account name and wraps native errors as io_error', () => {
    const calls: Array<[string, string]> = []
    const backing = new Map<string, string>()
    class FakeEntry {
      constructor(private service: string, private user: string) {
        calls.push([service, user])
      }
      getPassword() {
        return backing.get(this.user) ?? null
      }
      setPassword(p: string) {
        backing.set(this.user, p)
      }
      deletePassword() {
        return backing.delete(this.user)
      }
    }
    const store = new KeychainSecretStore(FakeEntry)
    store.set('k', 'v')
    expect(store.get('k')).toBe('v')
    store.delete('k')
    expect(store.get('k')).toBeNull()
    expect(calls.every(([service]) => service === 'Slinger')).toBe(true)

    class Broken {
      getPassword(): string | null {
        throw new Error('no secret service')
      }
      setPassword() {}
      deletePassword() {
        return false
      }
    }
    const err = (() => {
      try {
        new KeychainSecretStore(Broken).get('k')
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(IpcError)
    expect((err as IpcError).code).toBe('io_error')
  })

  it('MemorySecretStore treats deleting a missing key as a no-op', () => {
    expect(() => new MemorySecretStore().delete('nope')).not.toThrow()
  })
})
