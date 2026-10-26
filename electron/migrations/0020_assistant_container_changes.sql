-- assistant_changes (0019) gains kind 'container': the auth of a collection or folder (0018) as an AI assistant wrote it
-- (an import or a version restore through MCP), ref = 'collection:<id>' / 'folder:<id>', fingerprint = its auth_json.
-- A request that inherits such an auth sends the assistant's own value, not the user's credential, until the user changes
-- the auth (fingerprint mismatch) or saves it in the window (row removed). SQLite cannot alter a CHECK: the table is rebuilt.
-- Local-only like 0019. Never edit after release; later changes go into 0021+.

CREATE TABLE assistant_changes_new (
  kind         TEXT NOT NULL CHECK (kind IN ('request', 'variable', 'container')),
  ref          TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  created      INTEGER NOT NULL DEFAULT 0,
  changed_at   INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);
INSERT INTO assistant_changes_new (kind, ref, workspace_id, fingerprint, created, changed_at)
  SELECT kind, ref, workspace_id, fingerprint, created, changed_at FROM assistant_changes;
DROP TABLE assistant_changes;
ALTER TABLE assistant_changes_new RENAME TO assistant_changes;
CREATE INDEX idx_assistant_changes_ws ON assistant_changes(workspace_id);
