-- DB-backed Meta cache: per-client toggle between live Meta API fetches and
-- a locally-synced Postgres copy. Motivated by high-campaign-count accounts
-- (e.g. AF Regional Omega, act_4594093867301854) intermittently hitting
-- Meta's row-cap / rate-limit errors on live insights and creatives calls.
--
-- Storage is per ad-account (not per-client) — campaign_filter is applied at
-- read time, mirroring how getClientConnection() already separates account
-- scope from name filtering. This avoids duplicating rows across clients
-- that share an account (e.g. the Omega region clients).
--
-- Sync is triggered manually via an admin "Sync now" button (see
-- src/lib/metaSync.ts) — no cron exists yet, but syncAccount() is a plain
-- trigger-agnostic function a future scheduler can call directly.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS data_source TEXT NOT NULL DEFAULT 'live';
-- 'live' (default, unchanged today) | 'cached' (reads Postgres via sync)

-- One row per ad account. Tracks sync progress/status so the admin UI can
-- show "in progress" / "last synced" / errors, and so incremental syncs know
-- where to resume.
CREATE TABLE IF NOT EXISTS agency_meta_sync_state (
  account_id           TEXT PRIMARY KEY,
  status               TEXT NOT NULL DEFAULT 'idle',
  last_synced_at       TIMESTAMPTZ,
  last_success_until   TEXT,
  earliest_synced      TEXT,
  backfill_complete    BOOLEAN NOT NULL DEFAULT false,
  last_error           TEXT,
  last_run_started_at  TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Campaign/adset/ad status + names. Small, always fully re-pulled and
-- upserted on every sync run (no watermark needed).
CREATE TABLE IF NOT EXISTS meta_entities (
  account_id       TEXT NOT NULL,
  level            TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  campaign_id      TEXT,
  campaign_name    TEXT,
  adset_id         TEXT,
  adset_name       TEXT,
  effective_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, level, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_entities_campaign ON meta_entities (account_id, campaign_id);

-- Core fact table: one row per (account, level, entity, day). Stores
-- campaign/adset/ad as separate rows (not just ad-level rollups) because
-- Meta's own numbers aren't always derivable by summing the level below
-- (e.g. reach is unique-user, doesn't sum across siblings).
CREATE TABLE IF NOT EXISTS meta_daily_insights (
  account_id     TEXT NOT NULL,
  level          TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  date           DATE NOT NULL,
  campaign_id    TEXT NOT NULL DEFAULT '',
  campaign_name  TEXT NOT NULL DEFAULT '',
  adset_id       TEXT NOT NULL DEFAULT '',
  adset_name     TEXT NOT NULL DEFAULT '',
  ad_name        TEXT NOT NULL DEFAULT '',
  reach          BIGINT NOT NULL DEFAULT 0,
  impressions    BIGINT NOT NULL DEFAULT 0,
  spend          NUMERIC(12,2) NOT NULL DEFAULT 0,
  link_clicks    BIGINT NOT NULL DEFAULT 0,
  results        BIGINT NOT NULL DEFAULT 0,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, level, entity_id, date)
);
CREATE INDEX IF NOT EXISTS idx_meta_daily_insights_range ON meta_daily_insights (account_id, level, date);
CREATE INDEX IF NOT EXISTS idx_meta_daily_insights_campaign ON meta_daily_insights (account_id, campaign_id, date);

-- One row per distinct creative asset (image hash / video id / carousel
-- slide / unknown), account-scoped. thumbnail/video_source are the
-- last-known enrichment URLs (see metaSync.ts for the staleness policy).
CREATE TABLE IF NOT EXISTS meta_creative_assets (
  account_id               TEXT NOT NULL,
  asset_key                TEXT NOT NULL,
  type                     TEXT NOT NULL,
  thumbnail                TEXT,
  thumbnail_fetched_at     TIMESTAMPTZ,
  video_source             TEXT,
  video_source_fetched_at  TIMESTAMPTZ,
  video_id                 TEXT,
  body                     TEXT,
  title                    TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, asset_key)
);

-- Many-to-many asset <-> ad, carrying the carousel-slide weight (1/N for
-- slides, 1 otherwise). Per-ad metrics are NOT duplicated here — derived at
-- read time by joining meta_daily_insights(level='ad') for the requested
-- range and multiplying by weight.
CREATE TABLE IF NOT EXISTS meta_creative_asset_ad_map (
  account_id    TEXT NOT NULL,
  asset_key     TEXT NOT NULL,
  ad_id         TEXT NOT NULL,
  weight        NUMERIC(6,4) NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, asset_key, ad_id),
  FOREIGN KEY (account_id, asset_key) REFERENCES meta_creative_assets(account_id, asset_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meta_creative_asset_ad_map_ad ON meta_creative_asset_ad_map (account_id, ad_id);

-- DCO per-asset-per-day metrics (image_asset / video_asset breakdown).
-- Replaces the in-memory-cached /api/meta/asset-breakdown computation.
-- Stored at (asset, ad, day) granularity, not pre-aggregated, so the read
-- path can recompute for any date range.
CREATE TABLE IF NOT EXISTS meta_asset_breakdown_daily (
  account_id   TEXT NOT NULL,
  asset_key    TEXT NOT NULL,
  ad_id        TEXT NOT NULL,
  date         DATE NOT NULL,
  spend        NUMERIC(12,2) NOT NULL DEFAULT 0,
  impressions  BIGINT NOT NULL DEFAULT 0,
  link_clicks  BIGINT NOT NULL DEFAULT 0,
  results      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, asset_key, ad_id, date)
);
CREATE INDEX IF NOT EXISTS idx_meta_asset_breakdown_daily_range ON meta_asset_breakdown_daily (account_id, date);
CREATE INDEX IF NOT EXISTS idx_meta_asset_breakdown_daily_ad ON meta_asset_breakdown_daily (account_id, ad_id);
