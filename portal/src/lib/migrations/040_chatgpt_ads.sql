-- ChatGPT Ads (OpenAI Ads Manager) per-client connection, entities and
-- ad-level daily numbers. One API key per ad account (OpenAI keys are scoped
-- to a single account), stored encrypted on the client row. Filled by the
-- daily scheduler via src/lib/chatgptAds.ts. Same DDL runs at boot in db.ts.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS chatgpt_ads_key_enc TEXT NOT NULL DEFAULT '';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS chatgpt_ads_account_id TEXT NOT NULL DEFAULT '';

-- Campaigns, ad groups and ads (level), with each ad's creative and its image
-- stored as bytes (OpenAI's image links expire within a day).
CREATE TABLE IF NOT EXISTS chatgpt_ads_entities (
  account_id          TEXT NOT NULL,
  id                  TEXT NOT NULL,
  level               TEXT NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT '',
  parent_id           TEXT NOT NULL DEFAULT '',
  review_status       TEXT NOT NULL DEFAULT '',
  creative_type       TEXT NOT NULL DEFAULT '',
  title               TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  target_url          TEXT NOT NULL DEFAULT '',
  file_id             TEXT NOT NULL DEFAULT '',
  image_crop          JSONB,
  image_bytes         BYTEA,
  image_content_type  TEXT NOT NULL DEFAULT '',
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, id)
);

CREATE TABLE IF NOT EXISTS chatgpt_ads_ad_daily (
  account_id     TEXT NOT NULL,
  ad_id          TEXT NOT NULL,
  date           DATE NOT NULL,
  campaign_id    TEXT NOT NULL DEFAULT '',
  campaign_name  TEXT NOT NULL DEFAULT '',
  ad_group_id    TEXT NOT NULL DEFAULT '',
  ad_group_name  TEXT NOT NULL DEFAULT '',
  ad_name        TEXT NOT NULL DEFAULT '',
  impressions    BIGINT NOT NULL DEFAULT 0,
  clicks         BIGINT NOT NULL DEFAULT 0,
  spend          NUMERIC(16,6) NOT NULL DEFAULT 0,
  conversions    NUMERIC(16,6) NOT NULL DEFAULT 0,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, ad_id, date)
);

CREATE TABLE IF NOT EXISTS chatgpt_ads_sync_state (
  account_id          TEXT PRIMARY KEY,
  account_name        TEXT NOT NULL DEFAULT '',
  time_zone           TEXT,
  status              TEXT NOT NULL DEFAULT 'idle',
  last_success_until  DATE,
  last_synced_at      TIMESTAMPTZ,
  last_error          TEXT
);
