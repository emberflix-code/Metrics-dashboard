-- Google Ads API data source for the client Google dashboard.
-- Applied at boot by src/lib/db.ts (idempotent); kept here for the record.
-- clients.google_data_source: 'sheet' = google_sheet_tab (original), 'api' =
-- google_ads_daily filled daily by src/lib/googleAds.ts for the accounts in
-- google_ads_customer_ids, narrowed by google_campaign_filter.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS google_data_source TEXT NOT NULL DEFAULT 'sheet';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS google_ads_customer_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS google_campaign_filter TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS google_ads_campaigns (
  customer_id    TEXT NOT NULL,
  campaign_id    TEXT NOT NULL,
  campaign_name  TEXT NOT NULL,
  status         TEXT NOT NULL,
  landing_offer  TEXT NOT NULL DEFAULT '',  -- offer slug of the campaign's landing page (Promo fallback)
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, campaign_id)
);

-- One row per campaign per day (account timezone). leads/joins/bookings are
-- all_conversions for SUBMIT_LEAD_FORM / PURCHASE / BOOK_APPOINTMENT actions.
CREATE TABLE IF NOT EXISTS google_ads_daily (
  customer_id  TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  date         DATE NOT NULL,
  cost         NUMERIC(16,6) NOT NULL DEFAULT 0,
  impressions  BIGINT NOT NULL DEFAULT 0,
  clicks       BIGINT NOT NULL DEFAULT 0,
  leads        NUMERIC(16,6) NOT NULL DEFAULT 0,
  joins        NUMERIC(16,6) NOT NULL DEFAULT 0,
  bookings     NUMERIC(16,6) NOT NULL DEFAULT 0,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, campaign_id, date)
);

CREATE TABLE IF NOT EXISTS google_ads_sync_state (
  customer_id          TEXT PRIMARY KEY,
  status               TEXT NOT NULL DEFAULT 'idle',
  last_success_until   DATE,
  last_synced_at       TIMESTAMPTZ,
  last_run_started_at  TIMESTAMPTZ,
  time_zone            TEXT,
  last_error           TEXT
);

-- Keyword and RSA headline/description breakdowns. Asset conversions are
-- Google's per-asset figures (an asset is credited with every conversion of
-- the ads it served in), so they don't add up to campaign totals.
CREATE TABLE IF NOT EXISTS google_ads_keyword_daily (
  customer_id   TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  ad_group_id   TEXT NOT NULL,
  criterion_id  TEXT NOT NULL,
  keyword_text  TEXT NOT NULL,
  match_type    TEXT NOT NULL DEFAULT '',
  date          DATE NOT NULL,
  cost          NUMERIC(16,6) NOT NULL DEFAULT 0,
  impressions   BIGINT NOT NULL DEFAULT 0,
  clicks        BIGINT NOT NULL DEFAULT 0,
  leads         NUMERIC(16,6) NOT NULL DEFAULT 0,
  joins         NUMERIC(16,6) NOT NULL DEFAULT 0,
  bookings      NUMERIC(16,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, campaign_id, ad_group_id, criterion_id, date)
);

CREATE TABLE IF NOT EXISTS google_ads_asset_daily (
  customer_id  TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  field_type   TEXT NOT NULL,
  asset_id     TEXT NOT NULL,
  asset_text   TEXT NOT NULL,
  date         DATE NOT NULL,
  cost         NUMERIC(16,6) NOT NULL DEFAULT 0,
  impressions  BIGINT NOT NULL DEFAULT 0,
  clicks       BIGINT NOT NULL DEFAULT 0,
  leads        NUMERIC(16,6) NOT NULL DEFAULT 0,
  joins        NUMERIC(16,6) NOT NULL DEFAULT 0,
  bookings     NUMERIC(16,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, campaign_id, field_type, asset_id, date)
);
