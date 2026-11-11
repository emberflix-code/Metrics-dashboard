// GoHighLevel cache — a nightly copy of every connected GHL location kept in
// our own Postgres (tables in migration 042), so monthly reports and backfills
// keep working after a client strips our tags, revokes the Private Integration
// token or moves to another agency (Park City, Five Forks, Rochester MI and
// Edina all happened in Oct–Nov 2026). Nothing is ever deleted here:
//   - contacts / calendars / appointments that stop coming back from GHL get
//     missing_in_ghl_at and keep their last copy;
//   - a tag that disappears from a contact gets removed_at in
//     ghl_contact_tags (first_seen_at = the first nightly sync that saw it).
//
// Per location, each night:
//   1. contacts — FULL pull (500 per page, sorted by dateAdded so pages stay
//      stable while the location is being edited). Cheap: a 2,500-contact
//      location is 6 calls. A full pull is what lets us see tag removals and
//      deleted contacts at all; an "updated since" filter can't show either.
//   2. calendars — the list, so calendar mix-ups show up in the data.
//   3. appointments — every calendar, in 90-day windows: from
//      APPOINTMENTS_BACKFILL_FROM on the first run, then the last 60 days to
//      120 days ahead.
//   4. form submissions — all pages on the first run, then the last 7 days.
// Each step is isolated: a token without the Calendars scope still caches
// contacts (errors land in ghl_cache_state.errors).
//
// Every client with a token + location ID is synced, active or not — an
// inactive dashboard whose token still works is exactly the data we would
// otherwise lose.
//
// Personal data (names, emails, phones) is stored for matching leads to
// bookings and sales. IP addresses and user agents are dropped from the
// attribution / form event data. Nothing here is exposed by any route.

import { query } from './db';
import { decrypt } from './crypto';

const GHL = 'https://services.leadconnectorhq.com';
const CONTACTS_PAGE = 500;
const FORMS_PAGE = 100;
const MAX_CONTACT_PAGES = 400;          // 200k contacts — safety cap per location
const MAX_FORM_PAGES = 200;
const WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;
const APPOINTMENTS_BACKFILL_FROM = Date.UTC(2025, 0, 1);
const NIGHTLY_LOOKBACK_DAYS = 60;
const LOOKAHEAD_DAYS = 120;
const FORMS_LOOKBACK_DAYS = 7;
const LOCK_STALE_HOURS = 3;
// Don't flag contacts as missing when a pull returns far fewer than we already
// hold — that's an API glitch or a token now pointing at another location,
// not half the location being deleted overnight.
const MISSING_GUARD_RATIO = 0.5;

export interface GhlCacheTarget { clientId: string; clientName: string; locationId: string; tokenEnc: string }
export interface GhlCacheResult {
  locationId: string; clientName: string; status: 'ok' | 'partial' | 'error' | 'locked';
  contacts?: number; contactsMarkedMissing?: number; tagsRemoved?: number; calendars?: number; appointments?: number; forms?: number;
  errors: Record<string, string>; ms: number;
}

class GhlHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// GHL JSON, read defensively: every field may be missing or the wrong type.
type GhlObj = Record<string, unknown>;
const isObj = (v: unknown): v is GhlObj => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): GhlObj[] => (Array.isArray(v) ? v.filter(isObj) : []);

async function ghl(path: string, token: string, opts: { method?: string; body?: unknown; version?: string } = {}): Promise<GhlObj> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${GHL}${path}`, {
        method: opts.method || 'GET',
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${token}`, Version: opts.version || '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' },
      });
    } catch (err) {
      if (attempt <= 4) { await sleep(3000 * attempt); continue; }
      throw new GhlHttpError(0, `network: ${err instanceof Error ? err.message : String(err)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt <= 5) { await sleep(4000 * attempt); continue; }
    const json = (await res.json().catch(() => ({}))) as GhlObj;
    if (!res.ok) throw new GhlHttpError(res.status, `HTTP ${res.status}: ${String(json?.message || json?.error || '').slice(0, 200)}`);
    // 100 requests / 10 s per location: slow down before GHL makes us.
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(remaining) && remaining <= 5) await sleep(Number(res.headers.get('x-ratelimit-interval-milliseconds')) || 10_000);
    return json;
  }
}

function stripTracking(o: unknown): GhlObj | null {
  if (!isObj(o)) return null;
  const rest: GhlObj = { ...o };
  delete rest.ip;
  delete rest.userAgent;
  return rest;
}
const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export async function getGhlCacheTargets(onlyLocationIds?: string[]): Promise<GhlCacheTarget[]> {
  const rows = await query<{ id: string; name: string; ghl_location_id: string; ghl_token_enc: string }>(
    `SELECT DISTINCT ON (ghl_location_id) id, name, ghl_location_id, ghl_token_enc
       FROM clients
      WHERE COALESCE(ghl_token_enc, '') <> '' AND COALESCE(ghl_location_id, '') <> ''
      ORDER BY ghl_location_id, active DESC, name`
  );
  return rows
    .filter(r => !onlyLocationIds?.length || onlyLocationIds.includes(r.ghl_location_id))
    .map(r => ({ clientId: r.id, clientName: r.name, locationId: r.ghl_location_id.trim(), tokenEnc: r.ghl_token_enc }));
}

async function syncContacts(t: GhlCacheTarget, token: string, runStart: string, r: GhlCacheResult) {
  const [{ held }] = await query<{ held: number }>(
    `SELECT COUNT(*)::int AS held FROM ghl_contacts WHERE location_id = $1 AND missing_in_ghl_at IS NULL`, [t.locationId]);
  let searchAfter: unknown[] | undefined;
  let seen = 0;
  let complete = false;
  for (let page = 0; page < MAX_CONTACT_PAGES; page++) {
    const body: Record<string, unknown> = { locationId: t.locationId, pageLimit: CONTACTS_PAGE, sort: [{ field: 'dateAdded', direction: 'asc' }] };
    if (searchAfter) body.searchAfter = searchAfter;
    const json = await ghl('/contacts/search', token, { method: 'POST', body });
    const contacts = list(json.contacts);
    if (!contacts.length) { complete = true; break; }

    const rows = contacts.filter(c => c.id).map(c => ({
      id: str(c.id), first_name: str(c.firstName).trim(), last_name: str(c.lastName).trim(), email: str(c.email).trim(), phone: str(c.phone).trim(),
      source: str(c.source), contact_type: str(c.type), tags: Array.isArray(c.tags) ? c.tags.map(str) : [],
      date_added: iso(c.dateAdded), date_updated: iso(c.dateUpdated), last_activity: iso(c.lastActivity), assigned_to: str(c.assignedTo),
      attribution: stripTracking(c.attributionSource), last_attribution: stripTracking(c.lastAttributionSource),
      custom_fields: Array.isArray(c.customFields) ? c.customFields : null,
    }));
    await query(
      `INSERT INTO ghl_contacts (location_id, contact_id, client_id, first_name, last_name, email, phone, source, contact_type, tags,
                                 date_added, date_updated, last_activity, assigned_to, attribution, last_attribution, custom_fields,
                                 last_synced_at, missing_in_ghl_at)
       SELECT $1, x.id, $2, x.first_name, x.last_name, x.email, x.phone, x.source, x.contact_type,
              ARRAY(SELECT jsonb_array_elements_text(x.tags)), x.date_added, x.date_updated, x.last_activity, x.assigned_to,
              x.attribution, x.last_attribution, x.custom_fields, NOW(), NULL
         FROM jsonb_to_recordset($3::jsonb) AS x(id text, first_name text, last_name text, email text, phone text, source text,
              contact_type text, tags jsonb, date_added timestamptz, date_updated timestamptz, last_activity timestamptz,
              assigned_to text, attribution jsonb, last_attribution jsonb, custom_fields jsonb)
       ON CONFLICT (location_id, contact_id) DO UPDATE SET
         client_id = EXCLUDED.client_id, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name, email = EXCLUDED.email,
         phone = EXCLUDED.phone, source = EXCLUDED.source, contact_type = EXCLUDED.contact_type, tags = EXCLUDED.tags,
         date_added = EXCLUDED.date_added, date_updated = EXCLUDED.date_updated, last_activity = EXCLUDED.last_activity,
         assigned_to = EXCLUDED.assigned_to, attribution = EXCLUDED.attribution, last_attribution = EXCLUDED.last_attribution,
         custom_fields = EXCLUDED.custom_fields, last_synced_at = NOW(), missing_in_ghl_at = NULL`,
      [t.locationId, t.clientId, JSON.stringify(rows)]
    );

    // One row per (contact, tag), case-insensitive — GHL can hold "Tag" and "tag".
    const tagRows: { cid: string; key: string; tag: string }[] = [];
    for (const c of rows) {
      const keys = new Set<string>();
      for (const tag of c.tags) {
        const key = tag.trim().toLowerCase();
        if (!key || keys.has(key)) continue;
        keys.add(key);
        tagRows.push({ cid: c.id, key, tag: tag.trim() });
      }
    }
    if (tagRows.length) {
      await query(
        `INSERT INTO ghl_contact_tags (location_id, contact_id, tag_key, tag)
         SELECT $1, x.cid, x.key, x.tag FROM jsonb_to_recordset($2::jsonb) AS x(cid text, key text, tag text)
         ON CONFLICT (location_id, contact_id, tag_key) DO UPDATE SET tag = EXCLUDED.tag, last_seen_at = NOW(), removed_at = NULL`,
        [t.locationId, JSON.stringify(tagRows)]
      );
    }
    seen += rows.length;

    const cursor = contacts[contacts.length - 1].searchAfter;
    if (contacts.length < CONTACTS_PAGE || !Array.isArray(cursor) || !cursor.length) { complete = true; break; }
    searchAfter = cursor;
  }
  r.contacts = seen;

  // Tags no longer on a contact we just re-read → removed (kept, dated).
  const removed = await query(
    `UPDATE ghl_contact_tags tg SET removed_at = NOW()
       FROM ghl_contacts c
      WHERE tg.location_id = $1 AND c.location_id = $1 AND c.contact_id = tg.contact_id
        AND c.last_synced_at >= $2 AND tg.removed_at IS NULL AND tg.last_seen_at < $2
      RETURNING 1`, [t.locationId, runStart]);
  r.tagsRemoved = removed.length;

  if (!complete) throw new Error(`contacts: stopped at the ${MAX_CONTACT_PAGES}-page cap (${seen} read); missing contacts not flagged`);
  if (held > 0 && seen < held * MISSING_GUARD_RATIO) {
    throw new Error(`contacts: GHL returned ${seen} but we hold ${held}; missing contacts not flagged (check the token/location)`);
  }
  const missing = await query(
    `UPDATE ghl_contacts SET missing_in_ghl_at = NOW()
      WHERE location_id = $1 AND last_synced_at < $2 AND missing_in_ghl_at IS NULL RETURNING 1`, [t.locationId, runStart]);
  r.contactsMarkedMissing = missing.length;
  await query(`UPDATE ghl_cache_state SET contacts_synced_at = NOW(), contacts_count = $2 WHERE location_id = $1`, [t.locationId, seen]);
}

async function syncCalendars(t: GhlCacheTarget, token: string, runStart: string, r: GhlCacheResult): Promise<string[]> {
  const json = await ghl(`/calendars/?locationId=${encodeURIComponent(t.locationId)}`, token, { version: '2021-04-15' });
  const cals = list(json.calendars).filter(c => c.id);
  if (cals.length) {
    await query(
      `INSERT INTO ghl_calendars (location_id, calendar_id, name, widget_slug, calendar_type, is_active, last_synced_at, missing_in_ghl_at)
       SELECT $1, x.id, x.name, x.slug, x.type, x.active, NOW(), NULL
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, name text, slug text, type text, active boolean)
       ON CONFLICT (location_id, calendar_id) DO UPDATE SET name = EXCLUDED.name, widget_slug = EXCLUDED.widget_slug,
         calendar_type = EXCLUDED.calendar_type, is_active = EXCLUDED.is_active, last_synced_at = NOW(), missing_in_ghl_at = NULL`,
      [t.locationId, JSON.stringify(cals.map(c => ({ id: str(c.id), name: str(c.name), slug: str(c.widgetSlug || c.slug),
        type: str(c.calendarType), active: typeof c.isActive === 'boolean' ? c.isActive : null })))]
    );
  }
  await query(`UPDATE ghl_calendars SET missing_in_ghl_at = NOW() WHERE location_id = $1 AND last_synced_at < $2 AND missing_in_ghl_at IS NULL`,
    [t.locationId, runStart]);
  await query(`UPDATE ghl_cache_state SET calendars_synced_at = NOW() WHERE location_id = $1`, [t.locationId]);
  r.calendars = cals.length;
  return cals.map(c => str(c.id));
}

async function syncAppointments(t: GhlCacheTarget, token: string, calendarIds: string[], backfilled: boolean, runStart: string, r: GhlCacheResult) {
  const now = Date.now();
  const from = backfilled ? now - NIGHTLY_LOOKBACK_DAYS * DAY_MS : APPOINTMENTS_BACKFILL_FROM;
  const to = now + LOOKAHEAD_DAYS * DAY_MS;
  let stored = 0;
  const failed: string[] = [];
  for (const calendarId of calendarIds) {
    let ok = true;
    for (let start = from; start < to; start += WINDOW_DAYS * DAY_MS) {
      const end = Math.min(start + WINDOW_DAYS * DAY_MS, to);
      let json: GhlObj;
      try {
        json = await ghl(`/calendars/events?locationId=${encodeURIComponent(t.locationId)}&calendarId=${encodeURIComponent(calendarId)}&startTime=${start}&endTime=${end}`,
          token, { version: '2021-04-15' });
      } catch (err) { ok = false; failed.push(`${calendarId}: ${err instanceof Error ? err.message : String(err)}`); break; }
      const events = list(json.events).filter(e => e.id);
      if (!events.length) continue;
      await query(
        `INSERT INTO ghl_appointments (location_id, event_id, calendar_id, contact_id, title, status, start_time, end_time,
                                       date_added, date_updated, assigned_user_id, deleted, last_synced_at, missing_in_ghl_at)
         SELECT $1, x.id, x.calendar_id, x.contact_id, x.title, x.status, x.start_time, x.end_time, x.date_added, x.date_updated,
                x.assigned_user_id, x.deleted, NOW(), NULL
           FROM jsonb_to_recordset($2::jsonb) AS x(id text, calendar_id text, contact_id text, title text, status text,
                start_time timestamptz, end_time timestamptz, date_added timestamptz, date_updated timestamptz,
                assigned_user_id text, deleted boolean)
         ON CONFLICT (location_id, event_id) DO UPDATE SET calendar_id = EXCLUDED.calendar_id, contact_id = EXCLUDED.contact_id,
           title = EXCLUDED.title, status = EXCLUDED.status, start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
           date_added = EXCLUDED.date_added, date_updated = EXCLUDED.date_updated, assigned_user_id = EXCLUDED.assigned_user_id,
           deleted = EXCLUDED.deleted, last_synced_at = NOW(), missing_in_ghl_at = NULL`,
        [t.locationId, JSON.stringify(events.map(e => ({
          id: str(e.id), calendar_id: str(e.calendarId || calendarId), contact_id: str(e.contactId), title: str(e.title),
          // GHL sends the status under both spellings.
          status: str(e.appointmentStatus || e.appoinmentStatus).toLowerCase(),
          start_time: iso(e.startTime), end_time: iso(e.endTime), date_added: iso(e.dateAdded), date_updated: iso(e.dateUpdated),
          assigned_user_id: str(e.assignedUserId), deleted: e.deleted === true,
        })))]
      );
      stored += events.length;
    }
    // Only a calendar read end to end can say what disappeared from it.
    if (ok) {
      await query(
        `UPDATE ghl_appointments SET missing_in_ghl_at = NOW()
          WHERE location_id = $1 AND calendar_id = $2 AND start_time >= $3 AND start_time < $4
            AND last_synced_at < $5 AND missing_in_ghl_at IS NULL`,
        [t.locationId, calendarId, new Date(from).toISOString(), new Date(to).toISOString(), runStart]);
    }
  }
  r.appointments = stored;
  if (failed.length) throw new Error(`appointments: ${failed.length} calendar(s) failed — ${failed.slice(0, 3).join('; ')}`);
  await query(
    `UPDATE ghl_cache_state SET appointments_synced_at = NOW(), appointments_backfilled_at = COALESCE(appointments_backfilled_at, NOW())
      WHERE location_id = $1`, [t.locationId]);
}

async function syncForms(t: GhlCacheTarget, token: string, lastSynced: string | null, backfilled: boolean, r: GhlCacheResult) {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const since = backfilled && lastSynced ? Date.parse(lastSynced) - FORMS_LOOKBACK_DAYS * DAY_MS : null;
  let stored = 0;
  let page = 1;
  for (let n = 0; n < MAX_FORM_PAGES; n++) {
    const params = new URLSearchParams({ locationId: t.locationId, limit: String(FORMS_PAGE), page: String(page) });
    if (since) { params.set('startAt', day(since)); params.set('endAt', day(Date.now() + DAY_MS)); }
    const json = await ghl(`/forms/submissions?${params}`, token);
    const subs = list(json.submissions).filter(s => s.id);
    if (!subs.length) break;
    await query(
      `INSERT INTO ghl_form_submissions (location_id, submission_id, contact_id, form_id, name, email, created_at, event_data, last_synced_at)
       SELECT $1, x.id, x.contact_id, x.form_id, x.name, x.email, x.created_at, x.event_data, NOW()
         FROM jsonb_to_recordset($2::jsonb) AS x(id text, contact_id text, form_id text, name text, email text, created_at timestamptz, event_data jsonb)
       ON CONFLICT (location_id, submission_id) DO UPDATE SET contact_id = EXCLUDED.contact_id, form_id = EXCLUDED.form_id,
         name = EXCLUDED.name, email = EXCLUDED.email, created_at = EXCLUDED.created_at, event_data = EXCLUDED.event_data, last_synced_at = NOW()`,
      [t.locationId, JSON.stringify(subs.map(s => ({
        id: str(s.id), contact_id: str(s.contactId), form_id: str(s.formId), name: str(s.name), email: str(s.email),
        created_at: iso(s.createdAt), event_data: stripTracking(isObj(s.others) ? s.others.eventData : null),
      })))]
    );
    stored += subs.length;
    const nextPage = isObj(json.meta) ? Number(json.meta.nextPage) : NaN;
    if (subs.length < FORMS_PAGE || !Number.isFinite(nextPage) || nextPage <= page) break;
    page = nextPage;
  }
  r.forms = stored;
  await query(
    `UPDATE ghl_cache_state SET forms_synced_at = NOW(), forms_backfilled_at = COALESCE(forms_backfilled_at, NOW()) WHERE location_id = $1`,
    [t.locationId]);
}

export async function syncGhlLocation(t: GhlCacheTarget, opts: { token?: string } = {}): Promise<GhlCacheResult> {
  const t0 = Date.now();
  const r: GhlCacheResult = { locationId: t.locationId, clientName: t.clientName, status: 'ok', errors: {}, ms: 0 };

  // Take the per-location lock (a stuck 'running' row frees itself after LOCK_STALE_HOURS).
  const locked = await query<{ location_id: string }>(
    `INSERT INTO ghl_cache_state (location_id, client_id, client_name, status, started_at) VALUES ($1, $2, $3, 'running', NOW())
     ON CONFLICT (location_id) DO UPDATE SET status = 'running', started_at = NOW(), client_id = EXCLUDED.client_id, client_name = EXCLUDED.client_name
      WHERE ghl_cache_state.status <> 'running' OR ghl_cache_state.started_at < NOW() - make_interval(hours => $4)
     RETURNING location_id`, [t.locationId, t.clientId, t.clientName, LOCK_STALE_HOURS]);
  if (!locked.length) return { ...r, status: 'locked', ms: Date.now() - t0 };

  const [state] = await query<{ run_start: string; appointments_backfilled_at: string | null; forms_backfilled_at: string | null; forms_synced_at: string | null }>(
    `SELECT NOW()::text AS run_start, appointments_backfilled_at::text, forms_backfilled_at::text, forms_synced_at::text
       FROM ghl_cache_state WHERE location_id = $1`, [t.locationId]);
  const runStart = state.run_start;

  let token = opts.token || '';
  if (!token) {
    try { token = decrypt(t.tokenEnc).trim(); } catch { r.errors.token = 'stored token cannot be decrypted'; }
  }
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { r.errors[name] = err instanceof Error ? err.message : String(err); }
  };
  if (token) {
    await step('contacts', () => syncContacts(t, token, runStart, r));
    const cal: { ids: string[] | null } = { ids: null };
    await step('calendars', async () => { cal.ids = await syncCalendars(t, token, runStart, r); });
    const calendarIds = cal.ids;
    if (calendarIds) await step('appointments', () => syncAppointments(t, token, calendarIds, !!state.appointments_backfilled_at, runStart, r));
    await step('forms', () => syncForms(t, token, state.forms_synced_at, !!state.forms_backfilled_at, r));
  }

  const nErr = Object.keys(r.errors).length;
  r.status = nErr === 0 ? 'ok' : (r.contacts ? 'partial' : 'error');
  await query(
    `UPDATE ghl_cache_state SET status = $2, finished_at = NOW(), errors = $3::jsonb,
            last_success_at = CASE WHEN $2 = 'ok' THEN NOW() ELSE last_success_at END
      WHERE location_id = $1`, [t.locationId, r.status, JSON.stringify(r.errors)]);
  r.ms = Date.now() - t0;
  return r;
}

export async function syncAllGhlCaches(opts: { onlyLocationIds?: string[]; log?: (r: GhlCacheResult) => void } = {}): Promise<GhlCacheResult[]> {
  const out: GhlCacheResult[] = [];
  for (const t of await getGhlCacheTargets(opts.onlyLocationIds)) {
    let r: GhlCacheResult;
    try { r = await syncGhlLocation(t); }
    catch (err) {
      // Last-resort guard (e.g. the DB itself failed) so one location can't stop the rest.
      r = { locationId: t.locationId, clientName: t.clientName, status: 'error', errors: { fatal: err instanceof Error ? err.message : String(err) }, ms: 0 };
      await query(`UPDATE ghl_cache_state SET status = 'error', finished_at = NOW(), errors = $2::jsonb WHERE location_id = $1`,
        [t.locationId, JSON.stringify(r.errors)]).catch(() => {});
    }
    out.push(r);
    opts.log?.(r);
  }
  return out;
}
