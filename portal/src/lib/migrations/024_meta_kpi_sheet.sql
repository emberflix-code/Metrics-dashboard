-- Meta KPI sheet: per-client Google Sheet (same gviz-CSV mechanism as the
-- existing sheet_id/sheet_tab leads override in lib/sheets.ts) carrying
-- fields Meta's API has no concept of — Campaign Type, Offer, Location
-- Name, State, Landing Page, and manually-tallied Bookings/Joins. Off by
-- default; when on, the dashboard shows extra Bookings/Joins KPI cards
-- filterable by those five dimensions.
--
-- Separate sheet_id/sheet_tab columns (not reusing the existing
-- sheet_id/sheet_tab pair used for the leads-override sheet) since this is
-- a structurally different, much wider sheet than that one.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_kpi_sheet_id TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS meta_kpi_sheet_tab TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_meta_kpi_sheet BOOLEAN NOT NULL DEFAULT false;
