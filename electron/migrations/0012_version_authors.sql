-- Who created a collection version. Written by the app when the user is signed in to Slinger Cloud, and by the sync
-- engine from the server's `created_by` (sync feature `version_authors`, docs/SYNC_DESIGN.md section 21).
--   created_by_id:   the cloud user id (NULL when unknown, or after the account was deleted)
--   created_by_name: the display name at creation time (NULL = author unknown, e.g. a version made before this
--                    migration or while not signed in)
-- The author is never part of the sync payload (`toWire`). These columns are deliberately NOT in the
-- `collection_versions_immutable` trigger's column list and not in the sync_dirty / read-only triggers (they only
-- fire for `deleted`), so the engine can fill the author in later without marking the row dirty or touching content.
ALTER TABLE collection_versions ADD COLUMN created_by_id TEXT;
ALTER TABLE collection_versions ADD COLUMN created_by_name TEXT;
