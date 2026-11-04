-- Coach dashboard (/coach). Applied at boot by src/lib/db.ts (idempotent);
-- kept here for the record.
-- A `coach` login sees only the clients whose clients.coach_name lists the
-- name in users.coach_name (comma-separated, case-insensitive exact match).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'client', 'marketer', 'coach'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS coach_name TEXT NOT NULL DEFAULT '';

-- Per-user UI preferences; the coach board stores {columns, groupBy, range,
-- collapsed, coachFilter} under pref_key 'coach_board'.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pref_key    TEXT NOT NULL,
  value       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, pref_key)
);

-- Every "view as client" session (admin or coach). No FK on actor_id so the
-- history survives a deleted coach login.
CREATE TABLE IF NOT EXISTS impersonation_audit (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID NOT NULL,
  actor_email  TEXT NOT NULL,
  actor_role   TEXT NOT NULL,          -- 'admin' | 'coach'
  client_id    UUID NOT NULL,
  client_name  TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL,          -- 'admin_config' | 'coach_board'
  ip           TEXT,
  user_agent   TEXT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS impersonation_audit_actor_idx ON impersonation_audit (actor_id, started_at DESC);
CREATE INDEX IF NOT EXISTS impersonation_audit_client_idx ON impersonation_audit (client_id, started_at DESC);

-- Marketing sheet "Marketing Offer (Text)" (shown when offer is "Unique Offer ...").
ALTER TABLE clients ADD COLUMN IF NOT EXISTS offer_details TEXT NOT NULL DEFAULT '';

-- Marketing sheet "Launch Date" (col D).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS launch_date DATE;
