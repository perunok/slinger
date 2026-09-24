/** Pure 3-way merge of wire payloads per field group (docs/SYNC_DESIGN.md section 6). */
import type { SyncEntityType } from '../../shared/types'
import { GROUPS, canonicalJson, pick, type GroupName } from './mapping'
import type { Payload } from './types'

export interface MergeResult {
  /** Full payload: remote as the skeleton, each group resolved. Conflicting groups keep the LOCAL value. */
  merged: Payload
  /** Groups changed on both sides to different values (never contains `order`). */
  conflicting: GroupName[]
  /** Groups whose merged value came from local (i.e. differs from remote and must be pushed). */
  takenLocal: GroupName[]
}

const eq = (a: Payload, b: Payload) => canonicalJson(a) === canonicalJson(b)

/**
 * `base` = last state both sides agreed on (null when unknown: every differing group then conflicts),
 * `local` = current local wire payload, `remote` = pulled payload.
 * Per group: only-local -> local, only-remote -> remote, same -> same, both different -> conflict.
 * Group `order` never conflicts: remote wins silently (order is best-effort UI state).
 */
export function merge(type: SyncEntityType, base: Payload | null, local: Payload, remote: Payload): MergeResult {
  const merged: Payload = { ...remote }
  const conflicting: GroupName[] = []
  const takenLocal: GroupName[] = []
  for (const [group, fields] of Object.entries(GROUPS[type]) as Array<[GroupName, string[]]>) {
    const l = pick(local, fields)
    const r = pick(remote, fields)
    const b = base ? pick(base, fields) : null
    const localChanged = b === null ? !eq(l, r) : !eq(l, b)
    const remoteChanged = b === null ? !eq(l, r) : !eq(r, b)
    let chosen: Payload
    if (eq(l, r)) chosen = r
    else if (!remoteChanged) chosen = l
    else if (!localChanged) chosen = r
    else if (group === 'order') chosen = r
    else {
      conflicting.push(group)
      chosen = l
    }
    if (chosen === l && !eq(l, r)) takenLocal.push(group)
    Object.assign(merged, chosen)
  }
  return { merged, conflicting, takenLocal }
}
