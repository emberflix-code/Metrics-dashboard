-- Meta KPI sheet: multi-month tab mapping + Postgres cache fallback.
--
-- Migration 024's single clients.meta_kpi_sheet_tab column assumed one tab
-- covered all time. The real sheet is organized as one tab PER MONTH
-- ("Account - July 2026", "Account - August 2026", etc.), so a single tab
-- name can only ever serve one month. client_meta_kpi_sheet_tabs replaces
-- it with an explicit admin-entered month -> tab-name mapping (same shape
-- as client_retainers — one row per calendar month).
--
-- meta_kpi_sheet_cache is the fallback for a date range whose month has no
-- configured tab, or whose live sheet fetch fails: populated by the normal
-- "Sync now" flow (metaSync.ts), read by /api/sheets/meta-kpi when a live
-- fetch for that month isn't possible.
--
-- clients.meta_kpi_sheet_tab (singular) is left in place, unused going
-- forward — no destructive migration.

CREATE TABLE IF NOT EXISTS client_meta_kpi_sheet_tabs (
  client_id  UUID NOT NULL,
  month      DATE NOT NULL,
  tab_name   TEXT NOT NULL,
  PRIMARY KEY (client_id, month)
);

CREATE TABLE IF NOT EXISTS meta_kpi_sheet_cache (
  client_id      UUID NOT NULL,
  day            DATE NOT NULL,
  campaign       TEXT NOT NULL,
  spend          NUMERIC(12,2) NOT NULL DEFAULT 0,
  results        INT NOT NULL DEFAULT 0,
  bookings       INT NOT NULL DEFAULT 0,
  joins          INT NOT NULL DEFAULT 0,
  campaign_type  TEXT NOT NULL DEFAULT '',
  offer          TEXT NOT NULL DEFAULT '',
  location_name  TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT '',
  landing_page   TEXT NOT NULL DEFAULT '',
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, day, campaign)
);
