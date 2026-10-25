-- The OpenAPI document a collection was imported from (or linked to), for response validation and "update from the
-- spec". Local only: not synced, no capture triggers. Requests carry the operation key in their (synced) document, so
-- another device can link the same document again. A deleted collection keeps its row (a restore brings it back).
CREATE TABLE collection_openapi (
  collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('url', 'file', 'text')),
  source        TEXT,
  spec_text     TEXT NOT NULL,
  spec_hash     TEXT NOT NULL,
  title         TEXT NOT NULL,
  spec_version  TEXT NOT NULL,
  oas_version   TEXT NOT NULL,
  folders       TEXT NOT NULL DEFAULT 'tags' CHECK (folders IN ('tags', 'paths', 'none')),
  operation_count INTEGER NOT NULL DEFAULT 0,
  imported_at   INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_collection_openapi_ws ON collection_openapi(workspace_id);
