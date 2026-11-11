-- GoHighLevel cache (lib/ghlCache.ts): a nightly copy of every connected GHL
-- location's contacts, tags, calendars, appointments and form submissions, so
-- reports keep working after a client removes our tags, revokes the token or
-- moves to another agency. Rows are never deleted: anything that disappears
-- from GHL gets missing_in_ghl_at (contacts/appointments/calendars) or
-- removed_at (tags) and keeps its last copy. Same DDL runs at boot in db.ts.

CREATE TABLE IF NOT EXISTS ghl_contacts (
  location_id        TEXT NOT NULL,
  contact_id         TEXT NOT NULL,
  client_id          UUID,
  first_name         TEXT NOT NULL DEFAULT '',
  last_name          TEXT NOT NULL DEFAULT '',
  email              TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT '',
  contact_type       TEXT NOT NULL DEFAULT '',
  tags               TEXT[] NOT NULL DEFAULT '{}',
  date_added         TIMESTAMPTZ,
  date_updated       TIMESTAMPTZ,
  last_activity      TIMESTAMPTZ,
  assigned_to        TEXT NOT NULL DEFAULT '',
  attribution        JSONB,
  last_attribution   JSONB,
  custom_fields      JSONB,
  first_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  missing_in_ghl_at  TIMESTAMPTZ,
  PRIMARY KEY (location_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_ghl_contacts_added ON ghl_contacts (location_id, date_added);
CREATE INDEX IF NOT EXISTS idx_ghl_contacts_client ON ghl_contacts (client_id);

-- Tag history: first_seen_at is the first nightly sync that saw the tag (the
-- initial pull stamps every existing tag with that day); removed_at is set
-- when a later sync no longer sees it, and cleared if it comes back.
CREATE TABLE IF NOT EXISTS ghl_contact_tags (
  location_id    TEXT NOT NULL,
  contact_id     TEXT NOT NULL,
  tag_key        TEXT NOT NULL,
  tag            TEXT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at     TIMESTAMPTZ,
  PRIMARY KEY (location_id, contact_id, tag_key)
);
CREATE INDEX IF NOT EXISTS idx_ghl_contact_tags_tag ON ghl_contact_tags (location_id, tag_key);

CREATE TABLE IF NOT EXISTS ghl_calendars (
  location_id        TEXT NOT NULL,
  calendar_id        TEXT NOT NULL,
  name               TEXT NOT NULL DEFAULT '',
  widget_slug        TEXT NOT NULL DEFAULT '',
  calendar_type      TEXT NOT NULL DEFAULT '',
  is_active          BOOLEAN,
  first_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  missing_in_ghl_at  TIMESTAMPTZ,
  PRIMARY KEY (location_id, calendar_id)
);

CREATE TABLE IF NOT EXISTS ghl_appointments (
  location_id        TEXT NOT NULL,
  event_id           TEXT NOT NULL,
  calendar_id        TEXT NOT NULL DEFAULT '',
  contact_id         TEXT NOT NULL DEFAULT '',
  title              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL DEFAULT '',
  start_time         TIMESTAMPTZ,
  end_time           TIMESTAMPTZ,
  date_added         TIMESTAMPTZ,
  date_updated       TIMESTAMPTZ,
  assigned_user_id   TEXT NOT NULL DEFAULT '',
  deleted            BOOLEAN NOT NULL DEFAULT false,
  first_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  missing_in_ghl_at  TIMESTAMPTZ,
  PRIMARY KEY (location_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_ghl_appointments_start ON ghl_appointments (location_id, start_time);
CREATE INDEX IF NOT EXISTS idx_ghl_appointments_contact ON ghl_appointments (location_id, contact_id);

CREATE TABLE IF NOT EXISTS ghl_form_submissions (
  location_id      TEXT NOT NULL,
  submission_id    TEXT NOT NULL,
  contact_id       TEXT NOT NULL DEFAULT '',
  form_id          TEXT NOT NULL DEFAULT '',
  name             TEXT NOT NULL DEFAULT '',
  email            TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ,
  event_data       JSONB,
  first_synced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, submission_id)
);
CREATE INDEX IF NOT EXISTS idx_ghl_form_submissions_created ON ghl_form_submissions (location_id, created_at);

CREATE TABLE IF NOT EXISTS ghl_cache_state (
  location_id               TEXT PRIMARY KEY,
  client_id                 UUID,
  client_name               TEXT NOT NULL DEFAULT '',
  status                    TEXT NOT NULL DEFAULT 'idle',
  started_at                TIMESTAMPTZ,
  finished_at               TIMESTAMPTZ,
  contacts_synced_at        TIMESTAMPTZ,
  contacts_count            INT,
  calendars_synced_at       TIMESTAMPTZ,
  appointments_backfilled_at TIMESTAMPTZ,
  appointments_synced_at    TIMESTAMPTZ,
  forms_backfilled_at       TIMESTAMPTZ,
  forms_synced_at           TIMESTAMPTZ,
  last_success_at           TIMESTAMPTZ,
  errors                    JSONB NOT NULL DEFAULT '{}'
);
