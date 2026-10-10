-- History records edits made by AI assistants (MCP) next to sends, and who did what.
--   kind:   'send' (an HTTP request was sent) or 'edit' (a change made through the MCP server)
--   source: NULL = the user in the window, 'mcp' = an AI assistant
--   detail: for edits, what changed (e.g. 'Edited request "Create order"'); never a value
ALTER TABLE history ADD COLUMN kind TEXT NOT NULL DEFAULT 'send' CHECK (kind IN ('send', 'edit'));
ALTER TABLE history ADD COLUMN source TEXT CHECK (source IS NULL OR source = 'mcp');
ALTER TABLE history ADD COLUMN detail TEXT;
