-- Collection- and folder-level auth (Postman `auth` on the collection and on folder items), inherited by requests whose
-- own auth is "inherit" (absent / null in their document). The column holds the Postman `auth` object as JSON text
-- ('{"type":"bearer","bearer":[...]}'), never an OAuth 2.0 token; NULL = none set: for a folder that means "inherit from
-- the parent", for a collection "no auth". A folder that stops inheritance stores '{"type":"noauth"}'.
-- Synced like the 0009 extras, but only with a server that advertises the `container_auth` feature
-- (docs/SYNC_DESIGN.md section 21.6); with any other server the column stays on this device.
-- Never edit after release; later changes go into 0019+.

ALTER TABLE collections ADD COLUMN auth_json TEXT;
ALTER TABLE folders ADD COLUMN auth_json TEXT;

-- Read-only (viewer) cloud workspaces reject local auth edits, like every other local write.
CREATE TRIGGER sync_readonly_collections_auth BEFORE UPDATE OF auth_json ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_folders_auth BEFORE UPDATE OF auth_json ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;

-- Change capture for linked workspaces (suppressed while the engine applies), like 0009's extras triggers.
CREATE TRIGGER sync_dirty_collections_auth_u AFTER UPDATE OF auth_json ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('collection', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
CREATE TRIGGER sync_dirty_folders_auth_u AFTER UPDATE OF auth_json ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id)
BEGIN
  INSERT INTO sync_dirty (entity_type, entity_id, workspace_id, change_seq) VALUES ('folder', NEW.id, NEW.workspace_id, 1)
  ON CONFLICT (entity_type, entity_id) DO UPDATE SET change_seq = change_seq + 1, op_id = NULL;
END;
