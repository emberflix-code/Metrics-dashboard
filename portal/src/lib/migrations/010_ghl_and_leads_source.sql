-- GHL bookings integration + leads-source picker.
--
-- Two new columns control how the Leads KPI card sources its data per client:
--   leads_source: 'meta' (default) | 'sheet' | 'ghl'
--   show_bookings: separate toggle for the 7th "Bookings" KPI card
--
-- The legacy `use_sheet_for_leads` boolean is migrated into `leads_source`
-- = 'sheet' for any client that had it enabled. The boolean column stays
-- in the schema as a read-shadow during the rollout window.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_token_enc TEXT NOT NULL DEFAULT '';
-- locationId is required by GHL's /contacts/search endpoint and PITs of the
-- form `pit-<uuid>` don't carry it. Admin pastes it from GHL URL / API.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_location_id TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS leads_source TEXT NOT NULL DEFAULT 'meta';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_bookings BOOLEAN NOT NULL DEFAULT false;
-- When on, the Bookings KPI card also shows the book rate (bookings / leads %) as a subtitle.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_book_rate BOOLEAN NOT NULL DEFAULT false;

UPDATE clients SET leads_source = 'sheet'
WHERE use_sheet_for_leads = true AND leads_source = 'meta';
