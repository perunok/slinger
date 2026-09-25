-- Immutable, semver-labelled snapshots of a collection. Replaces the removed
-- git-based workspace versioning. Rows are never updated, only inserted/deleted.
CREATE TABLE collection_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  version_major INTEGER NOT NULL,
  version_minor INTEGER NOT NULL,
  version_patch INTEGER NOT NULL,
  version_prerelease TEXT,
  notes TEXT,
  snapshot_json TEXT NOT NULL,
  folder_count INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_collection_versions_unique ON collection_versions(collection_id, version) WHERE deleted = 0;
CREATE INDEX idx_collection_versions_collection ON collection_versions(collection_id) WHERE deleted = 0;
