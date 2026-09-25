-- Collection- and folder-level documentation (Postman `description`). `description` holds the text (Markdown,
-- or plain text); `description_type` is NULL when the Postman source was a plain string (the usual case, Markdown)
-- and the MIME type ('text/markdown' | 'text/plain') when it was a `{content, type}` object, so export can write
-- the same shape back. Both NULL = no description. Request descriptions stay inside requests.document_json.
-- Local-only in v1: the cloud protocol has no field for it, so the sync triggers from 0004 ignore these columns
-- (they travel inside collection version snapshots, like scripts_json).
-- Never edit after release; later changes go into 0007+.

ALTER TABLE collections ADD COLUMN description TEXT;
ALTER TABLE collections ADD COLUMN description_type TEXT;
ALTER TABLE folders ADD COLUMN description TEXT;
ALTER TABLE folders ADD COLUMN description_type TEXT;

-- Read-only (viewer) cloud workspaces reject local description edits too, like every other local write.
CREATE TRIGGER sync_readonly_collections_description BEFORE UPDATE OF description, description_type ON collections
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
CREATE TRIGGER sync_readonly_folders_description BEFORE UPDATE OF description, description_type ON folders
WHEN (SELECT applying FROM sync_control) = 0 AND EXISTS (SELECT 1 FROM cloud_links l WHERE l.workspace_id = NEW.workspace_id AND l.read_only = 1)
BEGIN SELECT RAISE(ABORT, 'slinger:read_only'); END;
