-- Local-only security state (not synced, no capture triggers, not exported or versioned).
--
-- collection_trust: collections whose scripts may run on this device. Collections made here (New collection, extract
-- folder, restore a version as a copy of a trusted one) get a row at once; imported collections and collections that
-- arrive through sync have none until the user allows their scripts once. Collections that exist when this migration
-- runs have been running their scripts already, so they are trusted.
CREATE TABLE collection_trust (
  collection_id TEXT PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE,
  trusted_at    INTEGER NOT NULL
);
INSERT INTO collection_trust (collection_id, trusted_at) SELECT id, CAST(strftime('%s', 'now') AS INTEGER) FROM collections;

-- assistant_changes: what an AI assistant (Slinger's MCP server) wrote and the user has not reviewed since. A row counts
-- only while `fingerprint` still matches the current content (a request's method, URL and document without its saved
-- examples; an environment variable's value), so any later change by the user or through sync ends it; saving the
-- request or the variable in the window removes it. kind 'request': ref = request id, `created` = the assistant made
-- the request (so its literal credentials are the assistant's own). kind 'variable': ref = '<environment id>:<key>'.
CREATE TABLE assistant_changes (
  kind         TEXT NOT NULL CHECK (kind IN ('request', 'variable')),
  ref          TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  created      INTEGER NOT NULL DEFAULT 0,
  changed_at   INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);
CREATE INDEX idx_assistant_changes_ws ON assistant_changes(workspace_id);
