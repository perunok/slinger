/**
 * Wire contract of sync protocol v2 push rejections (slinger-admin server/README.md "Sync protocol v2"), checked with
 * raw HTTP so the SAME assertions run against the in-process fake (sync/rejections.test.ts) and the real server
 * (sync-it/realServer.it.ts). If the two ever disagree, one of these runs fails.
 */
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>

export interface ContractTarget {
  baseUrl: string
  /** Access token of a user who can create workspaces. */
  ownerToken: string
  /** Makes a user a VIEWER of `wsId` and returns that user's access token. */
  viewerToken(wsId: string): Promise<string>
}

const DOC = JSON.stringify({ headers: [], body: '' })

export async function checkRejectionContract(t: ContractTarget): Promise<void> {
  const call = async (method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: J }> => {
    const res = await fetch(t.baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    return { status: res.status, json: text ? (JSON.parse(text) as J) : {} }
  }

  // Register: v2 + the features the desktop relies on.
  const reg = await call('POST', '/v1/sync/clients/register', t.ownerToken, { client_name: 'contract', device_name: 'contract' })
  expect(reg.status).toBe(201)
  expect(reg.json.protocol_version).toBe(2)
  expect(reg.json.features).toEqual(expect.arrayContaining(['sort_order', 'snapshot', 'collection_version', 'secret_metadata', 'op_reasons', 'request_move']))
  const clientId = reg.json.client.client_id as string

  const publish = async (): Promise<string> => {
    const r = await call('POST', '/v1/workspaces/publish', t.ownerToken, {
      local_workspace: { name: `Contract ${randomUUID().slice(0, 8)}` }, publish_mode: 'create', client: { client_id: clientId },
    })
    expect(r.status).toBe(201)
    return r.json.workspace.id as string
  }
  const ws = await publish()
  const otherWs = await publish()

  type Op = { resource_type: string; resource_id: string; op?: 'upsert' | 'delete'; base_version?: number; payload?: J }
  const push = async (wsId: string, op: Op): Promise<{ accepted?: J; rejected?: J }> => {
    const r = await call('POST', `/v1/workspaces/${wsId}/sync/push`, t.ownerToken, {
      client_id: clientId, operations: [{ operation_id: randomUUID(), op: 'upsert', base_version: 0, payload: {}, ...op }],
    })
    expect(r.status).toBe(200)
    expect(r.json.accepted.length + r.json.rejected.length).toBe(1)
    return r.json.accepted.length ? { accepted: r.json.accepted[0] } : { rejected: r.json.rejected[0] }
  }
  const ok = async (wsId: string, op: Op): Promise<number> => {
    const r = await push(wsId, op)
    expect(r.rejected, JSON.stringify(r.rejected)).toBeUndefined()
    return r.accepted!.resulting_version as number
  }
  /** Every rejection carries all fields; the extras are null unless the reason defines them. */
  const rejected = async (wsId: string, op: Op, expected: J): Promise<J> => {
    const r = await push(wsId, op)
    expect(r.accepted, `expected a rejection for ${JSON.stringify(op).slice(0, 200)}`).toBeUndefined()
    const x = r.rejected!
    expect(Object.keys(x).sort()).toEqual(['code', 'conflicting_resource_id', 'current_payload', 'current_version', 'message', 'operation_id', 'reason', 'resource_id'])
    expect(x).toMatchObject({ resource_id: op.resource_id, current_version: null, current_payload: null, conflicting_resource_id: null, ...expected })
    expect(typeof x.message).toBe('string')
    return x
  }

  const col = randomUUID()
  const col2 = randomUUID()
  const folder = randomUUID()
  const reqId = randomUUID()
  await ok(ws, { resource_type: 'collection', resource_id: col, payload: { name: 'C' } })
  await ok(ws, { resource_type: 'collection', resource_id: col2, payload: { name: 'C2' } })
  await ok(ws, { resource_type: 'folder', resource_id: folder, payload: { collection_id: col, parent_folder_id: null, name: 'F', sort_order: 3 } })
  const request = { collection_id: col, folder_id: folder, name: 'R', method: 'GET', url: 'https://x', document_json: DOC, sort_order: 2 }
  await ok(ws, { resource_type: 'request', resource_id: reqId, payload: request })
  expect(await ok(ws, { resource_type: 'collection', resource_id: col, base_version: 1, payload: { name: 'C renamed' } })).toBe(2)

  // version_mismatch: legacy sync_conflict, with the server's current version AND payload.
  await rejected(ws, { resource_type: 'collection', resource_id: col, base_version: 1, payload: { name: 'stale' } }, {
    code: 'sync_conflict', reason: 'version_mismatch', current_version: 2, current_payload: { name: 'C renamed' },
  })
  // full wire payload incl. sort_order
  await rejected(ws, { resource_type: 'request', resource_id: reqId, base_version: 7, payload: request }, {
    code: 'sync_conflict', reason: 'version_mismatch', current_version: 1, current_payload: request,
  })

  // A request moves to another collection with folder_id null; a folder never changes collection.
  expect(await ok(ws, { resource_type: 'request', resource_id: reqId, base_version: 1, payload: { ...request, collection_id: col2, folder_id: null } })).toBe(2)
  await rejected(ws, { resource_type: 'request', resource_id: reqId, base_version: 2, payload: { ...request, collection_id: col2, folder_id: folder } }, { code: 'invalid_request', reason: 'invalid' })
  await rejected(ws, { resource_type: 'folder', resource_id: folder, base_version: 1, payload: { collection_id: col2, parent_folder_id: null, name: 'F', sort_order: 3 } }, { code: 'invalid_request', reason: 'invalid' })

  // not_found: delete of a missing row (legacy not_found), missing parent (not_found), edit of a row deleted on the server (legacy sync_conflict).
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), op: 'delete', base_version: 1 }, { code: 'not_found', reason: 'not_found' })
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, collection_id: randomUUID(), folder_id: null } }, { code: 'not_found', reason: 'not_found' })
  const gone = randomUUID()
  await ok(ws, { resource_type: 'request', resource_id: gone, payload: { ...request, folder_id: null } })
  await ok(ws, { resource_type: 'request', resource_id: gone, op: 'delete', base_version: 1 })
  await rejected(ws, { resource_type: 'request', resource_id: gone, base_version: 1, payload: { ...request, folder_id: null } }, { code: 'sync_conflict', reason: 'not_found' })

  // invalid / too_large (both legacy invalid_request).
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, name: '   ' } }, { code: 'invalid_request', reason: 'invalid' })
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, method: 'NOT A TOKEN' } }, { code: 'invalid_request', reason: 'invalid' })
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, document_json: '{not json' } }, { code: 'invalid_request', reason: 'invalid' })
  await rejected(ws, { resource_type: 'collection', resource_id: randomUUID(), payload: { name: 'n'.repeat(201) } }, { code: 'invalid_request', reason: 'too_large' })
  await ok(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, name: 'n'.repeat(500) } }) // S9
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, name: 'n'.repeat(501) } }, { code: 'invalid_request', reason: 'too_large' })
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, url: 'u'.repeat(8193) } }, { code: 'invalid_request', reason: 'too_large' })
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, method: 'M'.repeat(33) } }, { code: 'invalid_request', reason: 'too_large' })
  await rejected(ws, { resource_type: 'request', resource_id: randomUUID(), payload: { ...request, folder_id: null, document_json: JSON.stringify({ b: 'x'.repeat(900_000) }) } }, { code: 'invalid_request', reason: 'too_large' })

  // Secrets: metadata only.
  const env = randomUUID()
  await ok(ws, { resource_type: 'environment', resource_id: env, payload: { name: 'E' } })
  await rejected(ws, { resource_type: 'environment_variable', resource_id: randomUUID(), payload: { environment_id: env, key: 'tok', value: 'PLAINTEXT', is_secret: true } }, { code: 'invalid_request', reason: 'invalid' })
  await rejected(ws, { resource_type: 'environment_variable', resource_id: randomUUID(), payload: { environment_id: env, key: 'k'.repeat(129), value: 'v', is_secret: false } }, { code: 'invalid_request', reason: 'too_large' })
  const secret = randomUUID()
  await ok(ws, { resource_type: 'environment_variable', resource_id: secret, payload: { environment_id: env, key: 'tok', value: null, is_secret: true } })

  // duplicate_key: the holder's id comes back.
  const holder = randomUUID()
  await ok(ws, { resource_type: 'environment_variable', resource_id: holder, payload: { environment_id: env, key: 'base_url', value: 'a', is_secret: false } })
  await rejected(ws, { resource_type: 'environment_variable', resource_id: randomUUID(), payload: { environment_id: env, key: 'base_url', value: 'b', is_secret: false } }, {
    code: 'conflict', reason: 'duplicate_key', conflicting_resource_id: holder,
  })
  // ... also on a key rename by id.
  await rejected(ws, { resource_type: 'environment_variable', resource_id: secret, base_version: 1, payload: { environment_id: env, key: 'base_url', value: null, is_secret: true } }, {
    code: 'conflict', reason: 'duplicate_key', conflicting_resource_id: holder,
  })
  // version_mismatch on a secret: its value is masked in current_payload.
  await rejected(ws, { resource_type: 'environment_variable', resource_id: secret, base_version: 5, payload: { environment_id: env, key: 'tok', value: null, is_secret: true } }, {
    code: 'sync_conflict', reason: 'version_mismatch', current_version: 1, current_payload: { environment_id: env, key: 'tok', value: null, is_secret: true },
  })

  // Collection versions: insert-only.
  const v1 = randomUUID()
  const version = { collection_id: col, semver: '1.0.0', notes: 'first', snapshot_json: '{}', folder_count: 1, request_count: 1, created_at: '2026-01-02T03:04:05.000Z' }
  await ok(ws, { resource_type: 'collection_version', resource_id: v1, payload: version })
  expect(await ok(ws, { resource_type: 'collection_version', resource_id: v1, payload: version })).toBe(1) // identical re-send: idempotent
  await rejected(ws, { resource_type: 'collection_version', resource_id: v1, payload: { ...version, notes: 'changed' } }, {
    code: 'conflict', reason: 'immutable', current_version: 1, current_payload: version,
  })
  await rejected(ws, { resource_type: 'collection_version', resource_id: randomUUID(), payload: version }, { code: 'conflict', reason: 'duplicate_key', conflicting_resource_id: v1 })

  // id_in_use: the id exists in ANOTHER workspace (which must not be revealed).
  await rejected(otherWs, { resource_type: 'collection', resource_id: col, payload: { name: 'steal' } }, { code: 'conflict', reason: 'id_in_use' })

  // Pull payloads carry sort_order (v2).
  const pull = await call('GET', `/v1/workspaces/${ws}/sync/pull?client_id=${clientId}&after_checkpoint=0&limit=500`, t.ownerToken)
  const folderOp = (pull.json.operations as J[]).find((o) => o.resource_id === folder && o.op === 'upsert')!
  expect(folderOp.payload).toEqual({ collection_id: col, parent_folder_id: null, name: 'F', sort_order: 3 })

  // A viewer's push is refused as a whole: 403 workspace_access_denied with details.reason read_only.
  const viewer = await t.viewerToken(ws)
  const vreg = await call('POST', '/v1/sync/clients/register', viewer, { client_name: 'contract', device_name: 'viewer' })
  const vpush = await call('POST', `/v1/workspaces/${ws}/sync/push`, viewer, {
    client_id: vreg.json.client.client_id, operations: [{ operation_id: randomUUID(), resource_type: 'collection', resource_id: randomUUID(), op: 'upsert', base_version: 0, payload: { name: 'nope' } }],
  })
  expect(vpush.status).toBe(403)
  expect(vpush.json.error).toMatchObject({ code: 'workspace_access_denied', details: { reason: 'read_only', role: 'viewer' } })
}
