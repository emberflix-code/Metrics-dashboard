-- Fixes an accuracy bug: `results` was resolved via resolveResultsFromActions
-- (pixel lead > onsite lead_grouped > generic lead) INDEPENDENTLY PER DAY,
-- then summed across a date range. A campaign whose nonzero action type
-- flips day to day (pixel nonzero one day, onsite nonzero the next) produces
-- a summed total that matches neither the monthly pixel total nor the
-- monthly onsite total BM actually reports — confirmed against a real BM
-- screenshot (2026-09-09): a campaign showing 44 in BM's "Leads (form)"
-- column (== its monthly onsite_conversion.lead_grouped total) summed to 31
-- in our DB, a number that equals neither its monthly pixel (19) nor onsite
-- (44) total.
--
-- Fix: store the 3 action-type totals separately per day, so a reader can
-- sum EACH type across the full requested range first, then pick the
-- winning type once — consistent per campaign/range, matching how BM
-- resolves it. `results` is kept (not dropped) as the same old per-day
-- resolution, still used by any reader not yet updated to the new columns.
ALTER TABLE meta_daily_insights ADD COLUMN IF NOT EXISTS results_pixel BIGINT NOT NULL DEFAULT 0;
ALTER TABLE meta_daily_insights ADD COLUMN IF NOT EXISTS results_onsite BIGINT NOT NULL DEFAULT 0;
ALTER TABLE meta_daily_insights ADD COLUMN IF NOT EXISTS results_generic BIGINT NOT NULL DEFAULT 0;
