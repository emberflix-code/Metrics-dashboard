-- Agency Overview: per-client GHL tag used to identify "real" form-submission
-- leads, since a client's GHL location often has contacts from other sources
-- (manual entry, imports, workflows) that shouldn't count as leads.
--
-- A contact counts as a lead when EITHER:
--   - it carries this tag (admin-configured, since tag names vary per client
--     — some clients split multiple offers across different tags), OR
--   - it has attributionSource.campaign populated (came in via a tracked ad)
-- When no tag is configured, only the attribution condition applies (blank
-- default deliberately does NOT fall back to "count every contact").

ALTER TABLE clients ADD COLUMN IF NOT EXISTS ghl_leads_tag TEXT NOT NULL DEFAULT '';
