-- Local changes the user chose to keep on this device ("Keep on this device" in Sync activity): they stay in
-- sync_dirty but the push leaves them (and what depends on them) out until the user uploads them again. Local only:
-- never synced, no capture triggers.
CREATE TABLE sync_kept (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX idx_sync_kept_ws ON sync_kept(workspace_id);

-- A kept change ends when its entity stops being dirty (changed back, replaced by the cloud's copy, discarded,
-- unlinked): otherwise a later edit of the same item would be held back without the user asking. sync_dirty rows are
-- upserted in place (ON CONFLICT DO UPDATE), so this fires only when the change is really gone.
CREATE TRIGGER sync_kept_ends_with_dirty AFTER DELETE ON sync_dirty
BEGIN
  DELETE FROM sync_kept WHERE entity_type = OLD.entity_type AND entity_id = OLD.entity_id;
END;
