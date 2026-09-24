# Collection sync: Slinger desktop <-> Slinger cloud

Status: design, not implemented. Written against desktop `ts-rewrite` (migrations 0001-0003) and `slinger-admin/server` `ts-rewrite`
(sync routes in `server/src/routes/sync.ts`, `services/syncApply.ts`, `services/syncLog.ts`, `services/content.ts`).
Everything below is a decision, not a menu; open decisions where a default was chosen are collected in section 19.

Conventions: "local" = the desktop SQLite database, "remote" = the cloud API, "wire" = the JSON the API speaks (snake_case),
"entity" = one synced row.

---------------------------------------------------------------------------------------------------------------------------

## 1. What exists today (findings that drive the design)

Server (already built):
- `POST /v1/sync/clients/register` -> `client_id` (row per user+device). `POST /v1/workspaces/:id/sync/push` (editor+, viewers get 403),
  `GET .../sync/pull?client_id&after_checkpoint&limit` (viewer+, `has_more`). `POST /v1/workspaces/publish` (`create` | `attach_existing`).
- Push: per-operation `accepted[{operation_id,resource_id,resulting_version}]` / `rejected[{operation_id,resource_id,code,message,current_version}]`,
  codes `sync_conflict|not_found|invalid_request|conflict|internal_error`. Idempotent by `(workspaceId, operation_id)`. Existing rows need
  `base_version == server version`; new rows use a client generated `resource_id` (must not exist in ANY workspace; ids are globally unique) and `base_version 0`.
  Ops in one push are applied sequentially in array order, each in its own transaction. Body limit defaults to 1 MB (`SLINGER_BODY_LIMIT_BYTES`), max 500 ops.
- Resource types: `collection, folder, request, environment, environment_variable`. The server hard-deletes rows; deletions live only as `delete`
  entries in `sync_operations` (the tombstone log, never compacted). Workspace `syncCheckpoint` is a per-workspace monotonically increasing `seq`.
- Secret variables: stored AES-GCM encrypted, never returned (pull payload `value: null`, REST `masked_value`).
- Server gaps relevant to sync: no `sort_order` on folders/requests; a request cannot change collection; a variable's `key` cannot change and
  `value` is a required string even for secrets; no immutable-version entity; no "current state" endpoint (a new client must replay the whole log
  from checkpoint 0); pull ops carry no author; 1 MB body limit vs. up to 900 KB per `document_json`.

Desktop (already built):
- SQLite, ids are client UUIDv7 (`newId()`), every entity has `version` (local counter bumped on every local write, used by `updateRequest`
  optimistic concurrency), soft delete (`deleted = 1`, cascades done by repositories, children version-bumped), `sort_order` for folders/requests
  (`placeAt` rewrites sibling `sort_order` WITHOUT bumping sibling `version`), `cloud_links` table already exists but is unused (renderer keeps links in localStorage
  and only creates an empty remote workspace: nothing is uploaded), secret variable values live in the OS keychain under `slinger:env-var:<id>`
  (`value` NULL in SQLite), `collection_versions` = immutable semver snapshots (trigger forbids updates except `deleted`).
- Cloud tokens: renderer `src/features/cloud/session.ts` -> `secureStoreGet/Set` (keychain key `slinger.cloud.tokens:<baseUrl>`), the whole cloud client
  (`client.ts`) + device-flow polling run in the renderer and reach the network via `executeHttpRequest`, which writes a history row for every call (history noise).
- The refresh token is single-use and reuse revokes all of the user's refresh tokens (server), so exactly one component may refresh.
- Write paths that mutate entities today: repositories (workspaces, collections, tree, environments), `postmanImport.ts` and
  `collectionVersions.ts` (raw SQL). Other agents are editing these concurrently, which is a strong argument for capture that does not depend on every write site
  remembering to call something (section 5).

---------------------------------------------------------------------------------------------------------------------------

## 2. Decisions at a glance

| # | Question | Decision |
|---|---|---|
| D1 | Which entities sync | collections, folders, requests, environments, environment variables (non-secret values + secret METADATA), collection versions (immutable). Workspace metadata is NOT synced (see D2). History, keychain values, local settings never sync. |
| D2 | Workspace name/type | Not synced in v1. The link stores `remote_name`; rename is local (renaming remotely is dashboard/owner-only, `PATCH /workspaces/:id` with `version`). Displayed remote name refreshed on each cycle. |
| D3 | Secret values | Never leave the device. Wire payload for a secret variable is `{key, value: null, is_secret: true}`. A device that receives a secret variable creates it with `secret_missing = 1` ("value not set on this device"). |
| D4 | Collection versions | Synced as an immutable entity `collection_version` (insert-only, `base_version` always 0/1, delete = hide). Needs a new server resource type (S7). Shipped as the last work package; the engine is designed for it from day one. |
| D5 | Id mapping | Entities: local UUIDv7 == remote `resource_id` (no mapping table). Workspace: server assigns its own id; mapping lives in `cloud_links(workspace_id -> remote_workspace_id)`. One local workspace links to at most one remote workspace and vice versa (per API base URL). |
| D6 | Change capture | SQLite TRIGGERS mark entities dirty (`sync_dirty`), in the same statement/transaction as the mutation. No op log: operations are computed at push time from the current row + the last synced base (`sync_entities`). Remote-applied changes are suppressed by a `sync_control.applying` flag. |
| D7 | Version counters | Local `version` stays local. The server version is tracked separately in `sync_entities.remote_version` and used as `base_version`. |
| D8 | Conflicts | Detected by server version (`sync_conflict`) and, more importantly, prevented by pulling before pushing. Resolved with a 3-way merge per field GROUP using the stored last-synced payload as base; leftovers become `sync_conflicts` rows the user resolves (keep local / keep remote / merge per group / duplicate-as-copy for requests). Local work is never discarded silently. |
| D9 | Ordering | `sort_order` is a synced field; ties broken by `id` (all `ORDER BY` become `sort_order, id`). Reorder conflicts auto-resolve to the remote value. |
| D10 | Where it runs | Main process. HTTP client, token refresh, device sign-in, scheduler, engine all move to `electron/services/sync/`. Tokens are never sent to the renderer. Renderer talks only through new typed IPC + one push event channel. |
| D11 | History noise | Fixed structurally by D10: cloud traffic no longer uses `executeHttpRequest`. |
| D12 | Read-only workspaces | Role stored on the link; `read_only` enforced by SQLite triggers (`RAISE(ABORT,'slinger:read_only')`) mapped to a new `read_only` IPC error, so no repository can forget it. |
| D13 | Initial upload | `publishWorkspace` = `POST /workspaces/publish (create)` + mark all live rows dirty + normal push loop (chunked, resumable). |
| D14 | Initial download / link | `linkRemoteWorkspace` = snapshot download (new endpoint S6) + merge local content up. Environments/variables are de-duplicated by natural key; collections/folders/requests are unioned (never auto-merged by name). |
| D15 | Auto sync | Dirty poll every 5 s (cheap `SELECT`) + pull every 60 s focused / 5 min blurred + on start/focus/resume + manual "Sync now". Exponential backoff with jitter. |

---------------------------------------------------------------------------------------------------------------------------

## 3. Entity mapping and wire payloads

Wire payloads are what `syncPayload()` on the server already produces (plus the additions in section 14). Local -> wire mapping (`electron/services/sync/mapping.ts`):

| entity_type | local table | wire payload |
|---|---|---|
| `collection` | `collections` | `{name}` |
| `folder` | `folders` | `{collection_id, parent_folder_id, name, sort_order}` |
| `request` | `requests` | `{collection_id, folder_id, name, method, url, document_json, sort_order}` |
| `environment` | `environments` | `{name}` |
| `environment_variable` | `environment_variables` | `{environment_id, key, value, is_secret}`; `value = null` when `is_secret` |
| `collection_version` | `collection_versions` | `{collection_id, semver, notes, snapshot_json, folder_count, request_count, created_at}` (`created_at` ISO-8601) |

Rules:
- `deleted = 1` locally  <=>  `op: "delete"` (payload `{}`); live rows are `op: "upsert"`.
- Never included: `workspace_id` (implied by URL; the server accepts an optional matching one), timestamps other than the version's `created_at`, local `version`, `secret_ref`.
- Canonical form: keys sorted, `null` preserved. `canonicalJson(payload)` is used for equality (no-op elimination, merge).
- Limits enforced locally BEFORE sending (an oversized entity is quarantined as a `rejected` conflict, never retried in a loop): `document_json <= 900_000` bytes
  (server cap; local cap is 10 MB), `name <= 200` (request name local cap is 500: truncated is NOT acceptable, so >200 is quarantined with a clear message; the server validator should be raised to 500, see S9),
  variable `key` matches `/^[A-Za-z_][A-Za-z0-9_.-]*$/` and <= 128 (local allows more: quarantined), `value <= 65_536`, `snapshot_json <= 8 MB`.
- Local method validation is broader than the server enum (`GET..OPTIONS`): server must accept any HTTP token (S9), otherwise `WEBDAV`-style methods are quarantined.

---------------------------------------------------------------------------------------------------------------------------

## 4. Local schema: migration `0004_sync.sql`

New numbered file (never edit 0001-0003). Concept summary first, SQL after.

```sql
-- Non-secret app settings (moves cloud config out of renderer localStorage).
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- keys: cloud.config = {"apiBaseUrl":"...","deviceName":"..."}; cloud.client:<apiBaseUrl>:<userId> = <sync client id>

-- cloud_links already exists (0001). Add sync bookkeeping.
ALTER TABLE cloud_links ADD COLUMN remote_name TEXT NOT NULL DEFAULT '';
ALTER TABLE cloud_links ADD COLUMN remote_role TEXT;                      -- owner|admin|editor|viewer
ALTER TABLE cloud_links ADD COLUMN remote_user_id TEXT;                   -- account that linked (informational)
ALTER TABLE cloud_links ADD COLUMN link_state TEXT NOT NULL DEFAULT 'initial'; -- initial | active
ALTER TABLE cloud_links ADD COLUMN auto_sync INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cloud_links ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;  -- 1 when remote_role = 'viewer'
ALTER TABLE cloud_links ADD COLUMN access_state TEXT NOT NULL DEFAULT 'ok'; -- ok | revoked | remote_deleted
ALTER TABLE cloud_links ADD COLUMN last_synced_at INTEGER;
ALTER TABLE cloud_links ADD COLUMN last_error_code TEXT;
ALTER TABLE cloud_links ADD COLUMN last_error_message TEXT;
ALTER TABLE cloud_links ADD COLUMN snapshot_cursor TEXT;                  -- resumable initial download; NULL when done
CREATE UNIQUE INDEX idx_cloud_links_remote ON cloud_links(api_base_url, remote_workspace_id);
-- sync_checkpoint (existing): last PULL checkpoint fully applied. sync_client_id (existing): server client id.

-- Last state both sides agreed on, per entity (this is the merge base).
CREATE TABLE sync_entities (
  entity_type    TEXT NOT NULL,   -- collection|folder|request|environment|environment_variable|collection_version
  entity_id      TEXT NOT NULL,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  remote_version INTEGER NOT NULL DEFAULT 0,   -- server version last seen; 0 = not on the server (never pushed, or tombstoned)
  base_payload   TEXT,                          -- canonical wire payload at remote_version; NULL when remote_version = 0. Never contains secret values.
  remote_deleted INTEGER NOT NULL DEFAULT 0,   -- a remote tombstone was seen / our delete was accepted
  state          TEXT NOT NULL DEFAULT 'synced', -- synced | conflict (entity is excluded from push while an open conflict exists)
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_sync_entities_ws ON sync_entities(workspace_id);

-- Dirty set (outbox). Written by triggers only. change_seq lets the engine clear exactly what it sent.
CREATE TABLE sync_dirty (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  change_seq   INTEGER NOT NULL DEFAULT 1,
  op_id        TEXT,               -- operation id assigned when first sent for this change_seq; kept for idempotent retries
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_sync_dirty_ws ON sync_dirty(workspace_id);

-- Operation ids we have sent and not yet seen acknowledged/echoed (recognises our own ops in pull after a lost response).
CREATE TABLE sync_sent_ops (
  op_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, sent_at INTEGER NOT NULL
);   -- rows older than 14 days are pruned

CREATE TABLE sync_conflicts (
  id            TEXT PRIMARY KEY,               -- uuidv7
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   TEXT NOT NULL, entity_id TEXT NOT NULL,
  kind          TEXT NOT NULL,                  -- edit_edit|remote_deleted|local_deleted|duplicate_key|immutable_clash|rejected
  groups        TEXT NOT NULL DEFAULT '[]',     -- JSON: conflicting field groups (edit_edit)
  base_json     TEXT, local_json TEXT, remote_json TEXT,   -- wire payloads (no secret values)
  remote_version INTEGER NOT NULL DEFAULT 0,
  label         TEXT NOT NULL DEFAULT '',       -- entity name at detection, for display
  message       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',   -- open | resolved | auto_resolved
  resolution    TEXT,
  created_at    INTEGER NOT NULL, resolved_at INTEGER
);
CREATE UNIQUE INDEX idx_sync_conflicts_open ON sync_conflicts(entity_type, entity_id) WHERE status = 'open';

-- Single row; set to 1 by the engine inside its own transaction so triggers ignore remote-applied writes.
CREATE TABLE sync_control (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL DEFAULT 0);
INSERT INTO sync_control VALUES (1, 0);

-- Secret variables that arrived from another device have no value here yet.
ALTER TABLE environment_variables ADD COLUMN secret_missing INTEGER NOT NULL DEFAULT 0;
```

Triggers (same file; one INSERT + one UPDATE trigger per synced table, generated with a helper in the migration author's editor, but committed as plain SQL).
Template for `requests` (the others differ only in the WHERE-workspace expression: `environment_variables` resolves it through `environments`):

```sql
CREATE TRIGGER sync_dirty_requests_i AFTER INSERT ON requests
WHEN (SELECT applying FROM sync_control) = 0
 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty(entity_type, entity_id, workspace_id, change_seq) VALUES ('request', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT(entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- UPDATE trigger: AFTER UPDATE OF collection_id, folder_id, name, method, url, document_json, sort_order, deleted ON requests (NOT version/updated_at)
CREATE TRIGGER sync_readonly_requests_i BEFORE INSERT ON requests
WHEN (SELECT applying FROM sync_control) = 0
 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;   -- plus BEFORE UPDATE twin
```

Notes:
- Triggers fire only when a `cloud_links` row exists, so unlinked workspaces pay nothing.
- The `sync_dirty` UPSERT resets `op_id` so a changed entity gets a new operation id (section 7.2 explains why this is safe).
- `sync_readonly_*` triggers do not block `workspaces` rows (local workspace rename/delete stay allowed) and never block engine writes (`applying = 1`).
- `secret_missing` is cleared by `EnvironmentRepository.upsertVariable` when a value is supplied for a secret; `toVariable` exposes it as `secretMissing`.
- `collection_versions` has its own immutable trigger (0002); the sync triggers are `AFTER INSERT` and `AFTER UPDATE OF deleted`.
- Rows created by the engine while `applying = 1` never produce dirty rows; the engine writes `sync_entities` itself.

---------------------------------------------------------------------------------------------------------------------------

## 5. Change capture: why triggers + a dirty set (not an op log)

Options considered:
1. Outbox op-log written by repositories in the same transaction. Precise, but every write path (5 repositories, `postmanImport`, `collectionVersions`, future code, and the
   agents editing them right now) has to remember; cascades and `placeAt` sibling rewrites are easy to miss; ops for one entity pile up while offline and must be replayed/coalesced with stale `base_version`s.
2. Triggers writing an op log. Same coalescing problem, and payload assembly in SQL is ugly.
3. **Triggers writing a dirty set (chosen).** Correct by construction (every `INSERT/UPDATE` on a synced column is captured, including cascades, restore, import, `placeAt`), same transaction as the mutation, and
   the wire operation is derived at push time from the current row, so ten offline edits are one op and `base_version` is always fresh.
   Cost: needs the base payload (`sync_entities.base_payload`) for merge and no-op elimination, which we want anyway for 3-way merge.

How each producer behaves (no producer needs code changes):
- **Edits/renames**: `UPDATE` trigger -> dirty.
- **Cascade soft delete** (collection/folder/environment/workspace): each affected row is UPDATEd `deleted = 1` -> each is dirty; at build time they become `delete` ops.
  Optimisation in `buildOps`: when a `collection` (or `environment`, or `folder`) delete op is in the batch, child delete ops for its subtree are dropped from the batch only if the server cascades them
  (it does: FK cascade + logged tombstones). They are still marked acknowledged locally on the parent's acceptance (`remote_deleted = 1`). Saves N round trips for large collections.
- **Moves** (`moveFolder`, `moveRequest`): `parent_folder_id`/`folder_id`/`collection_id`/`sort_order` change on the moved row; `placeAt` may rewrite sibling `sort_order`s (siblings become dirty, sort-only ops).
- **Reorder without move**: sibling `sort_order` UPDATEs -> dirty -> `upsert` with only `sort_order` different from base.
- **Restore `replace`** (`restoreCollectionVersion`): existing live folders/requests are soft-deleted (deletes) and new rows with new ids inserted (creates); the collection `UPDATE` produces an identical payload -> no-op elimination drops it.
- **Restore `copy`** and **Postman import**: pure inserts in one local transaction; N dirty rows; pushed parents-first in chunks (section 7.1). An import of 5,000 requests is ~13 pushes of 400 ops.
- **Environment variable secret value edits**: the `UPDATE` fires but the wire payload is unchanged (`value: null`) -> no-op elimination; nothing is uploaded, correctly.
- **secret -> plaintext / plaintext -> secret toggles**: payload changes -> upsert. The server must wipe the stored plaintext on secret conversion (S3).
- **Workspace soft delete** of a linked workspace: `WorkspaceRepository.softDelete` first calls `sync.detach(workspaceId)` (deletes the `cloud_links` row and the sync tables' rows) so no delete storm hits the remote. Deleting a workspace locally never deletes remote data.
- **Link/publish**: the engine marks every live row dirty explicitly (`INSERT ... SELECT`, section 9) in the same transaction that inserts `cloud_links`, so there is no capture gap.
- **Crash safety**: dirty rows and mutations commit atomically; the engine can be killed at any point and re-derives everything from `sync_dirty` + `sync_entities`.

---------------------------------------------------------------------------------------------------------------------------

## 6. Field groups and the merge base

3-way merge works on wire payloads: `base` = `sync_entities.base_payload`, `local` = `toWire(currentRow)`, `remote` = pulled payload. The unit of merging is a GROUP, not a JSON path:

| entity | groups (fields) |
|---|---|
| collection | `name` |
| folder | `name`; `location` (parent_folder_id; `collection_id` immutable); `order` (sort_order) |
| request | `content` (name, method, url, document_json, deliberately atomic: `document_json` duplicates name/method/url); `location` (folder_id, collection_id); `order` (sort_order) |
| environment | `name` |
| environment_variable | `key`; `value` (value, is_secret) |
| collection_version | none (immutable) |

`merge(base, local, remote)`, per group g: `L = local[g] != base[g]`, `R = remote[g] != base[g]`.
- `!R` -> take local. `!L` -> take remote. `L && R && local[g] == remote[g]` -> same. Otherwise conflict, EXCEPT group `order`, which always takes remote silently (order is best-effort UI state).
- Result: `{merged payload, conflictingGroups[]}`. Pure function in `merge.ts`, exhaustively unit tested.
- A JSON-level merge of `document_json` (headers vs body edited on different devices) is deliberately out of scope for v1; it is an additive later improvement inside group `content` without changing the contract.

---------------------------------------------------------------------------------------------------------------------------

## 7. The sync engine

### 7.1 Push side: `buildOps(workspaceId)`

For every `sync_dirty` row whose `sync_entities.state != 'conflict'` (load the current row, INCLUDING soft-deleted ones):
1. Row deleted, `remote_version = 0` (never reached the server) -> drop op, clear dirty (create+delete cancel out; if a push containing it was in flight the server's `not_found` on delete is already treated as success).
2. Row deleted, known remotely -> `{op:"delete", base_version: remote_version, payload:{}}`.
3. Row live -> `payload = toWire(row)`. If `remote_version > 0` and `canonicalJson(payload) == canonicalJson(base_payload)` -> no-op: clear dirty, drop.
   Else `{op:"upsert", base_version: remote_version, payload}`. Limit check (section 3) -> quarantine as conflict kind `rejected` (`message` explains) and skip.
4. `operation_id`: reuse `sync_dirty.op_id`, else mint `newId()` and persist it (+ `sync_sent_ops` row) BEFORE the request goes out.
5. `occurred_at` = `sync_dirty` change time is not tracked; use the send time (informational).

Ordering inside a push (server applies in array order, each op independently):
1. `environment_variable` DELETEs (frees keys before same-key recreation, which locally is a new id).
2. UPSERTs in dependency order: `collection`, `environment`, `folder` sorted by depth (parents first; computed from the in-batch parent chain, otherwise parent is already remote), `request`, `environment_variable`, `collection_version`.
3. Remaining DELETEs, leaves first: `request`, `folder` (deepest first), `collection_version`, `collection`, `environment`.
Upserts precede deletes so a request moved out of a folder that is deleted in the same batch survives.

Chunking: <= 200 ops and <= 700 KB serialized per request (server default body cap 1 MB; S8 raises the push route to 8 MB and the desktop keeps 700 KB as a safe default; a single op over the cap is quarantined).
Between chunks the engine does NOT re-pull; conflicts are handled after the batch (7.3).

Result handling (one SQLite transaction per response, `applying = 1`):
- `accepted` -> `sync_entities.remote_version = max(existing, resulting_version)`, `base_payload = payload sent` (delete: `remote_deleted = 1`, `remote_version = 0`, `base_payload = NULL`), then
  `DELETE FROM sync_dirty WHERE entity = ? AND change_seq = <seq captured at build time>` (if the row changed in between the seq differs, the row stays dirty and is rebuilt next round with the new base). Delete the `sync_sent_ops` row.
- `rejected`, by `code`:
  - `sync_conflict` (with `current_version`): remote moved on. Not an error: schedule another pull -> merge (7.3). Do not touch dirty.
  - `not_found`: for a `delete` -> success (already gone); for an `upsert` with `base_version > 0` -> remote row is gone, pull will bring the tombstone and produce a `remote_deleted` conflict; for an `upsert` with `base_version 0` the PARENT is missing remotely -> same (pull first, quarantine as `rejected` if it persists after a fresh pull).
  - `invalid_request`: permanent; open conflict `kind: rejected` with the server message (state `conflict`). A later local edit of the entity (new `change_seq`) automatically re-arms it (closes the conflict `auto_resolved`).
  - `conflict` (id in use elsewhere / unique clash): variable key clash -> handled as `duplicate_key` (rename local, section 8.4); id clash in another workspace -> `rejected` (message: "this item's id is already used by another cloud workspace"); collection version label clash -> `immutable_clash`.
  - `internal_error`: treated like a transient failure for the whole chunk (retry with backoff, same operation ids).
- Whole-request failures: `401` -> refresh once (7.6) then retry; `403` -> role check (section 10); `404` workspace -> `access_state = remote_deleted`; `413` -> halve chunk, single op -> quarantine; `429/5xx/network` -> backoff (7.5). No dirty row is cleared on any failure.

### 7.2 Idempotency and lost responses

- `operation_id` is stable per `(entity, change_seq)`. A resend after a lost response is answered by the server from `sync_operations` (`accepted` with the original result).
- If the entity changes again after a lost response (`change_seq` bumped, `op_id` reset), the new op carries the OLD `base_version`, which the server may already have advanced by our earlier (applied but unacknowledged) op -> `sync_conflict`. The cycle order (pull, then push) makes this converge: the pull returns our own op (its `operation_id` is in `sync_sent_ops`); the apply step recognises it as an echo (7.3 step 1), sets `remote_version/base_payload` to it, keeps the entity dirty (its current state differs from the new base), and the next push is built with the fresh base. No user-visible conflict.
- `sync_sent_ops` is deleted on ack or echo and pruned after 14 days.

### 7.3 Pull side: `pull(workspaceId)`

```
loop:
  GET /v1/workspaces/:rid/sync/pull?client_id&after_checkpoint=<cloud_links.sync_checkpoint>&limit=200
  in ONE SQLite tx per page (applying=1, defer_foreign_keys=ON):
     for op in operations (already seq-ordered): applyRemoteOp(op)
     cloud_links.sync_checkpoint = response.checkpoint      // page end; NEVER taken from a push response
  until !has_more
```
Checkpoint discipline: the checkpoint only advances with the tx that applied the ops (crash-safe, at-least-once + idempotent apply). A push response `checkpoint` is ignored (it may cover other clients' ops we have not pulled).

`applyRemoteOp(op)` (all in `apply.ts`; `E = sync_entities` row, `L` = local row incl. deleted, `dirty` = local differs from `E.base_payload`, computed by comparing `toWire(L)`, not by trusting `sync_dirty`):
1. Echo/duplicate: upsert with `op.resulting_version <= E.remote_version`, or `operation_id` in `sync_sent_ops` -> only reconcile (`remote_version`, `base_payload`, delete `sync_sent_ops`); clear `sync_dirty` if `toWire(L) == payload`. Delete op when `E.remote_deleted` -> skip.
2. **Upsert**
   - no `L`: INSERT with pulled payload (`version = 1`, `created_at = now`, `secret_missing = 1` for secret vars), `E = (version, payload)`.
   - `L` not dirty: overwrite fields, `version = version + 1` (so an open editor gets `version_conflict` and reloads), un-delete if it was tombstoned by an earlier remote delete and recreated, `E = (version, payload)`, drop `sync_dirty`.
   - `L` deleted locally and delete is pending -> conflict `local_deleted` (8.2); `E` updated to the remote state, entity `state = conflict`.
   - `L` live and dirty -> `merge(base, local, remote)`: apply the non-conflicting merged result to `L`, `E = (version, remote payload)`, re-mark dirty (the merged row differs from the new base) with a fresh `change_seq`. If `conflictingGroups` non-empty -> open `edit_edit` conflict, `state = conflict`; the conflicting groups keep the local values until the user chooses.
   - Unique key clash for variables `(environment_id, key)` with a different live local id -> `duplicate_key` (8.4).
   - Folder cycle guard (8.5) runs after the page.
3. **Delete**
   - no `L` / `L` already deleted -> record tombstone in `E` (`remote_deleted = 1, remote_version = 0`).
   - `L` not dirty -> soft delete `L` and its local subtree exactly like the repositories do (folders: descendants + their requests; collections: folders, requests, versions; environments: variables, purging keychain refs after commit). Descendants that are DIRTY are not deleted (8.1).
   - `L` dirty (live) -> conflict `remote_deleted` (8.1).
4. Secret variables never carry values in pull. An update to an existing secret variable changes only key/is_secret; the local keychain value is kept. A remote `is_secret: false -> true` moves nothing (the plaintext `value` we already hold is kept locally and moved to the keychain by the apply; the remote copy is wiped by S3); `true -> false` sets `value` from the payload (may be `null` -> stored as empty string).

After each applied page the engine emits an `applied` event (section 11) with changed ids so the renderer can refetch.

### 7.4 Cycle

```
runCycle(workspaceId)                      // per-workspace mutex; one cycle at a time app-wide
  0. preflight: session? (else state signedOut, stop) ; client registered? ; role (GET workspace) ; protocol_version >= 2 (else serverUnsupported)
  1. if link_state == initial and snapshot_cursor != null or sync_checkpoint == 0 and never downloaded -> snapshot phase (section 9.2)
  2. for round in 1..4:
       pull()
       ops = buildOps()
       if ops.empty: break
       push(ops)                           // may set needPull
       if !needPull: break
  3. if link_state == initial and sync_dirty is empty: link_state = active
  4. last_synced_at = now; clear last_error; status -> idle (or `error`/`offline` on failure)
```
If after 4 rounds ops are still being rejected with `sync_conflict` although a fresh pull returned nothing new, the entities involved are quarantined as `rejected` conflicts (defensive; should not happen).

### 7.5 Scheduling, retries, offline

- Timers (main process, `SyncScheduler`): every 5 s per active link: `SELECT 1 FROM sync_dirty WHERE workspace_id=? LIMIT 1` -> if dirty and not in backoff -> cycle after a 1.5 s debounce (edits in flight coalesce). Full cycle every 60 s while the window is focused, 300 s otherwise. Immediately on: app start (2 s delay), window focus, `powerMonitor` `resume`, network `online`, `syncNow`, sign-in completion, conflict resolution.
- Manual `syncNow` bypasses backoff and waits for the running cycle (returns the final `SyncStatus`).
- Backoff on network/5xx/429: 5 s, 10 s, 20 s, ... capped at 5 min, +/-20% jitter, `Retry-After` honoured; reset on any successful cycle. State `offline` for network errors (`fetch` failure, DNS, timeout 30 s), `error` for 5xx. `nextRetryAt` is exposed in status.
- Offline is a normal mode: edits keep landing in `sync_dirty`; nothing else is required. On reconnect the first cycle pulls then pushes.
- `auto_sync = 0`: the 5 s dirty poll and the 60 s timer are off for that workspace; only `syncNow` runs cycles. `pendingChanges` still counts.
- No realtime channel is used (out of scope for the server rewrite); the design leaves room for a `has_changes` hint later.

### 7.6 Auth in main (`cloudHttp.ts`, `cloudAuth.ts`)

- HTTP: `fetch` (Electron `net.fetch` in the app for system proxy support; injectable `fetchImpl` for tests), 30 s timeout via `AbortController`, JSON only, never logs headers/bodies. Not `executeHttp*`, so no history rows (D11).
- Tokens: same keychain key scheme `slinger.cloud.tokens:<normalizedBaseUrl>` but the prefix `slinger.cloud.tokens:` is added to the RESERVED namespaces in `assertGenericSecureKey`, so the renderer can no longer read them via `secureStoreGet`. `secureStore*` stays for backward compatibility of other keys.
- Sign-in (device flow) moves to main: `startCloudSignIn` calls `/v1/auth/device/start`, returns the user code + URI for the renderer to display/open, and main polls `/v1/auth/device/poll` on the server-given `interval`; result is delivered as an `auth` event. Tokens go straight to the keychain.
- Refresh: single in-process mutex (`refreshing: Promise`). Proactive when the access JWT `exp` is < 60 s away, reactive on `401`. Refresh tokens are single-use with reuse detection: after a refresh network failure the engine does NOT retry the same refresh token immediately (it might have been consumed); it marks `offline` and retries on the next cycle after re-reading the keychain (which may already hold the new pair if the process persisted it before the crash: persist the new pair to the keychain BEFORE using it). A definitive `401` from `/refresh` -> tokens deleted, session `signedOut`; links stay, dirty rows keep accumulating.
- Client registration: `POST /v1/sync/clients/register` once per `(apiBaseUrl, userId, device)`; id cached in `app_settings` (`cloud.client:<base>:<userId>`) and copied to `cloud_links.sync_client_id`. On `invalid_request: unknown client_id` (different account / server reset) re-register and retry.
- Account switch: the link records `remote_user_id`. If a different user signs in, syncing continues with that user's permissions (server enforces); a 403/404 leads to `accessRevoked`.
- Base URL: `http`/`https` only; `http` allowed (dev) but the UI warns for non-loopback hosts.

---------------------------------------------------------------------------------------------------------------------------

## 8. Conflict model

Principles: (1) pull before push means most concurrency never reaches the server as a rejection; (2) user work is never discarded without a choice; (3) a conflicted entity is frozen (`state = conflict`, excluded from push) but everything else keeps syncing; (4) structure (parent/child) conflicts are resolved automatically toward the remote to keep the tree valid.

Kinds:

| kind | trigger | default while open | resolutions (`allowed`) |
|---|---|---|---|
| `edit_edit` | same group changed on both sides (8.0) | local values kept, not pushed | `keep_local`, `keep_remote`, `merge` (per-group choice), `duplicate` (request only) |
| `remote_deleted` | remote deleted an entity (or an ancestor) that has unpushed local changes | entity + its dirty descendants + ancestor chain stay alive locally | `keep_local` (restore remotely), `keep_remote` (delete mine) |
| `local_deleted` | local delete pending, remote edited the entity | stays deleted locally, delete not pushed | `keep_local` (push the delete), `keep_remote` (restore, incl. deleted ancestors that exist remotely) |
| `duplicate_key` | variable key clash on pull (both devices added `base_url`) | auto-resolved (info only) | none (`auto_resolved`) |
| `immutable_clash` | two devices created version `1.0.0` for one collection with different ids | local version hidden from lists | `keep_remote` (drop mine), `duplicate` (recreate my snapshot with `newVersion`) |
| `rejected` | server said `invalid_request`, id in use, or local limit exceeded | change stays local, not pushed | `keep_remote` (discard my change; for never-pushed entities: delete locally); editing the entity again re-arms it |

### 8.0 Detection and resolution semantics
Detection is always local, in `applyRemoteOp` (7.3). The server's `sync_conflict` rejection just triggers a pull. Resolution (`resolveSyncConflict`, all in one SQLite tx with `applying = 1`, then `syncNow`):
- `keep_local`: `E.remote_version = conflict.remote_version` (0 for `remote_deleted`), `E.base_payload = remote_json` (NULL for `remote_deleted`), `state = synced`, mark dirty. The next push wins with `base_version = remote_version` (for `remote_deleted` it is a create with `base_version 0` and the same id; the server accepts creates for ids that no longer exist). If the remote moved again meanwhile the normal path (pull, merge) repeats.
- `keep_remote`: overwrite local with `remote_json` (or delete the local subtree for `remote_deleted`, or restore for `local_deleted`), `E` reconciled, `sync_dirty` removed.
- `merge` (edit_edit): `fieldChoices: {group: 'local'|'remote'}` builds the merged payload, applies it locally, marks dirty.
- `duplicate` (request): the local version becomes a NEW request (new uuidv7, name `"<name> (conflict copy)"`, same folder if it still exists else collection root, `sort_order` appended) which is pushed as a create; the original entity takes `remote_json` (keep_remote).
  Not offered for folders/collections (would need subtree copy), where `keep_local`/`keep_remote` suffice.
- If another remote change arrives while a conflict is open, `remote_json/remote_version` are refreshed and the conflict is re-evaluated; if remote now equals local the conflict auto-closes (`auto_resolved`).
- `discardPendingChanges(workspaceId)`: resets every dirty/conflicted entity to its `base_payload` (or deletes never-pushed ones locally), closes conflicts. Used for the read-only downgrade case and as a "start over from cloud" escape hatch.

### 8.1 Delete vs edit (remote delete, local edit)
A remote delete of container X applies to X's subtree EXCEPT entities that are dirty and their ancestors up to X. Those survive locally and X (and any surviving ancestors) gets a `remote_deleted` conflict. Non-dirty descendants are deleted as usual.
`keep_local` restores: X and surviving descendants are pushed as creates (`base_version 0`), parents first (already guaranteed by push ordering). Siblings that were deleted remotely stay deleted (documented; the UI says "restore N items").
`keep_remote` deletes the surviving items locally too.

### 8.2 Delete vs edit (local delete, remote edit)
Only the remotely edited entities become conflicts (one per entity; the UI groups them by their deleted ancestor via `path`). While open, the local delete is not pushed, so the remote entity survives. Choosing `keep_local` pushes the delete with the fresh base.

### 8.3 Both sides deleted / both created
Both deleted -> tombstone reconciles silently. Both created: ids differ (UUIDv7), so nothing collides; duplicates are surfaced by the link preview only (section 9.2), never auto-merged.

### 8.4 Unique keys
`environment_variables (environment_id, key)` clash on pull apply (different ids): the LOCAL variable is renamed to `<key>_conflict` (then `_conflict2`, ...) inside the apply tx, marked dirty, and an `auto_resolved` `duplicate_key` conflict row is recorded so the UI can show "renamed X to X_conflict". The remote one takes the key. Secret value of the renamed local variable stays in the keychain under its unchanged id.

### 8.5 Folder moves and cycles across devices
Each side's move is valid on its own; combined they can form a cycle (A: F into G, B: G into F). The server validates every folder move against its current tree (`assertParentFolder`), so it never stores a cycle: the second push is rejected `invalid_request`. Locally, after each applied pull page a cycle check (`WITH RECURSIVE` over live folders) runs; every dirty folder participating in a cycle has its `parent_folder_id` reset to the remote/base parent (structure wins), and an `auto_resolved` info record is written ("folder move undone: it conflicted with a move on another device"). A folder moved into a folder that the remote deleted is handled by 8.1 (parent chain survives/conflicts).
Requests moved into a folder that was deleted remotely: request is dirty -> 8.1 (`remote_deleted` on the folder; `keep_remote` deletes the folder and, per the rule that dirty descendants are kept, the UI offers "move my request to the collection root" as the `keep_remote` outcome for requests: implemented as `folder_id = NULL` + dirty).

### 8.6 Ordering (`sort_order`)
Synced as a normal field in group `order`. Two devices appending siblings both use `max+1` -> equal values -> tie broken by `id` everywhere. Concurrent reorders: order group always takes remote silently (no user conflict). Because `placeAt` rewrites many siblings, a reorder produces up to N sort-only upserts; pull-first keeps them applying against fresh bases. Requires `ORDER BY sort_order, id` in `tree.ts` (`created_at` is per-device and would diverge), `ORDER BY id` for collections/environments lists, and in `collectionVersions.ts` snapshot queries.

### 8.7 Conflict data for the renderer
`listSyncConflicts` returns `SyncConflict[]` (section 11): identity, human `label`, `path` (`Collection / Folder / Request`), `kind`, `allowedResolutions`, per-group diff (`groups[]` with `local`, `remote`, `base` values, secret-free) and `remoteUpdatedAt` is not available (server has no author/time in pull payload; optional S10 adds `actor_display_name` + `occurred_at`).

---------------------------------------------------------------------------------------------------------------------------

## 9. Publish and link

### 9.1 Publish a local workspace ("upload everything")
`publishWorkspace(workspaceId)`:
1. Preconditions: signed in, workspace unlinked. `POST /v1/workspaces/publish {local_workspace:{name}, publish_mode:"create", client:{client_id}}` (client registered first). Response gives remote workspace + `membership.role` (`owner`) + `sync_bootstrap.checkpoint`.
2. ONE local tx: `INSERT cloud_links (link_state='initial', remote_workspace_id, remote_name, remote_role, sync_client_id, sync_checkpoint = bootstrap.checkpoint, ...)` and mark all live rows dirty:
   `INSERT OR REPLACE INTO sync_dirty SELECT 'collection', id, workspace_id, 1, NULL FROM collections WHERE workspace_id=? AND deleted=0` (and the same for folders, requests, environments, variables via join, live collection_versions). Soft-deleted rows are not uploaded.
3. Run a cycle (7.4). Progress events (`phase: 'push', done, total`). When `sync_dirty` is empty `link_state = 'active'`.
Crash/kill between 1 and 2 leaves an empty remote workspace (harmless; visible in `listRemoteWorkspaces`, linkable). Crash during 3 resumes on next start (`link_state` is still `initial`, dirty rows persist). Publishing is not repeatable to a second remote workspace for the same local content (ids are globally unique on the server): after `unlink`, republishing content whose ids already exist in the old remote workspace fails with `rejected: id in use`; the UI offers "Publish a copy" = `duplicate local workspace with fresh ids` (WP-B, small helper), documented in the open decisions.

### 9.2 Link an existing remote workspace ("initial download / merge")
`linkRemoteWorkspace({remoteWorkspaceId, localWorkspaceId | null})` (`null` = create a new empty local workspace named after the remote one, `workspace_type = 'team'`; recommended default in the UI when the local workspace has content and the remote is not empty).
1. `previewRemoteWorkspace(remoteWorkspaceId)` (separate call for the UI): `GET /v1/workspaces/:id` (name, role) + `GET .../sync/pull?after_checkpoint=0&limit=1` -> `remoteEmpty`. The UI warns "Local content will be merged with existing cloud content; duplicates are possible".
2. Refuse when: the local workspace is already linked; the remote workspace is already linked to another local workspace on this device (unique index); role is `viewer` and the local workspace has any live content (read-only workspace cannot upload; the UI must use `localWorkspaceId: null`).
3. Tx: insert `cloud_links (link_state='initial', sync_checkpoint = 0, snapshot_cursor = '')`, `read_only` from role, mark all local live rows dirty (skip when read-only/new).
4. Snapshot download (new server endpoint S6): `GET /v1/workspaces/:rid/sync/snapshot?client_id&cursor&limit=200` pages of current entities (`{resource_type, resource_id, version, payload}`) in type order + `checkpoint` captured at the first page (kept in `snapshot_cursor`). Each page is applied in one tx: entities are inserted (or, if the id already exists locally because this device is re-linking, treated as a pulled upsert with merge). After the last page: `sync_checkpoint = snapshot.checkpoint`, `snapshot_cursor = NULL`, then a normal pull from that checkpoint catches changes made during the download (idempotent thanks to the version comparison in 7.3 step 1).
5. De-duplication BEFORE the first push (only environments and variables, where server-side unique keys would otherwise cause rejections): a local environment with no remote counterpart whose name equals (case-insensitive) a remote environment name is re-keyed to the remote id (`rekeyEntity`: updates the environment row id and its variables' `environment_id` with `PRAGMA defer_foreign_keys`, `sync_entities` rows follow). Within matched environments a local variable whose key equals a remote key is re-keyed to the remote variable id (moving its keychain entry `slinger:env-var:<old>` -> `<new>`). Value rule: remote metadata wins (`is_secret`, key); for non-secret both sides with different values the remote value wins and an `auto_resolved duplicate_key` note records it; a local secret value is kept if the remote gives none. Collections/folders/requests are never matched by name (silent merging could destroy data): both sets simply coexist.
6. Push the remaining dirty local content, then `link_state = 'active'`.
Snapshot pages and push chunks are resumable: state is in `cloud_links.snapshot_cursor`, `sync_checkpoint`, `sync_dirty`.

### 9.3 Unlink / sign-out
`unlinkWorkspace`: delete the `cloud_links` row and the workspace's rows in `sync_entities`, `sync_dirty`, `sync_sent_ops`, `sync_conflicts` (one tx). Local content untouched; remote untouched; secret_missing variables remain (`secretMissing` stays true). Unlinking with pending changes: the UI shows the count first.
`signOutCloud`: revokes the refresh token (best effort), deletes tokens; links stay (`signedOut` state), dirty rows keep accumulating.

---------------------------------------------------------------------------------------------------------------------------

## 10. Permissions and read-only workspaces

- Role source: `GET /v1/workspaces/:id` (`membership.role`) at link time and once per full cycle (cheap); `listRemoteWorkspaces` returns it too. Stored in `cloud_links.remote_role`, `read_only = (role == 'viewer')`.
- `read_only = 1`: (a) SQLite `sync_readonly_*` triggers reject every local write to that workspace's synced tables with `slinger:read_only`, mapped in `toErrorPayload` to `IpcErrorPayload.code = 'read_only'`; (b) `SyncStatus.readOnly = true` so the renderer disables editing and shows a banner; (c) the cycle runs pull only. Not blocked: history, running requests, local secret values, exporting.
- Push responded `403` (role downgraded meanwhile): engine re-reads the role. If `viewer` -> `read_only = 1`, pending dirty rows are kept and shown as `pendingChanges` with the banner "Your role is now read-only: N local changes can't be uploaded" and actions `discardPendingChanges` or `unlinkWorkspace` (keep as a local copy). If the workspace answers 403/404 (`workspace_access_denied`/`not_found`) -> `access_state = revoked | remote_deleted`, sync stops, state `accessRevoked`, local content stays, pending changes preserved, UI offers unlink.
- Role upgraded to editor -> `read_only = 0` on the next cycle.
- Server also forbids viewers pushing (403) so the desktop guard is UX/consistency, not the security boundary.
- Secret values are unaffected by roles: they never leave the device.

---------------------------------------------------------------------------------------------------------------------------

## 11. IPC contract (exact additions)

Commit this section FIRST (section 18, commit C0). Text below is intended to be pasted.

### 11.1 `shared/types.ts` additions

```ts
// ---------------------------------------------------------------------------
// Cloud sync
// ---------------------------------------------------------------------------

export type CloudRole = 'owner' | 'admin' | 'editor' | 'viewer'

export type SyncEntityType =
  | 'collection'
  | 'folder'
  | 'request'
  | 'environment'
  | 'environment_variable'
  | 'collection_version'

export interface CloudConfig {
  apiBaseUrl: string
  deviceName: string
}

export interface CloudUser {
  id: string
  email: string
  displayName: string
}

export interface CloudSession {
  apiBaseUrl: string
  status: 'signedOut' | 'signingIn' | 'signedIn'
  user: CloudUser | null
  /** True when the last server contact failed for network reasons (session is still valid). */
  offline: boolean
}

export interface CloudSignInStart {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresInSec: number
  intervalSec: number
}

export interface RemoteWorkspace {
  id: string
  name: string
  slug: string
  role: CloudRole
  /** Local workspace on THIS device linked to it, if any. */
  linkedLocalWorkspaceId: string | null
}

export interface RemoteWorkspacePreview {
  id: string
  name: string
  role: CloudRole
  /** null when it could not be determined (offline mid-call). */
  remoteEmpty: boolean | null
  linkedLocalWorkspaceId: string | null
}

export type SyncState =
  | 'unlinked'
  | 'signedOut'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'accessRevoked'
  | 'serverUnsupported'

export interface SyncProgress {
  phase: 'snapshot' | 'pull' | 'push'
  done: number
  /** null when unknown (pull). */
  total: number | null
}

export interface SyncStatus {
  workspaceId: string
  linked: boolean
  state: SyncState
  apiBaseUrl: string | null
  remoteWorkspaceId: string | null
  remoteName: string | null
  role: CloudRole | null
  /** True when local writes are blocked (viewer role). Mutations reject with code 'read_only'. */
  readOnly: boolean
  autoSync: boolean
  /** Entities with local changes not yet acknowledged by the cloud. */
  pendingChanges: number
  openConflicts: number
  /** true until the first upload/download after link/publish completed. */
  initialSyncPending: boolean
  lastSyncedAt: number | null // epoch seconds
  lastError: { code: string; message: string } | null
  /** Epoch seconds of the next automatic retry while backing off, else null. */
  nextRetryAt: number | null
  progress: SyncProgress | null
}

export type SyncConflictKind =
  | 'edit_edit'
  | 'remote_deleted'
  | 'local_deleted'
  | 'duplicate_key'
  | 'immutable_clash'
  | 'rejected'

export type SyncResolution = 'keep_local' | 'keep_remote' | 'merge' | 'duplicate'

/** One field group of a conflicting entity. Values are display strings; secret values never appear. */
export interface SyncConflictGroup {
  group: 'name' | 'content' | 'location' | 'order' | 'key' | 'value'
  label: string
  conflicting: boolean
  base: string | null
  local: string | null
  remote: string | null
}

export interface SyncConflict {
  id: string
  workspaceId: string
  entityType: SyncEntityType
  entityId: string
  kind: SyncConflictKind
  status: 'open' | 'resolved' | 'auto_resolved'
  /** Entity name at detection time. */
  label: string
  /** Breadcrumb, e.g. ['Payments API', 'Auth', 'Create token']. */
  path: string[]
  message: string
  groups: SyncConflictGroup[]
  allowedResolutions: SyncResolution[]
  createdAt: number
  resolvedAt: number | null
  resolution: SyncResolution | null
}

export interface ResolveSyncConflictInput {
  conflictId: string
  resolution: SyncResolution
  /** Required for 'merge': per conflicting group, which side to keep. */
  fieldChoices?: Partial<Record<SyncConflictGroup['group'], 'local' | 'remote'>>
  /** Required for kind 'immutable_clash' + 'duplicate': the new semver label for the recreated version. */
  newVersion?: string
}

export interface LinkRemoteWorkspaceInput {
  remoteWorkspaceId: string
  /** Local workspace to merge into, or null to create a new local workspace from the cloud one. */
  localWorkspaceId: string | null
}

export type SyncEvent =
  | { type: 'status'; status: SyncStatus }
  | {
      type: 'applied'
      workspaceId: string
      /** Ids changed by pull/resolution; renderer refetches the affected lists. Capped at 500, then truncated = true. */
      changed: Array<{ entityType: SyncEntityType; entityId: string; change: 'upsert' | 'delete' }>
      truncated: boolean
    }
  | { type: 'conflicts'; workspaceId: string; open: number }
  | { type: 'auth'; session: CloudSession }
  | { type: 'signInResult'; result: 'approved' | 'expired' | 'denied' | 'cancelled' | 'error'; message: string | null }
```

Changes to existing types:
- `EnvironmentVariable` gains `secretMissing: boolean` (secret variable created by another device; value not set on this device). `revealEnvironmentVariable` for such a row rejects `not_found` as today; the renderer shows "Set value on this device".
- `IpcErrorPayload.code` gains `'read_only' | 'unauthenticated' | 'sync_blocked'` (`sync_blocked`: operation not allowed in the current sync state, e.g. link a workspace that is already linked).

### 11.2 `shared/ipc-contract.ts` additions

```ts
export interface SlingerIpcApi {
  // ...existing...

  // Cloud account (tokens never reach the renderer)
  getCloudConfig(): Promise<CloudConfig>
  setCloudConfig(config: CloudConfig): Promise<CloudConfig>
  getCloudSession(): Promise<CloudSession>
  /** Starts the device flow; main polls in the background and emits 'auth' / 'signInResult'. */
  startCloudSignIn(): Promise<CloudSignInStart>
  cancelCloudSignIn(): Promise<void>
  signOutCloud(): Promise<void>
  listRemoteWorkspaces(): Promise<RemoteWorkspace[]>
  previewRemoteWorkspace(remoteWorkspaceId: string): Promise<RemoteWorkspacePreview>

  // Sync
  getSyncStatus(workspaceId: string): Promise<SyncStatus>
  listSyncStatuses(): Promise<SyncStatus[]>            // every LINKED workspace
  /** Runs (or joins) a sync cycle and resolves with the final status. Never rejects for network errors: see status.state/lastError. */
  syncNow(workspaceId: string): Promise<SyncStatus>
  setAutoSync(workspaceId: string, enabled: boolean): Promise<SyncStatus>
  /** Creates the remote workspace, links, and starts the initial upload in the background. */
  publishWorkspace(workspaceId: string): Promise<SyncStatus>
  /** Links (merge) or downloads (localWorkspaceId null). Resolves after the link exists; download/upload continues in the background. Returns the local workspace. */
  linkRemoteWorkspace(input: LinkRemoteWorkspaceInput): Promise<{ workspace: Workspace; status: SyncStatus }>
  unlinkWorkspace(workspaceId: string): Promise<void>
  listSyncConflicts(workspaceId: string, includeResolved?: boolean): Promise<SyncConflict[]>
  resolveSyncConflict(input: ResolveSyncConflictInput): Promise<SyncStatus>
  discardPendingChanges(workspaceId: string): Promise<SyncStatus>

  /** Push channel (main -> renderer). Returns an unsubscribe function. Implemented in preload with ipcRenderer.on('sync:event'). */
  onSyncEvent(listener: (event: SyncEvent) => void): () => void
}

/** Request/response channels (invoke). Add the 18 names above to IPC_CHANNELS (all except onSyncEvent). */
export const IPC_EVENT_CHANNELS = ['sync:event'] as const
```

Rules:
- `onSyncEvent` is NOT in `IPC_CHANNELS` (it is not an invoke). `preload.ts` builds it separately; `handlers.ts` is unchanged; main sends with `mainWindow.webContents.send('sync:event', event)` only to the trusted main window; the listener payload is structured-cloneable plain JSON.
- `api.ts` validates with zod: uuid for workspace ids, `z.string().min(1).max(64)` for remote ids, `resolution` enum, `fieldChoices` record of `local|remote`, `newVersion` semver-length-limited string.
- Errors: unchanged envelope. New codes as above.
- The dev mock (`src/dev/mock`) must implement the new methods (WP-C owns it).

---------------------------------------------------------------------------------------------------------------------------

## 12. Main-process layout (WP-B files)

```
electron/services/sync/
  index.ts          createSyncService(deps): SyncService   (implements the 18 IPC methods; deps: db, secrets, fetchImpl, clock, emit, deviceName)
  cloudHttp.ts      typed HTTP client, refresh mutex, error mapping (CloudApiError{status, code, details})
  cloudAuth.ts      device flow, token store (keychain), session state, config in app_settings
  mapping.ts        row <-> wire payload, field groups, canonicalJson, limits
  merge.ts          pure 3-way merge
  outbox.ts         buildOps, ack/reject handling, chunking, ordering
  apply.ts          applyRemoteOp, cascades, cycle guard, rekeyEntity, snapshot apply
  conflicts.ts      create/refresh/resolve/list, display shaping (label/path/groups)
  linking.ts        publish, link, unlink, discardPendingChanges, dedupe
  engine.ts         runCycle, per-workspace mutex, status model, scheduler, backoff
electron/migrations/0004_sync.sql
electron/services/core.ts       + core.sync (constructed after repositories); createCore gets optional deps { fetchImpl, emit }
electron/ipc/api.ts             + delegations/validation
electron/preload.ts             + onSyncEvent
electron/main.ts                + emit -> webContents.send, powerMonitor/focus/online hooks, start/stop scheduler, before-quit stop
electron/lib/errors.ts          + read_only mapping
electron/services/secrets.ts    + reserve 'slinger.cloud.tokens:' prefix
electron/repositories/*.ts      ORDER BY changes, secret_missing/secretMissing, softDelete detach hook
```
`SyncService` never imports Electron (like the rest of the business layer): `fetch`, clock, timers, emit are injected so the whole engine is testable in plain Node.

Renderer-visible status is derived from: `cloud_links` row + in-memory `{running, backoff, progress, lastError}` per workspace + counts (`sync_dirty`, open `sync_conflicts`).

---------------------------------------------------------------------------------------------------------------------------

## 13. Renderer changes (WP-C files)

Data flow: `cloudStore` becomes a thin reactive wrapper over the IPC (`getCloudSession`, `listRemoteWorkspaces`, `getSyncStatus`, ...) and a single `onSyncEvent` subscription.
- Delete: `client.ts`, `session.ts`, `endpoints.ts`, `deviceFlow.svelte.ts` (polling moves to main), the localStorage link/config code in `config.ts` (config via `getCloudConfig/setCloudConfig`), and their tests.
- One-time legacy cleanup on startup: read `localStorage['slinger.cloud.links']` once; if present remember the entries as a dismissible hint ("This workspace used to be linked to <name>; link it again to sync") and remove the key + `slinger.cloud.config` after copying config to `setCloudConfig` (only if the main-process config is still default). Legacy links are NOT auto-converted (they never synced content; linking is a merge that needs consent).
- UI pieces: sync badge in the status bar/workspace switcher (state icon, pending count, conflicts count, tooltip with `lastSyncedAt`/`lastError`), "Sync now" button + "Auto sync" toggle in `WorkspaceLinkPanel`, `PublishLinkFlow` (publish / link-existing with `previewRemoteWorkspace` warning and the merge-or-download choice), `ConflictsDialog.svelte` (list from `listSyncConflicts`; per conflict shows `path`, `groups[]` local vs remote side by side, buttons from `allowedResolutions`; `merge` shows a per-group radio; `duplicate` for requests), read-only banner when `status.readOnly` and disabled edit controls, `accessRevoked` banner with Unlink, offline chip.
- Reactivity: on `applied` events refetch lists for the affected workspace (collections tree, environments, open request editor: if the open request id is in `changed`, show "changed remotely" and reload unless the editor has unsaved edits, in which case the existing `version_conflict` path on save still protects them). `status` events update the badge. `conflicts` event refreshes the dialog.
- Error mapping: `read_only` -> toast "This workspace is read-only (viewer)"; `sync_blocked`/`unauthenticated` -> inline message.
- Secret variables with `secretMissing`: variable row shows "Value not set on this device" with the existing edit flow.
- e2e: update `e2e/cloud.e2e.test.ts` to the new flow (sign in via IPC-driven device flow, publish uploads a collection, a second launch links and downloads).

---------------------------------------------------------------------------------------------------------------------------

## 14. Sync v2 server changes (slinger-admin/server)

All additive/backward compatible unless noted. Files are in `slinger-admin/server/`. Add ONE Prisma migration (timestamped, after whatever the other agents add) plus code, OpenAPI (`openapi.yaml`/`src/openapi.ts` generation via `defineRoute`), README and tests in `test/sync.test.ts` / `test/content.test.ts`.

| # | Change | Where | Notes |
|---|---|---|---|
| S1 | `sort_order Int @default(0)` on `Folder` and `Request` | `prisma/schema.prisma`, `lib/dto.ts` (`folderSchema/requestSchema` + serializers), `services/content.ts` (`folderData/requestData` optional `sort_order`, create/update, `syncPayload`), REST list order `orderBy: [{sortOrder:"asc"},{id:"asc"}]` | Payload field `sort_order` (int >= 0, default 0). Unknown to old clients (ignored). |
| S2 | Requests may change `collection_id` (same workspace) | `services/syncApply.ts` request branch: replace the "cannot move between collections" rejection with: target collection must exist in the workspace, `folder_id` (if given) must belong to the TARGET collection; update `collectionId` in `updateRequest`. Keep the folder rule (a folder cannot change collection) | Matches local `moveRequest`. REST PATCH may stay restricted. |
| S3 | Secret variables in sync | `services/content.ts` (`variableData`, `putVariable`), `services/syncApply.ts` | `variableData.value` becomes `z.string().nullable()`. On the SYNC path: `is_secret: true` requires `value == null` else `invalid_request` ("secret values must not be synced"); a secret is stored with a NULL value unless the dashboard set one (an existing stored secret ciphertext is kept when the sync payload has `value:null`). Converting non-secret -> secret wipes the stored plaintext (store NULL or keep ciphertext). Variable `key` may be renamed by id (locate by `id`; clash with another live key -> `conflict`); `environment_id` still immutable. REST behaviour for dashboard-entered secrets is unchanged. |
| S4 | Folder delete logs descendants | `services/content.ts` `deleteFolder` | Already in the working tree (uncommitted, another agent, with a test in `test/sync.test.ts`). Do not duplicate. `README.md` "Known limitations" bullet must be removed when it lands. The desktop still applies the cascade defensively. |
| S5 | Delete tombstone version | `services/content.ts` `log(...,"delete")` | Optional: log `resulting_version = row.version + 1` for deletes so a resurrect (create, version 1) is always < tombstone ordering. Not required by the design (desktop resets `remote_version` to 0 on tombstone). Skip unless trivial. |
| S6 | Snapshot endpoint | new `routes/sync.ts` route + `services/syncSnapshot.ts` | `GET /v1/workspaces/:workspaceId/sync/snapshot?client_id&cursor&limit(1..500, default 200)`, `pre: requireWorkspaceRole("viewer")` -> `{checkpoint:int, entities:[{resource_type, resource_id, version, payload}], next_cursor: string|null}`. Order: `collection, environment, folder, request, environment_variable, collection_version`, each by `id`. Cursor = base64url JSON `{c: checkpoint, t: typeIndex, a: lastId}`; `checkpoint` = workspace `syncCheckpoint` read BEFORE reading rows on the first page and echoed via the cursor thereafter. Payloads use `syncPayload()` (secret values masked -> `value: null`). No tombstones. Consistency argument: rows may be newer than `checkpoint`; clients re-apply the log from `checkpoint` idempotently by version comparison. |
| S7 | `collection_version` resource | `prisma/schema.prisma` (`CollectionVersion`: `id`, `workspaceId` FK cascade, `collectionId` FK cascade, `semver`, `notes?`, `snapshotJson @db.Text`, `folderCount`, `requestCount`, `createdAt`, `version Int @default(1)`; `@@unique([collectionId, semver])`), `services/syncLog.ts` (`SyncResourceType`), `services/syncApply.ts` (`resourceTypes`), `services/content.ts` (`syncPayload`) | Wire payload `{collection_id, semver, notes, snapshot_json (<= 8 MB), folder_count, request_count, created_at}`. `upsert` of a new id: create (`base_version 0`). `upsert` of an existing id: idempotent success if payload identical, else `conflict` ("versions are immutable"). Same `(collection, semver)` with a different id -> P2002 -> existing mapping returns `conflict`. `delete`: hard delete (base_version must be 1). Deleting the collection cascades and logs child deletes (as for folders/requests). Optional read-only REST `GET .../collections/:id/versions` for the dashboard (P2). |
| S8 | Body limit for sync push | `routes/sync.ts` route config `bodyLimit: 8 * 1024 * 1024` for push (and the content-type parser in `app.ts` must honour per-route limit) | Keep the global 1 MB elsewhere. Desktop still targets <= 700 KB per push. |
| S9 | Validation parity with desktop | `services/content.ts` | `name` max 500 for requests (desktop cap); `method` = any HTTP token (`/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/`, <= 32) instead of the enum; keep `document_json` <= 900_000 (desktop quarantines larger ones). |
| S10 | Pull op author (optional, P2) | `SyncOperation.actorUserId String?` (migration), `syncLog.recordChange`, pull DTO adds `actor_user_id`, `actor_display_name` | Lets the conflict UI say "changed by Ana". Not required. |
| S11 | Capability advertisement | `POST /v1/sync/clients/register` response: add `protocol_version: 2` and `features: ["sort_order","snapshot","collection_version","secret_metadata"]` (top level next to `client`) | The desktop refuses to sync (`serverUnsupported`) if `protocol_version < 2`, because an old server would silently drop `sort_order` and reject secret metadata. |
| S12 | Rate limits | `app.ts` | Ensure `/sync/*` is not covered by the login limiter; add a generous per-user limit (e.g. 120 req/min) with `Retry-After` on 429 (desktop honours it). |

Server tests to add (Vitest against the throwaway Postgres already used by `test/*.test.ts`): `sort_order` round trip in push/pull/REST; request move across collections via push and its folder validation; secret variable push with `value:null`, rejection when a secret carries a value, plaintext wiped on conversion, key rename; snapshot pagination/cursor/masking/viewer access/consistency with concurrent writes; `collection_version` create/replay/immutability/clash/cascade; register response advertises v2; 8 MB push accepted, 9 MB rejected.

---------------------------------------------------------------------------------------------------------------------------

## 15. Test plan

Unit (plain Node, in-memory SQLite, no network) `electron/__tests__/sync/*.test.ts`:
- `triggers.test.ts`: every synced write path marks the right dirty rows (repositories, cascade soft delete, `placeAt` sibling rewrites, `restoreCollectionVersion` replace/copy, Postman import, variable secret edit), nothing marked for unlinked workspaces or while `applying = 1`; read-only triggers raise `slinger:read_only` and map to `read_only`; migration applies on a DB that already has 0001-0003 data.
- `mapping.test.ts`: payload shape per entity, secret variables never contain a value, canonicalJson stability, limit quarantine.
- `merge.test.ts`: table-driven 3-way merge for every group (only-local, only-remote, both-same, both-different, order auto-remote), request name-vs-document merged, location conflicts.
- `outbox.test.ts`: create+delete cancel, no-op elimination (restore-replace collection, secret value edit), ordering (var deletes first, parents before children, upserts before deletes), chunk limits, `op_id` stability and reset, ack clears only matching `change_seq`, parent-cascade delete pruning.
- `apply.test.ts`: every branch of `applyRemoteOp` (insert, overwrite, echo, merge, edit-vs-delete both directions, cascades with dirty descendants preserved, unique-key clash rename, cycle guard, resurrect after tombstone, secret_missing creation, keychain purge on remote delete), `rekeyEntity` incl. keychain move.
- `conflicts.test.ts`: every resolution for every kind, re-evaluation when remote changes again, auto-close, `discardPendingChanges`.
- `engine.test.ts` with a scripted fake server (fetch stub): pull-then-push order, 401 refresh once (mutex, persist-before-use), 403 viewer downgrade, 404 revoked, 413 halving, 429 Retry-After, backoff curve with fake timers, lost response replay (same `op_id`), lost response + intervening edit (echo recognition), checkpoint only from pull, crash between accept and clear (re-run converges).
- `cloudAuth.test.ts`: device flow states, tokens only in keychain, reserved-prefix guard, config persistence.
- Renderer (`vitest` + jsdom, mocked `window.slinger`): badge states, conflicts dialog resolution payloads, read-only banner, applied-event refetch, legacy localStorage cleanup.

Server: see section 14 (Vitest with `app.inject()`).

Integration (desktop engine vs a REAL server + throwaway Postgres), `electron/__tests__/sync-it/*.it.test.ts`, its own config `vitest.sync-it.config.ts`, skipped unless `SLINGER_SYNC_IT_SERVER_DIR` (path to `slinger-admin/server`) is set:
- `scripts/sync-it-server.mjs`: starts `docker run postgres:16-alpine` on a random port (or uses `SLINGER_SYNC_IT_DATABASE_URL`), `prisma migrate deploy`, starts the server (`tsx src/index.ts` with a random `PORT`, generated signing secret, bootstrap admin), prints the base URL; tests obtain tokens through the real device flow (`/v1/auth/device/start`, browser login + `/device/approve`, `/poll`) and seed them in a `MemorySecretStore`.
- Scenarios: publish uploads N collections/folders/requests/envs/versions (secret metadata only: assert the server DB has no secret plaintext); link-existing download on a second core; restart-resumable initial upload (kill mid-push); viewer link is read-only and local writes fail; editor->viewer downgrade mid-life; revoked membership; server 5xx/network drop via a TCP proxy; body-limit chunking with large `document_json`; register `protocol_version` gate against a stubbed old server.

Two-device convergence e2e (`electron/__tests__/sync-it/convergence.it.test.ts`): two independent cores (own SQLite, own `MemorySecretStore`, own client id) against one server. A seeded, deterministic fuzzer (fixed seeds committed, e.g. 1..20; `SEED` env for repro) applies random operations to each device while "offline" (create/rename/edit request/move request between folders and collections/reorder/delete folder+cascade/restore version replace+copy/variable add/rename/secret toggle/delete), then syncs in random order until both quiesce; conflicts are auto-resolved with a random resolution. Invariants after quiescence: (1) both devices have identical live entity sets and identical non-secret payloads (`toWire` equality) and identical ordered lists (`sort_order,id`); (2) server state equals the devices' state (via `/sync/snapshot`); (3) no orphan (every parent exists and is live), no folder cycle, no duplicate live `(environment,key)`; (4) secret plaintext never appears in server DB or in any request body captured by a recording proxy; (5) an entity edited only on device A converges to A's value; (6) no `sync_dirty` rows remain, `openConflicts = 0`. Plus fixed hand-written scenarios: concurrent rename (conflict + resolution each way), edit-vs-delete both ways, folder-move cycle, duplicate variable key, same-label version clash, delete of a big folder while the other device adds a request in it.
CI: unit tests always; integration + convergence in a separate job with Postgres service container (mirrors `slinger-admin` CI).

---------------------------------------------------------------------------------------------------------------------------

## 16. Migration plan

Desktop:
1. `0004_sync.sql` as in section 4 (also adds triggers). Runner already applies it transactionally and checksums it; do not edit afterwards; later changes are `0005_...`.
2. Existing installs: `cloud_links` is empty (nothing wrote it), so no data migration. No existing entity is marked dirty until a workspace is linked.
3. Renderer localStorage: `slinger.cloud.config` migrated once to `setCloudConfig`, `slinger.cloud.links` shown as a relink hint then deleted (section 13). Old renderer-side tokens in the keychain (`slinger.cloud.tokens:<base>`) are reused as-is by the main process (same key format `{accessToken, refreshToken}`), so users stay signed in.
4. Rollout order of behaviour: the trigger/read-only machinery is inert without links; `secretMissing` default false.
5. Downgrade: an older app that finds `_migrations` containing 0004 refuses to start (existing rule "database newer than app"); acceptable.

Server: one Prisma migration `<timestamp>_sync_v2` (S1, S7, S10) applied by `prisma migrate deploy` in the entrypoint; all columns have defaults so existing rows keep working; old desktop builds ignore new fields.

---------------------------------------------------------------------------------------------------------------------------

## 17. History noise fix

Root cause: `CloudClient` sends through `executeHttpRequest`, which records history for every call. Fix = D10: `cloudHttp.ts` in main uses `fetch` directly and never touches `HistoryRepository`. Until WP-B lands, do NOT paper over it in `httpService.ts`. When WP-C removes `client.ts`, nothing in the renderer calls `executeHttpRequest` for cloud purposes any more. Test: after a full publish/sync cycle `listHistory(workspaceId)` is empty (integration test asserts it).

---------------------------------------------------------------------------------------------------------------------------

## 18. Work packages, ownership and order

Three agents, one shared contract. Nobody edits a file owned by another package; requests for changes go through the contract commit.

### WP-A  Server (slinger-admin/server) - owner: server agent
Owns: `server/prisma/**`, `server/src/**` (sync routes/services/content/dto/openapi), `server/test/**`, `server/openapi.yaml`, `server/README.md`, `docs/api-contract-v2.md` (append a "Sync v2" delta).
Deliver: S1, S2, S3, S6, S7, S8, S9, S11, S12 (+ S10 optional, S4 verify only) with tests. Wire contract = section 14 + sections 3 and 7.1 (payload shapes, snapshot response). Commit in two steps: (A1) schema + payload changes + register `protocol_version` (unblocks desktop unit/engine work), (A2) snapshot + `collection_version` + limits.
Depends on nothing. Desktop integration tests depend on A1+A2.

### WP-B  Desktop engine + contract - owner: engine agent
Owns: `shared/types.ts`, `shared/ipc-contract.ts`, `shared/ipc-errors.ts`, `electron/**` (migrations, `services/sync/**`, `services/core.ts`, `ipc/*`, `preload.ts`, `main.ts`, `lib/errors.ts`, `services/secrets.ts`, repositories), `electron/__tests__/**`, `scripts/sync-it-server.mjs`, `vitest.sync-it.config.ts`, `docs/ARCHITECTURE.md` + `electron/README.md` updates.
Order inside WP-B: C0 contract commit (below) -> `0004_sync.sql` + mapping/merge/outbox/apply units -> engine + auth -> linking/conflicts -> IPC wiring -> integration/convergence tests (when WP-A is in) -> collection versions sync (last).

### WP-C  Renderer UI - owner: UI agent
Owns: `src/features/cloud/**`, new `src/features/sync/**`, `src/app/**` (sync state), `src/dev/mock/**` (mock for the new IPC methods, including scripted conflict states), status-bar/workspace-switcher edits, `src/features/environments/**` (secretMissing), renderer tests, `e2e/cloud.e2e.test.ts` + `e2e/support/**`, `docs/USER_GUIDE.md` sync section.
Works entirely against the mock until WP-B integration lands.

### Commit order (hard rule)
1. **C0 (first, alone, by WP-B, small):** `shared/types.ts` + `shared/ipc-contract.ts` (+ `ipc-errors.ts` helper unchanged) exactly as in section 11, plus minimal compile-only stubs: `api.ts` methods returning `unlinked` statuses / `sync_blocked` errors, `preload.ts` `onSyncEvent` no-op, `IPC_CHANNELS` extended, `EnvironmentVariable.secretMissing` populated as `false`. Nothing else may touch `shared/` after C0 except through a follow-up contract commit that WP-B/WP-C rebase on. Contract changes after C0 are additive and must be announced in the PR description.
2. In parallel after C0: WP-A A1/A2, WP-B remainder, WP-C (mocked).
3. Merge order: WP-A (A1, A2) -> WP-B engine (unit tests green without server) -> WP-B integration/convergence (needs WP-A) -> WP-C wiring to real IPC (delete mock paths) -> collection-version sync.
4. Cross-package acceptance: `npm test` (main+renderer), server `npm test`, sync-it suite, cloud e2e.

---------------------------------------------------------------------------------------------------------------------------

## 19. Risks and decisions where a default was chosen

1. **Workspace rename not synced (D2).** Chosen to avoid an owner-only remote write and a second conflict domain; visible remote name refreshes each cycle. Easy to add later as a `workspace` resource type.
2. **Request `document_json` is merged atomically with name/method/url (group `content`).** Simple and safe given the denormalised copies inside the document; users editing different parts of one request on two devices get a conflict prompt. JSON-level merge is an additive follow-up.
3. **Triggers (D6).** Correct-by-construction but SQL-heavy; risk is trigger/column drift when repositories add synced columns. Mitigation: `triggers.test.ts` derives the column list from `PRAGMA table_info` and fails if a table gains a column not classified as synced/ignored.
4. **Global entity id uniqueness on the server.** A local workspace can only ever be published once per server; republishing after unlink fails with "id in use". Default: refuse with a clear message and offer "publish a copy" (fresh ids). Alternative (server-side per-workspace ids) rejected as a much larger change.
5. **Collections/folders/requests are unioned, not name-matched, when linking.** May produce duplicates when the same content was independently imported on two devices; chosen over silent merging. UI warns using `remoteEmpty`.
6. **Refresh-token rotation reuse detection.** A crash between the server rotating and us persisting the new pair forces re-sign-in. Mitigated by persist-before-use and no automatic re-refresh after network failures; a server-side short reuse grace window would remove the residual risk (suggested, not required).
7. **Requests > 900 KB `document_json`, names > 200 chars, keys > 128 chars** are quarantined locally as `rejected` until server caps are aligned (S9 covers name/method; document cap left at 900 KB deliberately).
8. **Cascade-delete pruning** (dropping child delete ops when the parent delete is in the batch) relies on server cascade + tombstones (S4 for folders; collections/environments already log children). If S4 is not landed the desktop must not prune folder subtrees.
9. **Local `ORDER BY` change (`sort_order, id`)** alters tie order for existing data sets created within one second; harmless, but it is a behaviour change WP-B must test.
10. **Polling, no realtime.** Worst-case remote change latency 60 s (focused) / 5 min (blurred) or on focus/manual sync. Acceptable for v1.
11. **Pull from checkpoint 0 for very old workspaces** replays the log; the snapshot endpoint (S6) removes that for the first download. Log compaction / `410 checkpoint_expired` handling is not designed here: if introduced, the engine's answer is "re-snapshot with merge" (same code path as link).
12. **One account per API base URL** at a time (tokens keyed by base URL, as today).
13. **Delete-vs-edit UX volume:** local cascade deletes can create many `local_deleted` conflicts if another device edited many children. UI groups by ancestor path; a bulk "keep all local" can be added without contract changes (`resolveSyncConflict` in a loop).
14. **Viewer role local guard is enforced at the SQLite layer.** Anything writing synced tables for a read-only workspace without `applying = 1` will throw; new code paths must expect `read_only`.
