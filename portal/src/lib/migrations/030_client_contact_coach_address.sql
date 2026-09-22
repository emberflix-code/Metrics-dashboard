-- Marketing/coaching roster fields, mirrored from the marketing team's
-- Marketing_Coaching_Material spreadsheet (columns: Client | GMN Coach |
-- Location Address). Informational only — nothing in the dashboards computes
-- from these; they exist so the admin can look up who the owner/contact is,
-- which GMN coach(es) own the relationship, and where the location is.
--
-- coach_name is free text and may hold several names, comma-separated
-- ("Chad Reihbrandt, Brad Meyer"), exactly as marketing records it.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS client_contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS coach_name TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS location_address TEXT NOT NULL DEFAULT '';
