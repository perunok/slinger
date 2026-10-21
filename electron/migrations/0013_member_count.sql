-- Team: how many active members the linked cloud workspace has, as last read from the cloud (GET /workspaces/{id}/members).
-- NULL = not known yet (never fetched, or the server could not be reached since linking). Only a display value: the badge
-- ("Team", "N members") is right at startup before the first cycle. Never edit after release; later changes go into 0014+.
ALTER TABLE cloud_links ADD COLUMN member_count INTEGER;
