-- The cloud's author of the remote side of an `immutable_clash` conflict (a collection version the cloud holds under
-- the same id with different content). The author is not part of the synced content, so it is kept next to the
-- conflict (JSON `{ "id": string | null, "name": string }`) instead of inside `remote_json`: resolving with "keep
-- cloud" re-creates the local row from the cloud's copy and gives it this author.
ALTER TABLE sync_conflicts ADD COLUMN remote_author TEXT;
