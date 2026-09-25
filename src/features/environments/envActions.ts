/** Environment-level operations (not per-variable). Errors propagate so dialogs can show them inline. */
import type { Environment } from '../../../shared/types'
import { app } from '../../app/state.svelte'
import { api } from '../../lib/ipc'
import { envNameIssue, findEnvByName } from './envLogic'

function checkName(raw: string, exceptId?: string): string {
  const issue = envNameIssue(app.environments, raw, exceptId)
  if (issue) throw new Error(issue)
  return raw.trim()
}

function workspace(): string {
  if (!app.workspaceId) throw new Error('No workspace is open')
  return app.workspaceId
}

export async function createEnv(rawName: string): Promise<Environment> {
  const env = await api().createEnvironment(workspace(), checkName(rawName))
  await app.reloadEnvironments()
  return env
}

export async function renameEnv(id: string, rawName: string): Promise<void> {
  await api().renameEnvironment(id, checkName(rawName, id))
  await app.reloadEnvironments()
}

export async function deleteEnv(id: string): Promise<void> {
  await api().deleteEnvironment(id)
  await app.reloadEnvironments()
}

export interface DuplicateResult {
  env: Environment
  copied: number
  skippedSecrets: number
}

/**
 * Copies the plain variables into a new "<name> copy". Secrets are deliberately NOT copied
 * (their plaintext would have to pass through the renderer); the caller tells the user.
 */
export async function duplicateEnv(source: Environment): Promise<DuplicateResult> {
  let name = `${source.name} copy`
  for (let i = 2; findEnvByName(app.environments, name); i++) name = `${source.name} copy ${i}`
  const vars = await api().listEnvironmentVariables(source.id)
  const env = await api().createEnvironment(workspace(), name)
  let copied = 0
  try {
    for (const v of vars) {
      if (v.isSecret) continue
      await api().upsertEnvironmentVariable({ environmentId: env.id, key: v.key, value: v.value ?? '', isSecret: false })
      copied++
    }
  } finally {
    await app.reloadEnvironments()
  }
  return { env, copied, skippedSecrets: vars.filter((v) => v.isSecret).length }
}
