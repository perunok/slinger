import { IpcError } from '../lib/errors'
import { ioError } from '../lib/errors'

/** Keychain service name for every secret Slinger stores. */
export const KEYCHAIN_SERVICE = 'Slinger'
/** Keys under this prefix hold environment secrets. */
export const ENV_VAR_SECRET_PREFIX = 'slinger:env-var:'

/** Cloud session tokens (electron/cloud/auth.ts) live under this prefix, keyed by API base URL. */
export const CLOUD_TOKEN_PREFIX = 'slinger.cloud.tokens:'

/** OAuth 2.0 tokens (services/oauth2.ts) live under this prefix, keyed by a hash of workspace + configuration. */
export const OAUTH2_TOKEN_PREFIX = 'slinger:oauth2:'

export const envVarSecretKey = (variableId: string): string => `${ENV_VAR_SECRET_PREFIX}${variableId}`

/** Keys under this prefix hold secret globals (pm.globals); reserved like the environment prefix. */
export const GLOBAL_VAR_SECRET_PREFIX = 'slinger:global-var:'

export const globalVarSecretKey = (variableId: string): string => `${GLOBAL_VAR_SECRET_PREFIX}${variableId}`

/*
 * There is deliberately no generic keychain access over IPC (the former secureStoreGet/Set/Delete): every keychain entry
 * (variable secrets, cloud and OAuth 2.0 tokens, the MCP server's bearer token, the list of allowed MCP stdio commands) is
 * read and written only by the main-process service that owns it.
 */

export interface SecretStore {
  get(key: string): string | null
  set(key: string, value: string): void
  /** Deleting a missing key is not an error. */
  delete(key: string): void
}

/** In-memory store for tests and for machines without a usable OS keychain. */
export class MemorySecretStore implements SecretStore {
  readonly entries = new Map<string, string>()
  get(key: string) {
    return this.entries.get(key) ?? null
  }
  set(key: string, value: string) {
    this.entries.set(key, value)
  }
  delete(key: string) {
    this.entries.delete(key)
  }
}

/**
 * Dev/test-only escape hatch for machines whose OS keychain cannot be used unattended (a locked desktop keyring
 * would block on an unlock prompt): `SLINGER_INSECURE_TEST_KEYCHAIN=1` keeps secrets in memory for this run.
 * Honoured only by an unpackaged build (`npm run build` + electron .); a packaged app always uses the OS keychain.
 * Used by `npm run screenshots`.
 */
export const INSECURE_TEST_KEYCHAIN_ENV = 'SLINGER_INSECURE_TEST_KEYCHAIN'

export interface SecretStoreChoice {
  env: Record<string, string | undefined>
  isPackaged: boolean
  /** The real OS keychain store (only called when it is the one used). */
  keychain: () => SecretStore
  warn: (message: string) => void
}

/** The OS keychain, or the in-memory test store when a dev build asked for it (see INSECURE_TEST_KEYCHAIN_ENV). */
export function chooseSecretStore({ env, isPackaged, keychain, warn }: SecretStoreChoice): SecretStore {
  const requested = env[INSECURE_TEST_KEYCHAIN_ENV] === '1'
  if (requested && !isPackaged) {
    warn(
      `!!! ${INSECURE_TEST_KEYCHAIN_ENV}=1: secrets are kept IN MEMORY, not in the OS keychain, and are lost on exit. ` +
        'Development and screenshot runs only. !!!',
    )
    return new MemorySecretStore()
  }
  if (requested) warn(`${INSECURE_TEST_KEYCHAIN_ENV} is ignored in a packaged app; using the OS keychain.`)
  return keychain()
}

interface KeyringEntry {
  getPassword(): string | null
  setPassword(password: string): void
  deletePassword(): boolean
}
type EntryCtor = new (service: string, username: string) => KeyringEntry

/** OS keychain (Keychain / Credential Manager / Secret Service) via @napi-rs/keyring. */
export class KeychainSecretStore implements SecretStore {
  constructor(
    private readonly Entry: EntryCtor,
    private readonly service = KEYCHAIN_SERVICE,
  ) {}

  private wrap<T>(action: string, fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      if (err instanceof IpcError) throw err
      throw ioError(`OS keychain ${action} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  get(key: string) {
    return this.wrap('read', () => new this.Entry(this.service, key).getPassword())
  }
  set(key: string, value: string) {
    this.wrap('write', () => new this.Entry(this.service, key).setPassword(value))
  }
  delete(key: string) {
    this.wrap('delete', () => {
      new this.Entry(this.service, key).deletePassword()
    })
  }
}

/**
 * Deletes keychain entries whose rows are already gone from the database (after the transaction committed).
 * A failure only leaves an orphaned entry that is unreachable through the app, so it is logged, not thrown.
 */
export function purgeSecretRefs(secrets: SecretStore | undefined, refs: Iterable<string>): void {
  for (const ref of refs) {
    try {
      secrets?.delete(ref)
    } catch (err) {
      console.warn(`[slinger] could not delete keychain entry ${ref}:`, err instanceof Error ? err.message : err)
    }
  }
}
