-- Agency Overview: manual display order per client. Lower numbers sort
-- first; ties broken by name.
--
-- NOTE: the original default here was 0 — see migration 019, which flips
-- it to 999 so untouched clients sort last instead of before any client
-- an admin has explicitly numbered.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 999;
