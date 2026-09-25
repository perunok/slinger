-- Collection sync (docs/SYNC_DESIGN.md sections 4-6): bookkeeping tables, change-capture triggers and
-- read-only enforcement triggers. Never edit after release; later changes go into 0005+.

-- Non-secret app settings (cloud config, sync client ids). Tokens live in the OS keychain only.
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- cloud_links (created in 0001, unused until now): sync bookkeeping.
ALTER TABLE cloud_links ADD COLUMN remote_name TEXT NOT NULL DEFAULT '';
ALTER TABLE cloud_links ADD COLUMN remote_role TEXT;
ALTER TABLE cloud_links ADD COLUMN remote_user_id TEXT;
ALTER TABLE cloud_links ADD COLUMN link_state TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE cloud_links ADD COLUMN auto_sync INTEGER NOT NULL DEFAULT 1;
ALTER TABLE cloud_links ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_links ADD COLUMN access_state TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE cloud_links ADD COLUMN last_synced_at INTEGER;
ALTER TABLE cloud_links ADD COLUMN last_error_code TEXT;
ALTER TABLE cloud_links ADD COLUMN last_error_message TEXT;
ALTER TABLE cloud_links ADD COLUMN snapshot_cursor TEXT;
CREATE UNIQUE INDEX idx_cloud_links_remote ON cloud_links(api_base_url, remote_workspace_id);

-- Last state both sides agreed on, per entity (the 3-way merge base).
CREATE TABLE sync_entities (
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  remote_version INTEGER NOT NULL DEFAULT 0,
  base_payload   TEXT,
  remote_deleted INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'synced',
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_sync_entities_ws ON sync_entities(workspace_id);

-- Dirty set (outbox), written by the triggers below. change_seq lets the engine clear exactly what it sent.
CREATE TABLE sync_dirty (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  change_seq   INTEGER NOT NULL DEFAULT 1,
  op_id        TEXT,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_sync_dirty_ws ON sync_dirty(workspace_id);

-- Operation ids sent and not yet acknowledged/echoed (recognises our own ops in a pull after a lost response).
CREATE TABLE sync_sent_ops (
  op_id        TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  sent_at      INTEGER NOT NULL
);
CREATE INDEX idx_sync_sent_ops_ws ON sync_sent_ops(workspace_id);

CREATE TABLE sync_conflicts (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  groups         TEXT NOT NULL DEFAULT '[]',
  base_json      TEXT,
  local_json     TEXT,
  remote_json    TEXT,
  remote_version INTEGER NOT NULL DEFAULT 0,
  label          TEXT NOT NULL DEFAULT '',
  message        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open',
  resolution     TEXT,
  created_at     INTEGER NOT NULL,
  resolved_at    INTEGER
);
CREATE INDEX idx_sync_conflicts_ws ON sync_conflicts(workspace_id, status);
CREATE UNIQUE INDEX idx_sync_conflicts_open ON sync_conflicts(entity_type, entity_id) WHERE status = 'open';

-- Single row. The engine sets applying = 1 inside its own transaction so the triggers ignore remote-applied writes.
CREATE TABLE sync_control (id INTEGER PRIMARY KEY CHECK (id = 1), applying INTEGER NOT NULL DEFAULT 0);
INSERT INTO sync_control (id, applying) VALUES (1, 0);

-- Secret variables that arrived from another device have no value on this device yet.
ALTER TABLE environment_variables ADD COLUMN secret_missing INTEGER NOT NULL DEFAULT 0;


-- collections: change capture (collection)
CREATE TRIGGER sync_dirty_collections_i AFTER INSERT ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_collections_u AFTER UPDATE OF name, deleted ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- collections: read-only (viewer) workspaces reject local writes; mapped to the `read_only` IPC error
CREATE TRIGGER sync_readonly_collections_i BEFORE INSERT ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_collections_u BEFORE UPDATE OF name, deleted ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;


-- folders: change capture (folder)
CREATE TRIGGER sync_dirty_folders_i AFTER INSERT ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('folder', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_folders_u AFTER UPDATE OF collection_id, parent_folder_id, name, sort_order, deleted ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('folder', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- folders: read-only (viewer) workspaces reject local writes; mapped to the `read_only` IPC error
CREATE TRIGGER sync_readonly_folders_i BEFORE INSERT ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_folders_u BEFORE UPDATE OF collection_id, parent_folder_id, name, sort_order, deleted ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;


-- requests: change capture (request)
CREATE TRIGGER sync_dirty_requests_i AFTER INSERT ON requests
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('request', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_requests_u AFTER UPDATE OF collection_id, folder_id, name, method, url, document_json, sort_order, deleted ON requests
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('request', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- requests: read-only (viewer) workspaces reject local writes; mapped to the `read_only` IPC error
CREATE TRIGGER sync_readonly_requests_i BEFORE INSERT ON requests
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_requests_u BEFORE UPDATE OF collection_id, folder_id, name, method, url, document_json, sort_order, deleted ON requests
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;


-- environments: change capture (environment)
CREATE TRIGGER sync_dirty_environments_i AFTER INSERT ON environments
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('environment', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_environments_u AFTER UPDATE OF name, deleted ON environments
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('environment', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- environments: read-only (viewer) workspaces reject local writes; mapped to the `read_only` IPC error
CREATE TRIGGER sync_readonly_environments_i BEFORE INSERT ON environments
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_environments_u BEFORE UPDATE OF name, deleted ON environments
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;


-- environment_variables: change capture (environment_variable)
CREATE TRIGGER sync_dirty_environment_variables_i AFTER INSERT ON environment_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = (SELECT e.workspace_id FROM environments e WHERE e.id = NEW.environment_id))
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('environment_variable', NEW.id, (SELECT e.workspace_id FROM environments e WHERE e.id = NEW.environment_id), 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_environment_variables_u AFTER UPDATE OF environment_id, key, value, is_secret, deleted ON environment_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = (SELECT e.workspace_id FROM environments e WHERE e.id = NEW.environment_id))
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('environment_variable', NEW.id, (SELECT e.workspace_id FROM environments e WHERE e.id = NEW.environment_id), 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- environment_variables: read-only (viewer) workspaces reject local writes; mapped to the `read_only` IPC error
CREATE TRIGGER sync_readonly_environment_variables_i BEFORE INSERT ON environment_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = (SELECT e.workspace_id FROM environments e WHERE e.id = NEW.environment_id) AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_environment_variables_u BEFORE UPDATE OF environment_id, key, value, is_secret, deleted ON environment_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = (SELECT e.workspace_id FROM environments e WHERE e.id = NEW.environment_id) AND l.read_only = 1) AND NOT (OLD.is_secret = 1 AND NEW.is_secret = 1 AND OLD.key = NEW.key AND OLD.deleted = NEW.deleted AND OLD.environment_id = NEW.environment_id)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;


-- collection_versions: change capture (collection_version)
CREATE TRIGGER sync_dirty_collection_versions_i AFTER INSERT ON collection_versions
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection_version', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_collection_versions_u AFTER UPDATE OF deleted ON collection_versions
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection_version', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- collection_versions: read-only (viewer) workspaces reject local writes; mapped to the `read_only` IPC error
CREATE TRIGGER sync_readonly_collection_versions_i BEFORE INSERT ON collection_versions
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_collection_versions_u BEFORE UPDATE OF deleted ON collection_versions
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
