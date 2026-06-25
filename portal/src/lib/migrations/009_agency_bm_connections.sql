-- Multi-BM support: agency can have N Business Manager connections, each with
-- its own access token and the ad accounts that token can read. Previously
-- `agency_settings` carried a single token + flat account list; we keep those
-- columns for backward compatibility and migrate their values into the first
-- row of this table on next app startup (see db.ts).

CREATE TABLE IF NOT EXISTS agency_bm_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label             TEXT NOT NULL,
  token_enc         TEXT NOT NULL,
  account_ids       TEXT[] NOT NULL DEFAULT '{}',
  accounts_json     JSONB NOT NULL DEFAULT '[]',
  sort_order        INT NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: when an API route gets an account_id, find the connection that owns it.
CREATE INDEX IF NOT EXISTS idx_agency_bm_connections_account_ids
  ON agency_bm_connections USING GIN (account_ids);

-- Race-safety: prevent two cold-start workers from each seeding "BM 1".
CREATE UNIQUE INDEX IF NOT EXISTS idx_agency_bm_connections_label
  ON agency_bm_connections (label);
