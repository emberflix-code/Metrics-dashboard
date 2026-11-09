-- ChatGPT Ads daily numbers at campaign and ad-group level, straight from
-- OpenAI's insights at that level. Summing the ad-level rows can be a few
-- cents off Ads Manager (OpenAI rounds each ad's daily spend), so the KPI
-- cards and the Campaigns / Ad Groups tabs read these. Same DDL runs at boot
-- in db.ts.

CREATE TABLE IF NOT EXISTS chatgpt_ads_level_daily (
  account_id     TEXT NOT NULL,
  level          TEXT NOT NULL,          -- 'campaign' | 'ad_group'
  entity_id      TEXT NOT NULL,
  date           DATE NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  campaign_id    TEXT NOT NULL DEFAULT '',
  campaign_name  TEXT NOT NULL DEFAULT '',
  impressions    BIGINT NOT NULL DEFAULT 0,
  clicks         BIGINT NOT NULL DEFAULT 0,
  spend          NUMERIC(16,6) NOT NULL DEFAULT 0,
  conversions    NUMERIC(16,6) NOT NULL DEFAULT 0,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, level, entity_id, date)
);
