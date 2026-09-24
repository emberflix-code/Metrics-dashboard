-- Marketer module, phase 1: ad set targeting spec, normalized geo rows,
-- geocoded club coordinates. Record only — src/lib/db.ts runs the same
-- statements idempotently at boot.

ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS targeting JSONB;
ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS targeting_fetched_at TIMESTAMPTZ;
ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS daily_budget BIGINT;
ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS lifetime_budget BIGINT;
ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS start_time TIMESTAMPTZ;
ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS end_time TIMESTAMPTZ;

-- Ad-set-level daily insights for the last ~90 days (syncInsights is
-- campaign-only); rows land in meta_daily_insights level='adset'.
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS adset_insights_until TEXT;
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS ad_insights_until TEXT;
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS copy_topup_until TEXT;
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS targeting_synced_at TIMESTAMPTZ;
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS copy_synced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS meta_adset_geo (
  account_id      TEXT NOT NULL,
  adset_id        TEXT NOT NULL,
  seq             INT NOT NULL,
  kind            TEXT NOT NULL,          -- custom_location | city | zip | region | country | place | geo_market
  key             TEXT,
  name            TEXT,
  region          TEXT,
  country         TEXT,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  radius_km       DOUBLE PRECISION,
  approx          BOOLEAN NOT NULL DEFAULT false,
  excluded        BOOLEAN NOT NULL DEFAULT false,
  location_types  TEXT[],
  PRIMARY KEY (account_id, adset_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_meta_adset_geo_adset ON meta_adset_geo (account_id, adset_id);

CREATE TABLE IF NOT EXISTS geo_key_cache (
  kind         TEXT NOT NULL,
  key          TEXT NOT NULL,
  query        TEXT NOT NULL,
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  source       TEXT,
  resolved_at  TIMESTAMPTZ,
  error        TEXT,
  PRIMARY KEY (kind, key)
);

ALTER TABLE clients ADD COLUMN IF NOT EXISTS location_lat DOUBLE PRECISION;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS location_lng DOUBLE PRECISION;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS geocode_source TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS geocode_query TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS geocode_error TEXT;
