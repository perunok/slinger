-- Collection- and folder-level Postman scripts (pre-request / test). The column holds the Postman `event`
-- array verbatim as JSON text ('[{"listen":"prerequest","script":{"exec":[...],"type":"text/javascript"}}]'),
-- or NULL when there are none. Request-level scripts live inside requests.document_json (key `scripts`).
-- Local-only in v1: the cloud protocol has no field for it, so the sync triggers from 0004 ignore this column.
-- Never edit after release; later changes go into 0006+.

ALTER TABLE collections ADD COLUMN scripts_json TEXT;
ALTER TABLE folders ADD COLUMN scripts_json TEXT;

-- Read-only (viewer) cloud workspaces reject local script edits too, like every other local write.
CREATE TRIGGER sync_readonly_collections_scripts BEFORE UPDATE OF scripts_json ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_folders_scripts BEFORE UPDATE OF scripts_json ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
