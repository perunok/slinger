import type { SyncEntityType } from '../../shared/types'
import type { Db } from '../db/database'
import type { SecretStore } from '../services/secrets'

export type { SyncEntityType }

/** Wire payload (snake_case JSON) of one entity, exactly what the cloud API speaks. */
export type Payload = Record<string, unknown>

/** One operation as pushed. */
export interface WireOp {
  operation_id: string
  resource_type: SyncEntityType
  resource_id: string
  op: 'upsert' | 'delete'
  base_version: number
  payload: Payload
  occurred_at: string
}

/** One operation as returned by pull. */
export interface PullOp {
  operation_id: string
  workspace_id: string
  resource_type: SyncEntityType
  resource_id: string
  op: 'upsert' | 'delete'
  resulting_version: number
  payload: Payload
  occurred_at: string
  checkpoint: number
}

export interface SnapshotEntity {
  resource_type: SyncEntityType
  resource_id: string
  version: number
  payload: Payload
}

export type RejectCode = 'sync_conflict' | 'not_found' | 'invalid_request' | 'conflict' | 'internal_error'
export interface PushAccepted {
  operation_id: string
  resource_id: string
  resulting_version: number
}
export interface PushRejected {
  operation_id: string
  resource_id: string
  code: RejectCode
  message: string
  current_version: number | null
}
export interface PushResponse {
  accepted: PushAccepted[]
  rejected: PushRejected[]
  checkpoint: number
}
export interface PullResponse {
  operations: PullOp[]
  checkpoint: number
  has_more: boolean
}
export interface SnapshotResponse {
  checkpoint: number
  entities: SnapshotEntity[]
  next_cursor: string | null
}

/** Everything the pure engine needs; injected so tests run in plain Node with fake time. */
export interface SyncContext {
  db: Db
  secrets: SecretStore
  /** Epoch milliseconds. */
  now(): number
}

export interface Clock {
  now(): number
}

/** Ids touched by an apply, for the `applied` event. */
export type ChangeKind = 'upsert' | 'delete'
export type ChangeLog = Map<string, { entityType: SyncEntityType; entityId: string; change: ChangeKind }>

export interface LinkRow {
  workspace_id: string
  api_base_url: string
  remote_workspace_id: string
  sync_client_id: string | null
  sync_checkpoint: number
  created_at: number
  updated_at: number
  remote_name: string
  remote_role: string | null
  remote_user_id: string | null
  link_state: 'initial' | 'active'
  auto_sync: number
  read_only: number
  access_state: 'ok' | 'revoked' | 'remote_deleted'
  last_synced_at: number | null
  last_error_code: string | null
  last_error_message: string | null
  snapshot_cursor: string | null
}

export interface EntityState {
  entity_type: SyncEntityType
  entity_id: string
  workspace_id: string
  remote_version: number
  base_payload: string | null
  remote_deleted: number
  state: 'synced' | 'conflict'
}

export const SYNC_ENTITY_TYPES: readonly SyncEntityType[] = [
  'collection',
  'folder',
  'request',
  'environment',
  'environment_variable',
  'collection_version',
] as const
