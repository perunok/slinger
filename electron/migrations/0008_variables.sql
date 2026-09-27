-- Persisted collection variables (Postman `variable` array of a collection) and workspace globals (`pm.globals`).
-- Both are LOCAL-ONLY: the cloud protocol has no entity for them, so there are no change-capture triggers
-- (0004) on these tables and sync never reads them. Viewer (read-only) workspaces refuse local writes, like every
-- other content table (see 0005/0006).
--
-- Separate tables instead of reusing environments with a kind flag: the 0004 triggers on environments /
-- environment_variables would capture such rows into sync_dirty, and every sync query would need a filter.
-- Secret handling is shared in code (electron/repositories/variables.ts + services/secrets.ts), not in the schema.
-- Never edit after release; later changes go into 0009+ (0009 is reserved for OAuth 2.0).

-- Collection variables are part of the collection (exported, versioned), so they are never secret.
-- workspace_id is denormalized (like folders/requests) so the read-only triggers and workspace cascades stay simple.
CREATE TABLE collection_variables (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_collection_variables_unique_key ON collection_variables(collection_id, key) WHERE deleted = 0;
CREATE INDEX idx_collection_variables_order ON collection_variables(collection_id, sort_order) WHERE deleted = 0;

-- Globals: per workspace, with secrets exactly like environment variables: when is_secret = 1, `value` is NULL
-- and the value lives in the OS keychain under `slinger:global-var:<id>` (secret_ref).
CREATE TABLE global_variables (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  secret_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_global_variables_unique_key ON global_variables(workspace_id, key) WHERE deleted = 0;
CREATE INDEX idx_global_variables_order ON global_variables(workspace_id, sort_order) WHERE deleted = 0;

-- Read-only (viewer) cloud workspaces reject local writes of both tables.
CREATE TRIGGER sync_readonly_collection_variables_i BEFORE INSERT ON collection_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_collection_variables_u BEFORE UPDATE ON collection_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_global_variables_i BEFORE INSERT ON global_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_global_variables_u BEFORE UPDATE ON global_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
