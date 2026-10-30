-- Cookie jar (0.29): one per workspace, local only (no sync capture or read-only triggers, not exported or versioned).
--
-- cookies: RFC 6265 storage. `value_enc` is the value encrypted with AES-256-GCM under a per-install key kept in the
-- OS keychain (services/cookieJar.ts); the value is never stored in plain text. Name, domain, path and flags are plain.
-- `domain` is lower case without a leading dot; `host_only` = the cookie had no Domain attribute (sent to exactly that
-- host). `expires_at` is Unix seconds, NULL for a session cookie (kept until the user deletes it, as Postman does).
-- One cookie per (name, domain, path) in a workspace.
CREATE TABLE cookies (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  value_enc    TEXT NOT NULL,
  domain       TEXT NOT NULL,
  host_only    INTEGER NOT NULL DEFAULT 1,
  path         TEXT NOT NULL DEFAULT '/',
  expires_at   INTEGER,
  secure       INTEGER NOT NULL DEFAULT 0,
  http_only    INTEGER NOT NULL DEFAULT 0,
  same_site    TEXT CHECK (same_site IN ('Strict', 'Lax', 'None')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, domain, path, name)
);
CREATE INDEX idx_cookies_ws_domain ON cookies(workspace_id, domain);

-- cookie_settings: per workspace, the domains whose cookies pm.cookies.jar() may use (JSON array; empty = none).
CREATE TABLE cookie_settings (
  workspace_id   TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  script_domains TEXT NOT NULL DEFAULT '[]'
);

-- Workspaces are soft-deleted (also by sync): deleting one deletes its jar for real.
CREATE TRIGGER cookies_workspace_deleted
AFTER UPDATE OF deleted ON workspaces
WHEN NEW.deleted = 1 AND OLD.deleted = 0
BEGIN
  DELETE FROM cookies WHERE workspace_id = NEW.id;
  DELETE FROM cookie_settings WHERE workspace_id = NEW.id;
END;
