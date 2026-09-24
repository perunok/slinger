-- Slinger local database schema (v1).
-- Applied once, in order, by electron/db/migrate.ts. Never edit an already-
-- released migration file; add a new numbered file instead.

PRAGMA foreign_keys = ON;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_type TEXT NOT NULL DEFAULT 'personal',
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE collections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_collections_workspace ON collections(workspace_id) WHERE deleted = 0;

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_folders_collection ON folders(collection_id) WHERE deleted = 0;
CREATE INDEX idx_folders_parent ON folders(parent_folder_id) WHERE deleted = 0;

CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  document_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_requests_collection ON requests(collection_id) WHERE deleted = 0;
CREATE INDEX idx_requests_folder ON requests(folder_id) WHERE deleted = 0;
CREATE INDEX idx_requests_workspace ON requests(workspace_id) WHERE deleted = 0;

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_environments_workspace ON environments(workspace_id) WHERE deleted = 0;

-- `value` holds the plaintext value only when is_secret = 0. When is_secret = 1,
-- `value` is NULL and the real value lives in the OS keychain under the key
-- `slinger:env-var:<id>` (see electron/services/secrets.ts); `secret_ref` stores
-- that keychain key so a deleted/renamed row can clean up its keychain entry.
CREATE TABLE environment_variables (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  secret_ref TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_env_vars_environment ON environment_variables(environment_id) WHERE deleted = 0;

CREATE TABLE history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  request_name TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  status_code INTEGER,
  ok INTEGER NOT NULL,
  error_message TEXT,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_history_workspace ON history(workspace_id, created_at DESC);
CREATE INDEX idx_history_request ON history(request_id);

-- Cloud publish/sync linkage for a local workspace. Access/refresh tokens are
-- never stored here — only in the OS keychain (see secrets.ts); this table
-- tracks non-secret sync bookkeeping only.
CREATE TABLE cloud_links (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  api_base_url TEXT NOT NULL,
  remote_workspace_id TEXT NOT NULL,
  sync_client_id TEXT,
  sync_checkpoint INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
