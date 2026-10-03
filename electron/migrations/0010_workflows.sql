-- Workflows: visual node graphs that chain saved requests, scripts, branches and loops (renderer: src/lib/workflow,
-- src/features/workflows). Per workspace. LOCAL-ONLY: the cloud protocol has no entity for them, so there are no
-- change-capture triggers (0004) and no read-only triggers: a viewer of a shared workspace may build workflows on
-- this device too (they never leave it). Soft delete + optimistic concurrency like every other table.
-- `graph_json` is the renderer's document ({ v, nodes, edges, viewport }); opaque to the main process apart from
-- being a JSON object. Never edit after release; later changes go into 0011+.
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  graph_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workflows_workspace ON workflows(workspace_id) WHERE deleted = 0;
