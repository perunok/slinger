/**
 * Browser mock of the local security state (main: repositories/trust.ts, migration 0019): script trust per collection
 * and the AI assistant's unreviewed changes, plus redactSecrets. Fingerprints are plain JSON here (main hashes them);
 * the comparison is the same: a change counts while the content is still what the assistant wrote.
 */
import { mockRedactCookies } from './cookies'
import type { SlingerIpcApi } from '../../../shared/ipc-contract'
import type { ApiRequest, AssistantChangeRef, AssistantChanges } from '../../../shared/types'
import { mockRedactToken } from './oauth2'
import { must, type MockState, type VariableRow } from './store'
import { fail } from './util'

type SecurityApi = Pick<
  SlingerIpcApi,
  'trustCollectionScripts' | 'markAssistantChange' | 'clearAssistantChange' | 'listAssistantChanges' | 'redactSecrets'
>

function requestFingerprint(r: Pick<ApiRequest, 'method' | 'url' | 'documentJson'>): string {
  let doc: unknown
  try {
    doc = JSON.parse(r.documentJson)
  } catch {
    doc = r.documentJson
  }
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
    const { responses: _responses, name: _name, ...rest } = doc as Record<string, unknown>
    doc = rest
  }
  return JSON.stringify(['request-v1', r.method, r.url, doc])
}

const variableFingerprint = (v: VariableRow) => JSON.stringify(['variable-v1', v.isSecret, v.isSecret ? v.version : v.value])

const findVariable = (s: MockState, environmentId: string, key: string) => s.variables.find((v) => v.environmentId === environmentId && v.key === key)

const ANY = '*'

const keyOf = (ref: AssistantChangeRef) =>
  ref.kind === 'request' ? `request:${ref.requestId}` : ref.kind === 'container' ? `container:${ref.containerKind}:${ref.id}` : `variable:${ref.environmentId}:${ref.key}`
/** As main (repositories/trust.ts): a collection's / folder's auth by its stored text. */
const containerFingerprint = (authJson: string | null | undefined) => JSON.stringify(['container-v1', authJson ?? null])
const containerOf = (s: MockState, kind: 'collection' | 'folder', id: string) =>
  kind === 'collection' ? s.collections.find((c) => c.id === id) : s.folders.find((f) => f.id === id)

/** The mock's runScripts refusal for a collection whose scripts are not allowed (same error as main). */
export function assertScriptsTrusted(s: MockState, collectionId: string | null | undefined, scriptCount: number): void {
  if (!collectionId || scriptCount === 0 || !s.untrustedCollections[collectionId]) return
  const c = s.collections.find((x) => x.id === collectionId)
  const name = c?.name ?? ''
  fail('invalid_input', `The scripts of the collection "${name}" have not been allowed on this device yet.`, {
    reason: 'untrusted_scripts',
    collectionId,
    collectionName: name,
  })
}

export function createSecurityApi(s: MockState): SecurityApi {
  return {
    async trustCollectionScripts(collectionId) {
      must(s.collections, collectionId, 'Collection')
      delete s.untrustedCollections[collectionId]
    },
    async markAssistantChange(ref) {
      if (ref.kind === 'container') {
        const c = containerOf(s, ref.containerKind, ref.id)
        if (!c) fail('invalid_input', `No ${ref.containerKind} with id "${ref.id}"`)
        s.assistantChanges[keyOf(ref)] = { workspaceId: c.workspaceId, fingerprint: ref.pending ? ANY : containerFingerprint(c.authJson), created: false }
        return
      }
      if (ref.kind === 'request') {
        const r = must(s.requests, ref.requestId, 'Request')
        s.assistantChanges[keyOf(ref)] = { workspaceId: r.workspaceId, fingerprint: ref.pending ? ANY : requestFingerprint(r), created: ref.created === true }
        return
      }
      const env = must(s.environments, ref.environmentId, 'Environment')
      const v = findVariable(s, env.id, ref.key)
      if (!v && !ref.pending) fail('invalid_input', `No variable "${ref.key}" in this environment`)
      s.assistantChanges[keyOf(ref)] = { workspaceId: env.workspaceId, fingerprint: ref.pending || !v ? ANY : variableFingerprint(v), created: false }
    },
    async clearAssistantChange(ref) {
      delete s.assistantChanges[keyOf(ref)]
    },
    async listAssistantChanges(workspaceId): Promise<AssistantChanges> {
      const out: AssistantChanges = { requests: [], variables: [], containers: [] }
      for (const [key, c] of Object.entries(s.assistantChanges)) {
        if (c.workspaceId !== workspaceId) continue
        if (key.startsWith('container:')) {
          const [, kind, id] = key.split(':') as [string, 'collection' | 'folder', string]
          const row = containerOf(s, kind, id)
          if (row && (c.fingerprint === ANY || containerFingerprint(row.authJson) === c.fingerprint)) out.containers!.push({ kind, id })
        } else if (key.startsWith('request:')) {
          const id = key.slice('request:'.length)
          const r = s.requests.find((x) => x.id === id)
          if (r && (c.fingerprint === ANY || requestFingerprint(r) === c.fingerprint)) out.requests.push({ requestId: id, created: c.created })
        } else {
          const rest = key.slice('variable:'.length)
          const sep = rest.indexOf(':')
          const environmentId = rest.slice(0, sep)
          const name = rest.slice(sep + 1)
          const v = findVariable(s, environmentId, name)
          if (v && (c.fingerprint === ANY || variableFingerprint(v) === c.fingerprint)) out.variables.push({ environmentId, key: name })
        }
      }
      return out
    },
    // No script sessions in the mock (scripts do not run); OAuth 2.0 tokens are replaced like main does.
    async redactSecrets(input) {
      const texts = input.texts.map((t) => mockRedactToken(s, input.oauth2TokenKey, t))
      return input.cookies ? mockRedactCookies(s, input.cookies.workspaceId, texts, input.cookies.responseSetCookies) : texts
    },
  }
}
