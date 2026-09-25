-- Integrity + ordering support added by the TypeScript main process.

-- One live variable per (environment, key). Soft-deleted rows are excluded so a key can be reused.
CREATE UNIQUE INDEX idx_env_vars_unique_key ON environment_variables(environment_id, key) WHERE deleted = 0;

-- Sibling ordering lookups (folders/requests are ordered by sort_order within a container).
CREATE INDEX idx_folders_order ON folders(collection_id, parent_folder_id, sort_order) WHERE deleted = 0;
CREATE INDEX idx_requests_order ON requests(collection_id, folder_id, sort_order) WHERE deleted = 0;

-- Collection versions are immutable snapshots: only the `deleted` flag may change.
CREATE TRIGGER collection_versions_immutable
BEFORE UPDATE OF workspace_id, collection_id, version, version_major, version_minor, version_patch,
  version_prerelease, notes, snapshot_json, folder_count, request_count, created_at
ON collection_versions
BEGIN
  SELECT RAISE(ABORT, 'collection versions are immutable');
END;
