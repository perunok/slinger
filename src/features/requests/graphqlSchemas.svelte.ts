/**
 * GraphQL schemas fetched with "Fetch schema" (Body > GraphQL), kept in memory per workspace and request URL (as typed,
 * `{{variables}}` unresolved) for the query editor's autocomplete and the schema browser. Never stored: a schema can be
 * large and is fetched again in a click; nothing of the request (auth, headers, secrets) is kept.
 *
 * The introspection query is sent through `executeDraft` like Send, so it uses the same environment, auth (inherited
 * included), secrets, network settings and cookie jar, and lands in History. It is always a POST with the GraphQL JSON
 * body, and runs no scripts.
 */
import type { RequestDraft } from '../../lib/request'
import { INTROSPECTION_OPERATION, INTROSPECTION_QUERY, schemaFromIntrospection, type GqlSchema } from '../../lib/graphql'
import { executeDraft } from './execute'

export interface SchemaEntry {
  loading: boolean
  schema: GqlSchema | null
  error: string | null
  /** Date.now() of the last successful fetch. */
  fetchedAt: number | null
}

export interface FetchSchemaTarget {
  workspaceId: string
  collectionId?: string | null
  folderId?: string | null
  draft: RequestDraft
}

const keyOf = (workspaceId: string, url: string) => `${workspaceId}\u0000${url.trim()}`

/** The draft that asks for the schema: the request with the introspection query as its body, sent as POST. */
export function introspectionDraft(draft: RequestDraft): RequestDraft {
  return {
    ...draft,
    name: `${draft.name} (GraphQL schema)`,
    method: 'POST',
    body: { ...draft.body, kind: 'graphql', graphql: { query: INTROSPECTION_QUERY, variables: '', operationName: INTROSPECTION_OPERATION } },
  }
}

class GraphqlSchemas {
  entries = $state<Record<string, SchemaEntry>>({})

  get(workspaceId: string | null, url: string): SchemaEntry | null {
    return workspaceId ? (this.entries[keyOf(workspaceId, url)] ?? null) : null
  }

  async fetch(t: FetchSchemaTarget): Promise<SchemaEntry> {
    const key = keyOf(t.workspaceId, t.draft.url)
    const prev = this.entries[key]
    this.entries[key] = { loading: true, schema: prev?.schema ?? null, error: null, fetchedAt: prev?.fetchedAt ?? null }
    const done = (patch: Partial<SchemaEntry>): SchemaEntry => {
      const next = { ...this.entries[key], loading: false, ...patch }
      this.entries[key] = next
      return next
    }
    let outcome
    try {
      outcome = await executeDraft(introspectionDraft(t.draft), {
        workspaceId: t.workspaceId,
        collectionId: t.collectionId ?? null,
        folderId: t.folderId ?? null,
        skipScripts: true,
      })
    } catch (e) {
      return done({ error: e instanceof Error ? e.message : String(e) })
    }
    if (!outcome.ok) return done({ error: outcome.error })
    const res = outcome.response
    let json: unknown = null
    try {
      json = res.bodyText ? JSON.parse(res.bodyText) : null
    } catch {
      /* reported below */
    }
    if (json === null) return done({ error: `The server answered ${res.status} ${res.statusText} without a JSON body.` })
    const parsed = schemaFromIntrospection(json)
    if (!parsed.ok) return done({ error: res.status >= 400 ? `${res.status} ${res.statusText}: ${parsed.error}` : parsed.error })
    return done({ schema: parsed.schema, error: null, fetchedAt: Date.now() })
  }

  /** Forgets every schema (tests). */
  clear() {
    this.entries = {}
  }
}

export const graphqlSchemas = new GraphqlSchemas()
