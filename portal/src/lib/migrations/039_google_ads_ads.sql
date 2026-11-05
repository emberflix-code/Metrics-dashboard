-- Google Ads full ads: ad text per ad, per-ad daily numbers, and the
-- campaign-level assets (sitelinks, callouts, business name, logo, images)
-- used to draw search-ad previews. Same DDL runs at boot in db.ts.

CREATE TABLE IF NOT EXISTS google_ads_ads (
  customer_id      TEXT NOT NULL,
  ad_id            TEXT NOT NULL,
  campaign_id      TEXT NOT NULL,
  ad_group_id      TEXT NOT NULL,
  ad_group_name    TEXT NOT NULL DEFAULT '',
  ad_group_status  TEXT NOT NULL DEFAULT '',
  ad_type          TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT '',
  approval_status  TEXT NOT NULL DEFAULT '',
  headlines        JSONB NOT NULL DEFAULT '[]',
  descriptions     JSONB NOT NULL DEFAULT '[]',
  final_url        TEXT NOT NULL DEFAULT '',
  path1            TEXT NOT NULL DEFAULT '',
  path2            TEXT NOT NULL DEFAULT '',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, ad_id)
);

CREATE TABLE IF NOT EXISTS google_ads_ad_daily (
  customer_id  TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  ad_group_id  TEXT NOT NULL,
  ad_id        TEXT NOT NULL,
  date         DATE NOT NULL,
  cost         NUMERIC(16,6) NOT NULL DEFAULT 0,
  impressions  BIGINT NOT NULL DEFAULT 0,
  clicks       BIGINT NOT NULL DEFAULT 0,
  leads        NUMERIC(16,6) NOT NULL DEFAULT 0,
  joins        NUMERIC(16,6) NOT NULL DEFAULT 0,
  bookings     NUMERIC(16,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (customer_id, ad_group_id, ad_id, date)
);
CREATE INDEX IF NOT EXISTS google_ads_ad_daily_campaign_idx ON google_ads_ad_daily (customer_id, campaign_id, date);

CREATE TABLE IF NOT EXISTS google_ads_campaign_assets (
  customer_id   TEXT NOT NULL,
  campaign_id   TEXT NOT NULL,
  field_type    TEXT NOT NULL,
  asset_id      TEXT NOT NULL,
  text          TEXT NOT NULL DEFAULT '',
  description1  TEXT NOT NULL DEFAULT '',
  description2  TEXT NOT NULL DEFAULT '',
  final_url     TEXT NOT NULL DEFAULT '',
  image_url     TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (customer_id, campaign_id, field_type, asset_id)
);
