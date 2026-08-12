// GoHighLevel bookings + leads helper.
//
// fetchGhlBookings returns one row per (contact, attribution snapshot) for
// every contact tagged "booked appointment" whose dateUpdated-dateAdded ≤ 30
// days. fetchGhlLeads (below) returns one or two rows per contact for EVERY
// contact in the location (first-touch always, plus last-touch when a
// contact re-attributes to a different campaign — same split as bookings) —
// used by the Agency Overview so Leads and Bookings are genuinely distinct
// numbers instead of both reading the tagged-contact set. The raw fetch is
// unfiltered; callers apply isQualifyingLead() (tag-or-attribution) to
// decide which rows actually count as leads.
//
// Per contact, we may emit up to 2 rows:
//   1. (attributionSource.campaign, dateAdded)       — first-touch
//   2. (lastAttributionSource.campaign, dateUpdated) — last-touch
//      (only if the campaign differs from first-touch)
//
// Caller (route → dashboard) is responsible for clipping rows to its
// requested date range. We do not pre-filter so the cache is keyed on token
// alone, not on date range — bookings rarely shift backfill, the 5-min TTL
// is enough.
//
// `dateAdded`/`dateUpdated` are exposed as raw ISO 8601 UTC timestamps, NOT
// pre-bucketed into a day here — bucketing by a naive UTC slice is wrong (a
// contact created late evening local time can land on the next UTC day and
// silently fall outside a range GHL's own UI still shows it under), but the
// "correct" timezone to bucket by is the CLIENT'S META AD ACCOUNT timezone
// (to match how the rest of the app aligns "today/yesterday" with Meta BM),
// not GHL's own per-location timezone — those can differ. This module has no
// Meta dependency, so callers resolve the account timezone themselves (see
// getAccountTimezone in lib/meta.ts) and call dayInTimezone() below.
//
// Confirmed working against Empowered's PIT during the planning session.
// See memory: ghl-pit-api.

import { createHash } from 'crypto';

export interface GhlBookingRow {
  campaignId: string;
  date: string;          // ISO 8601 UTC — dateAdded for 'first' rows, dateUpdated for 'last' rows
  contactId: string;
  attribution: 'first' | 'last';
  // True when the contact also carries the "cancelled appointment" tag.
  // Counted toward total bookings but NOT toward kept bookings — used for
  // the Book Rate (kept / booked) ratio.
  cancelled: boolean;
}

export interface GhlFetchResult {
  rows: GhlBookingRow[];
  bookedContactsScanned: number;
  outsideWindow: number;
  cancelledContacts: number;
}

export class GhlError extends Error {
  code: 'NO_TOKEN' | 'INVALID_TOKEN' | 'INSUFFICIENT_SCOPE' | 'RATE_LIMIT' | 'UPSTREAM_5XX';
  status: number;
  constructor(code: GhlError['code'], message: string, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// 5-minute cache keyed by token-hash only. Bookings don't change minute-to-minute.
const TTL_MS = 5 * 60 * 1000;
const _cache = new Map<string, { expires: number; result: GhlFetchResult }>();

// GHL contact shape (only the fields we read). All optional because the API
// occasionally returns partial responses.
interface GhlContact {
  id?: string;
  dateAdded?: string;       // ISO 8601
  dateUpdated?: string;     // ISO 8601
  tags?: string[];
  firstName?: string;
  lastName?: string;
  email?: string;
  attributionSource?: { campaign?: string };
  lastAttributionSource?: { campaign?: string };
}

interface SearchResponse {
  contacts?: GhlContact[];
  total?: number;
  traceId?: string;
  // GHL paginates by returning a cursor inside each contact: contact.searchAfter.
  // The body for the next page should include `searchAfter: <last contact's cursor>`.
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 50;     // 50 × 100 = 5000 booked contacts — safety cap
const PAGE_LIMIT = 100;
export const BOOKING_TAG = 'booked appointment';
const CANCELLED_TAG = 'cancelled appointment';

// Try to extract location_id from a 3-segment JWT-style PIT. Modern `pit-<uuid>`
// PITs don't carry it, in which case the caller must supply locationId
// explicitly — GHL's /contacts/search returns 422 without it.
function tryExtractLocationId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
    return typeof payload.location_id === 'string' ? payload.location_id : null;
  } catch {
    return null;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32);
}

// Converts an ISO 8601 UTC timestamp to a YYYY-MM-DD day string in the given
// IANA timezone, e.g. dayInTimezone('2026-07-28T03:20:52.840Z',
// 'America/New_York') -> '2026-07-27' (11:20 PM the prior day local time).
// Falls back to a naive UTC slice if the timezone is invalid. Exported so
// callers (the Overview page, the ghl-leads route) can bucket
// dateAdded/dateUpdated by the client's own Meta ad account timezone.
export function dayInTimezone(isoTimestamp: string, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(isoTimestamp));
    const year = parts.find(p => p.type === 'year')?.value;
    const month = parts.find(p => p.type === 'month')?.value;
    const day = parts.find(p => p.type === 'day')?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid timezone string — fall through.
  }
  return isoTimestamp.slice(0, 10);
}

export async function fetchGhlBookings(opts: { token: string; locationId?: string }): Promise<GhlFetchResult> {
  const { token } = opts;
  if (!token) throw new GhlError('NO_TOKEN', 'GHL token is not configured for this client.', 400);

  // Resolve locationId: caller-provided wins, fall back to JWT payload.
  const locationId = opts.locationId?.trim() || tryExtractLocationId(token);
  if (!locationId) {
    throw new GhlError('NO_TOKEN', 'GHL location ID is required. Paste it in the admin form next to the PIT.', 400);
  }

  const cacheKey = `${hashToken(token)}|${locationId}`;
  const hit = _cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.result;

  const rows: GhlBookingRow[] = [];
  let bookedContactsScanned = 0;
  let outsideWindow = 0;
  let cancelledContacts = 0;
  let searchAfter: unknown[] | undefined;
  let page = 0;

  while (page < MAX_PAGES) {
    page++;
    const body: Record<string, unknown> = {
      locationId,
      pageLimit: PAGE_LIMIT,
      filters: [{ field: 'tags', operator: 'contains', value: BOOKING_TAG }],
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      let detail = '';
      try { detail = (await res.json())?.message || ''; } catch { /* ignore */ }
      if (/scope/i.test(detail)) {
        throw new GhlError('INSUFFICIENT_SCOPE', 'GHL token is missing required scope. Regenerate the Private Integration token in GHL Settings → Private Integrations with at least the contacts.readonly scope.', 403);
      }
      throw new GhlError('INVALID_TOKEN', 'GHL token is invalid or expired.', 401);
    }
    if (res.status === 422) {
      let detail = '';
      try { detail = (await res.json())?.message || ''; } catch { /* ignore */ }
      throw new GhlError('UPSTREAM_5XX', `GHL rejected the request: ${detail || '422'}`, 502);
    }
    if (res.status === 429) throw new GhlError('RATE_LIMIT', 'GHL API rate limit reached. Please wait a minute and reload.', 429);
    if (res.status >= 500) throw new GhlError('UPSTREAM_5XX', `GHL API returned ${res.status}.`);

    let json: SearchResponse;
    try { json = await res.json(); } catch { throw new GhlError('UPSTREAM_5XX', 'GHL returned a malformed response.'); }

    const contacts = json.contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      if (!c.id || !c.dateAdded || !c.dateUpdated) continue;
      bookedContactsScanned++;

      const tAdded = Date.parse(c.dateAdded);
      const tUpdated = Date.parse(c.dateUpdated);
      if (!Number.isFinite(tAdded) || !Number.isFinite(tUpdated)) continue;
      if (tUpdated - tAdded > THIRTY_DAYS_MS) { outsideWindow++; continue; }

      // A contact is "cancelled" when they carry both the booked AND cancelled
      // tags. They still count toward total bookings (the booking happened);
      // the dashboard uses the cancelled flag to compute Book Rate = kept/total.
      const cancelled = Array.isArray(c.tags) && c.tags.includes(CANCELLED_TAG);
      if (cancelled) cancelledContacts++;

      const firstCampaign = c.attributionSource?.campaign?.trim();
      const lastCampaign = c.lastAttributionSource?.campaign?.trim();

      if (firstCampaign) {
        rows.push({
          campaignId: firstCampaign,
          date: c.dateAdded,
          contactId: c.id,
          attribution: 'first',
          cancelled,
        });
      }
      if (lastCampaign && lastCampaign !== firstCampaign) {
        rows.push({
          campaignId: lastCampaign,
          date: c.dateUpdated,
          contactId: c.id,
          attribution: 'last',
          cancelled,
        });
      }
    }

    // Pull the searchAfter cursor from the last contact.
    const lastContact = contacts[contacts.length - 1] as GhlContact & { searchAfter?: unknown[] };
    if (!lastContact?.searchAfter || lastContact.searchAfter.length === 0) break;
    searchAfter = lastContact.searchAfter;
    if (contacts.length < PAGE_LIMIT) break;
  }

  const result: GhlFetchResult = { rows, bookedContactsScanned, outsideWindow, cancelledContacts };
  _cache.set(cacheKey, { expires: Date.now() + TTL_MS, result });
  return result;
}

// Raw GHL leads — every contact (no tag filter applied here), for the Agency
// Overview's distinct "Leads" column. Separate cache map from bookings so
// the two don't evict each other; same token+locationId key, same 5-min TTL.
// The cache is unfiltered regardless of which tag a client configures for
// counting leads — see hasAttribution/tags below, filtered by the caller.
//
// Mirrors fetchGhlBookings' first-touch/last-touch split: an old contact who
// re-engages (re-submits a form, gets re-tagged, etc.) has their GHL
// `dateUpdated` bumped and `lastAttributionSource.campaign` repointed to
// whatever campaign brought them back — but their `dateAdded` stays frozen
// at their original (possibly months-old) creation date. Bucketing leads by
// dateAdded alone makes that re-engagement invisible to whatever week it
// actually happened in. So — same as bookings — we emit up to 2 rows per
// contact: one anchored on dateAdded/first-touch, one on
// dateUpdated/last-touch (only when the last-touch campaign differs from
// first-touch). Callers dedupe by contactId within a range, so a contact
// whose dateAdded AND dateUpdated both land in the same window isn't
// double-counted — they just match on either row.
export interface GhlLeadRow {
  campaignId: string;
  date: string;  // ISO 8601 UTC — dateAdded for 'first' rows, dateUpdated for 'last' rows
  contactId: string;
  name: string;
  email: string;
  tags: string[];
  hasAttribution: boolean;
  attribution: 'first' | 'last';
}

export interface GhlLeadsFetchResult {
  rows: GhlLeadRow[];
  contactsScanned: number;
}

const _leadsCache = new Map<string, { expires: number; result: GhlLeadsFetchResult }>();

export async function fetchGhlLeads(opts: { token: string; locationId?: string }): Promise<GhlLeadsFetchResult> {
  const { token } = opts;
  if (!token) throw new GhlError('NO_TOKEN', 'GHL token is not configured for this client.', 400);

  const locationId = opts.locationId?.trim() || tryExtractLocationId(token);
  if (!locationId) {
    throw new GhlError('NO_TOKEN', 'GHL location ID is required. Paste it in the admin form next to the PIT.', 400);
  }

  const cacheKey = `${hashToken(token)}|${locationId}`;
  const hit = _leadsCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.result;

  const rows: GhlLeadRow[] = [];
  let contactsScanned = 0;
  let searchAfter: unknown[] | undefined;
  let page = 0;

  while (page < MAX_PAGES) {
    page++;
    const body: Record<string, unknown> = {
      locationId,
      pageLimit: PAGE_LIMIT,
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.status === 401) {
      let detail = '';
      try { detail = (await res.json())?.message || ''; } catch { /* ignore */ }
      if (/scope/i.test(detail)) {
        throw new GhlError('INSUFFICIENT_SCOPE', 'GHL token is missing required scope. Regenerate the Private Integration token in GHL Settings → Private Integrations with at least the contacts.readonly scope.', 403);
      }
      throw new GhlError('INVALID_TOKEN', 'GHL token is invalid or expired.', 401);
    }
    if (res.status === 422) {
      let detail = '';
      try { detail = (await res.json())?.message || ''; } catch { /* ignore */ }
      throw new GhlError('UPSTREAM_5XX', `GHL rejected the request: ${detail || '422'}`, 502);
    }
    if (res.status === 429) throw new GhlError('RATE_LIMIT', 'GHL API rate limit reached. Please wait a minute and reload.', 429);
    if (res.status >= 500) throw new GhlError('UPSTREAM_5XX', `GHL API returned ${res.status}.`);

    let json: SearchResponse;
    try { json = await res.json(); } catch { throw new GhlError('UPSTREAM_5XX', 'GHL returned a malformed response.'); }

    const contacts = json.contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      if (!c.id || !c.dateAdded) continue;
      contactsScanned++;

      const tAdded = Date.parse(c.dateAdded);
      if (!Number.isFinite(tAdded)) continue;

      const tags = Array.isArray(c.tags) ? c.tags : [];
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
      const email = c.email?.trim() || '';

      const firstCampaign = c.attributionSource?.campaign?.trim() || '';
      rows.push({
        campaignId: firstCampaign,
        date: c.dateAdded,
        contactId: c.id,
        name,
        email,
        tags,
        hasAttribution: firstCampaign.length > 0,
        attribution: 'first',
      });

      // Last-touch row — only when it actually differs from first-touch and
      // dateUpdated parses, same shape as fetchGhlBookings' split. This is
      // what makes a re-engaged old contact show up as a lead in the week
      // they came back, not just the week they were originally created.
      const lastCampaign = c.lastAttributionSource?.campaign?.trim() || '';
      const tUpdated = c.dateUpdated ? Date.parse(c.dateUpdated) : NaN;
      if (lastCampaign && lastCampaign !== firstCampaign && c.dateUpdated && Number.isFinite(tUpdated)) {
        rows.push({
          campaignId: lastCampaign,
          date: c.dateUpdated,
          contactId: c.id,
          name,
          email,
          tags,
          hasAttribution: true,
          attribution: 'last',
        });
      }
    }

    const lastContact = contacts[contacts.length - 1] as GhlContact & { searchAfter?: unknown[] };
    if (!lastContact?.searchAfter || lastContact.searchAfter.length === 0) break;
    searchAfter = lastContact.searchAfter;
    if (contacts.length < PAGE_LIMIT) break;
  }

  const result: GhlLeadsFetchResult = { rows, contactsScanned };
  _leadsCache.set(cacheKey, { expires: Date.now() + TTL_MS, result });
  return result;
}

// A GHL contact counts as a "real" lead based on the client's configured tag:
//   - Tag configured: the contact must carry that EXACT tag (case-insensitive)
//     to count. Attribution alone is NOT enough — a client tagging leads by
//     offer/campaign line (e.g. "new ad lead" vs. "new ad lead - stretch")
//     needs contacts from a different line correctly excluded even though
//     they still have real ad attribution.
//   - No tag configured: falls back to attributionSource.campaign being
//     populated (came in via a tracked ad) — NOT a fallback to counting
//     every contact in the location.
export function isQualifyingLead(row: GhlLeadRow, leadsTag: string): boolean {
  const tag = leadsTag.trim().toLowerCase();
  if (tag) return row.tags.some(t => t.toLowerCase() === tag);
  return row.hasAttribution;
}

// Confirms a PIT token actually has access to the given locationId, catching
// the case where an admin pastes a real token + a locationId copied from a
// DIFFERENT sub-account (GHL doesn't validate that the two belong together —
// the token silently serves data from whatever location it actually belongs
// to instead of erroring, which is exactly how a client can end up with
// another location's contacts showing as their leads). Uses the cheapest
// possible /contacts/search call (pageLimit: 1) purely to read the response
// status, not the data.
export async function verifyGhlLocationAccess(token: string, locationId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ locationId, pageLimit: 1 }),
    });
    if (res.status === 403) {
      return { ok: false, message: 'This token does not have access to that Location ID — double check you copied both from the same GHL sub-account.' };
    }
    if (res.status === 401) {
      return { ok: false, message: 'GHL token is invalid or expired.' };
    }
    if (!res.ok) {
      return { ok: false, message: `GHL rejected the request (status ${res.status}) — could not verify location access.` };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not reach GHL to verify location access — check your connection and try again.' };
  }
}
