-- The Postman `info._postman_id` of the file a collection was imported from (or last replaced from), so importing
-- the same file again can offer "replace the existing collection" instead of silently creating a duplicate.
-- NULL for collections created in Slinger, restored as copies, imported "as a copy", or downloaded from the cloud.
-- Local-only (device-specific bookkeeping): the cloud protocol has no field for it and the sync triggers from 0004
-- ignore the column. Other devices fall back to matching by name.
-- Never edit after release; later changes go into 0008+.

ALTER TABLE collections ADD COLUMN source_postman_id TEXT;
CREATE INDEX idx_collections_source_postman_id ON collections (workspace_id, source_postman_id) WHERE source_postman_id IS NOT NULL;
