-- Agency-level Meta connection (one token for the whole agency)
CREATE TABLE IF NOT EXISTS agency_settings (
  id               SERIAL PRIMARY KEY,
  meta_token_enc   TEXT,
  meta_account_ids TEXT[] NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed one row so upsert always works
INSERT INTO agency_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Campaign name filter per client (e.g. 'Acme' matches 'Acme - Lead Gen Q1')
ALTER TABLE clients ADD COLUMN IF NOT EXISTS campaign_filter TEXT NOT NULL DEFAULT '';
