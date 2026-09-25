/**
 * Environment export as a Postman environment file (re-importable by Slinger and Postman).
 *
 * Secret values never leave the main process unless the user ticks "Include secret values": only then is each
 * secret revealed (revealEnvironmentVariable) for the file. Otherwise a secret is exported as
 * `type: 'secret'` with an empty value, which an import into an existing environment keeps as is.
 */
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { Environment } from '../../../shared/types'
import { buildPostmanEnvironment } from '../../lib/postman'

export type EnvExportApi = Pick<SlingerIpcApi, 'listEnvironmentVariables' | 'revealEnvironmentVariable'>

export interface EnvExportResult {
  json: string
  variables: number
  secrets: number
  /** Secrets whose value was written into the file (only with includeSecrets). */
  revealed: number
  /** Secret keys with no value on this device (created on another device): exported empty. */
  missing: string[]
}

export async function buildEnvironmentExport(
  api: EnvExportApi,
  env: Environment,
  opts: { includeSecrets: boolean; appVersion: string; now?: Date },
): Promise<EnvExportResult> {
  const vars = await api.listEnvironmentVariables(env.id)
  const missing: string[] = []
  let revealed = 0
  const rows = []
  for (const v of vars) {
    if (!v.isSecret) {
      rows.push({ key: v.key, value: v.value ?? '', isSecret: false })
      continue
    }
    let value = ''
    if (opts.includeSecrets) {
      if (v.secretMissing) missing.push(v.key)
      else {
        value = await api.revealEnvironmentVariable(v.id)
        revealed++
      }
    }
    rows.push({ key: v.key, value, isSecret: true })
  }
  const doc = buildPostmanEnvironment(env.name, rows, {
    id: env.id,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    exportedUsing: `Slinger/${opts.appVersion}`,
    includeSecretValues: opts.includeSecrets,
  })
  return {
    json: JSON.stringify(doc, null, 2),
    variables: vars.length,
    secrets: vars.filter((v) => v.isSecret).length,
    revealed,
    missing,
  }
}
