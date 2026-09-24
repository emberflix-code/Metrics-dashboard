-- Marketer module, phase 2: per-ad copy (bodies/titles/descriptions/links/CTA)
-- and per-copy-variant daily performance from Meta's body_asset /
-- title_asset / description_asset breakdowns. Phase 3: alert dismissals.
-- Record only — src/lib/db.ts runs the same statements idempotently at boot.

CREATE TABLE IF NOT EXISTS meta_ad_copy (
  account_id                TEXT NOT NULL,
  ad_id                     TEXT NOT NULL,
  campaign_id               TEXT,
  adset_id                  TEXT,
  creative_id               TEXT,
  is_dco                    BOOLEAN NOT NULL DEFAULT false,
  bodies                    JSONB NOT NULL DEFAULT '[]',   -- [{text, hash}]
  titles                    JSONB NOT NULL DEFAULT '[]',
  descriptions              JSONB NOT NULL DEFAULT '[]',
  link_urls                 JSONB NOT NULL DEFAULT '[]',
  cta_types                 TEXT[] NOT NULL DEFAULT '{}',
  primary_body_hash         TEXT,
  primary_title_hash        TEXT,
  primary_description_hash  TEXT,
  fetched_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, ad_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_ad_copy_body ON meta_ad_copy (primary_body_hash);

CREATE TABLE IF NOT EXISTS meta_copy_texts (
  kind        TEXT NOT NULL,                -- body | title | description
  text_hash   TEXT NOT NULL,                -- sha1 of whitespace-normalized text
  text        TEXT NOT NULL,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, text_hash)
);

CREATE TABLE IF NOT EXISTS meta_copy_breakdown_daily (
  account_id     TEXT NOT NULL,
  kind           TEXT NOT NULL,
  text_hash      TEXT NOT NULL,
  ad_id          TEXT NOT NULL,
  date           DATE NOT NULL,
  spend          NUMERIC(12,2) NOT NULL DEFAULT 0,
  impressions    BIGINT NOT NULL DEFAULT 0,
  link_clicks    BIGINT NOT NULL DEFAULT 0,
  results        BIGINT NOT NULL DEFAULT 0,
  reach          BIGINT,
  campaign_name  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (account_id, kind, text_hash, ad_id, date)
);
CREATE INDEX IF NOT EXISTS idx_meta_copy_breakdown_range ON meta_copy_breakdown_daily (account_id, date);
CREATE INDEX IF NOT EXISTS idx_meta_copy_breakdown_ad ON meta_copy_breakdown_daily (account_id, ad_id);

ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS copy_newest_synced TEXT;
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS copy_earliest_synced TEXT;
ALTER TABLE agency_meta_sync_state ADD COLUMN IF NOT EXISTS copy_backfill_complete BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_meta_asset_breakdown_daily_asset ON meta_asset_breakdown_daily (account_id, asset_key, date);

CREATE TABLE IF NOT EXISTS marketer_alert_dismissals (
  alert_key     TEXT PRIMARY KEY,
  dismissed_by  UUID,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  snooze_until  TIMESTAMPTZ
);
