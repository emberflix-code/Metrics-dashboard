-- Agency Overview: free-text Marketing Type + Offer per client, usable as
-- grouping dimensions in the overview (alongside name-prefix auto-detection).
-- No fixed option list on either — plain text, admin-entered per client.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_type TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS offer TEXT NOT NULL DEFAULT '';
