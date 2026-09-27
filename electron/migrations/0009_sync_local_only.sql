-- Cloud sync of the data that used to be local-only (docs/SYNC_DESIGN.md section 21): collection/folder scripts
-- (0005) and documentation (0006), collection variables and workspace globals (0008). Change capture for linked
-- workspaces into sync_dirty, exactly like the 0004 triggers (suppressed while the engine applies, i.e. applying = 1).
-- Whether a change is actually pushed depends on the server's capabilities (cloud_links.sync_features): with an older
-- server the rows are marked dirty and then dropped by the engine without a push (the data stays local-only).
-- Never edit after release; later changes go into 0010+.

-- Effective sync extension features of a link (JSON array, e.g. ["folder_scripts","docs"]); NULL = not known yet
-- (treated as none until the first pull/snapshot answer says otherwise).
ALTER TABLE cloud_links ADD COLUMN sync_features TEXT;

-- A secret global that arrived from another device has no value on this device yet (like environment_variables, 0004).
ALTER TABLE global_variables ADD COLUMN secret_missing INTEGER NOT NULL DEFAULT 0;


-- collections / folders: scripts and documentation become synced columns (separate triggers so 0004's stay untouched)
CREATE TRIGGER sync_dirty_collections_extras_u AFTER UPDATE OF scripts_json, description, description_type ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_folders_extras_u AFTER UPDATE OF scripts_json, description, description_type ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('folder', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- (read-only triggers for these columns exist since 0005/0006)


-- collection_variables: change capture (collection_variable)
CREATE TRIGGER sync_dirty_collection_variables_i AFTER INSERT ON collection_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection_variable', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_collection_variables_u AFTER UPDATE OF collection_id, key, value, enabled, description, sort_order, deleted ON collection_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection_variable', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- (read-only triggers since 0008)


-- global_variables: change capture (global_variable)
CREATE TRIGGER sync_dirty_global_variables_i AFTER INSERT ON global_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('global_variable', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_global_variables_u AFTER UPDATE OF key, value, is_secret, enabled, description, sort_order, deleted ON global_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('global_variable', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
-- Read-only (viewer) workspaces: 0008 refused every update. Now that secret globals come from the cloud without a value,
-- a viewer must still be able to set this device's value of a secret (keychain only; the row keeps key/flags), exactly
-- like the environment-variable exemption in 0004.
DROP TRIGGER sync_readonly_global_variables_u;
CREATE TRIGGER sync_readonly_global_variables_u BEFORE UPDATE ON global_variables
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
 AND NOT (OLD.is_secret = 1 AND NEW.is_secret = 1 AND OLD.key = NEW.key AND OLD.deleted = NEW.deleted AND OLD.enabled = NEW.enabled
          AND OLD.description IS NEW.description AND OLD.sort_order = NEW.sort_order AND OLD.workspace_id = NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
