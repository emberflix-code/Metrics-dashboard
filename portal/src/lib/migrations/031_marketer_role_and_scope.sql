-- Marketer module, phase 0: a third `marketer` role that sees every active
-- client at once (targeting overlap, cross-account asset library, alerts)
-- without admin write access; rollup flag; parsed offer token; persisted
-- campaign -> client attribution.
--
-- Record only — src/lib/db.ts runs the same statements idempotently at boot.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'client', 'marketer'));

ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_rollup BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE meta_entities ADD COLUMN IF NOT EXISTS offer_token TEXT;
CREATE INDEX IF NOT EXISTS idx_meta_entities_offer ON meta_entities (account_id, level, offer_token);

CREATE TABLE IF NOT EXISTS campaign_offer_overrides (
  account_id   TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  offer        TEXT NOT NULL,
  set_by       UUID,
  set_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS marketer_campaign_client (
  account_id   TEXT NOT NULL,
  campaign_id  TEXT NOT NULL,
  client_id    UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  is_primary   BOOLEAN NOT NULL DEFAULT false,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, campaign_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_mcc_client ON marketer_campaign_client (client_id);

-- One-time data fix, run manually once after deploy (then review on the
-- admin client pages — the toggle is editable there):
-- UPDATE clients SET is_rollup = true
--  WHERE name IN ('Alloy Ops', 'AF Regional Omega', 'Omega - California',
--                 'Omega - Florida', 'Omega - Midwest', 'Omega Chicago Belmont',
--                 'Anytime Fitness Corporate');
