-- Run this once against your Railway Postgres database
-- psql $DATABASE_URL -f src/lib/migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'client')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_users (
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, user_id)
);

CREATE TABLE IF NOT EXISTS meta_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
  access_token_enc  TEXT NOT NULL,
  ad_account_ids    TEXT[] NOT NULL DEFAULT '{}',
  token_expires_at  TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast client user lookups
CREATE INDEX IF NOT EXISTS idx_client_users_user_id ON client_users(user_id);
CREATE INDEX IF NOT EXISTS idx_meta_connections_client_id ON meta_connections(client_id);
