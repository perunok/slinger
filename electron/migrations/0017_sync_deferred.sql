-- Remote changes (pulled operations, snapshot entities) that could not be applied yet: their parent is not on this
-- device (an older server sends a nested folder before its parent), or applying them failed. The checkpoint still
-- advances, so they are kept here and applied again after every snapshot page and pull page, until they succeed or a
-- newer change of the same entity replaces them. Local only: never synced, no capture triggers.
CREATE TABLE sync_deferred (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  op           TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  version      INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT,
  op_id        TEXT,
  reason       TEXT NOT NULL CHECK (reason IN ('missing_parent', 'failed')),
  message      TEXT,
  attempts     INTEGER NOT NULL DEFAULT 1,
  noted        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_sync_deferred_ws ON sync_deferred(workspace_id, created_at);
