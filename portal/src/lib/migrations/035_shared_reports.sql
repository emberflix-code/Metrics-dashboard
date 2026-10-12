-- Standalone HTML reports shared by link (e.g. the Omega Flash Sale review),
-- served at /report/<token>. The token is the report's own access token: it
-- opens only that page and never creates a session, unlike
-- users.auto_login_token. Revoke by setting revoked_at; rotate by replacing
-- token. One report per (client_id, slug), so republishing updates in place.
CREATE TABLE IF NOT EXISTS shared_reports (
  id          SERIAL PRIMARY KEY,
  client_id   UUID REFERENCES clients(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  title       TEXT NOT NULL,
  html        TEXT NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, slug)
);
