-- Agency Overview: manual display order per client. Lower numbers sort
-- first; ties broken by name. Defaults to 0 so existing clients keep
-- appearing (alphabetically among themselves) until an admin assigns them
-- an explicit position.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
