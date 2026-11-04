import { NextRequest, NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { loadCoachClients } from '@/lib/coach/scope';
import { RANGE_KEYS } from '@/lib/coach/columns';
import { resolveDateRange } from '@/lib/dateRange';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { getAdminClientMetaScope, getAccountTimezone } from '@/lib/meta';
import { fetchGhlLeads, fetchGhlBookings, fetchGhlFormSubmissions, dayInTimezone, isQualifyingLead, GhlError } from '@/lib/ghl';

// GHL Leads / Bookings board columns — live GoHighLevel calls, so opt-in and
// separate from the cached metrics. Counted exactly like the Agency
// Overview: distinct qualifying contacts (dateAdded or a form submission in
// range, per the client's Leads Tag) and distinct booked contacts, bucketed
// in the client's Meta account timezone. Requested ids are intersected with
// the session's own scope; 4 clients at a time (GHL rate limits).
const CONCURRENCY = 4;

export async function POST(req: NextRequest) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  const body = await req.json().catch(() => ({}));
  const preset = RANGE_KEYS.includes(String(body.range)) ? String(body.range) : '7';
  const { since, until } = resolveDateRange({ preset }, '7');
  const requested = new Set<string>(Array.isArray(body.clientIds) ? body.clientIds.map(String) : []);

  const scoped = (await loadCoachClients(ctx, { adminCoachFilter: typeof body.coachFilter === 'string' ? body.coachFilter : '' }))
    .filter(c => requested.has(c.id) && c.hasGhlToken).slice(0, 60);
  if (!scoped.length) return NextResponse.json({ rows: {} });

  const secrets = await query<{ id: string; ghl_token_enc: string; ghl_location_id: string; ghl_leads_tag: string }>(
    `SELECT id, ghl_token_enc, ghl_location_id, ghl_leads_tag FROM clients WHERE id = ANY($1)`, [scoped.map(c => c.id)]);
  const secretById = new Map(secrets.map(s => [s.id, s] as const));
  const bm = await query<{ token_enc: string; account_ids: string[] }>(`SELECT token_enc, account_ids FROM agency_bm_connections`);
  const tokenByAccount = new Map<string, string>();
  for (const b of bm) for (const a of b.account_ids || []) if (!tokenByAccount.has(a)) tokenByAccount.set(a, b.token_enc);
  const agencyIds = Array.from(tokenByAccount.keys());

  const rows: Record<string, { ghl_leads: number; ghl_bookings: number } | { error: string }> = {};
  let next = 0;
  async function worker() {
    while (next < scoped.length) {
      const c = scoped[next++];
      const s = secretById.get(c.id)!;
      try {
        const token = decrypt(s.ghl_token_enc);
        const [leads, bookings, subs] = await Promise.all([
          fetchGhlLeads({ token, locationId: s.ghl_location_id }),
          fetchGhlBookings({ token, locationId: s.ghl_location_id, leadsTag: s.ghl_leads_tag }),
          fetchGhlFormSubmissions({ token, locationId: s.ghl_location_id }),
        ]);
        let tz = 'UTC';
        const scope = await getAdminClientMetaScope({ ad_account_ids: c.adAccountIds, campaign_filter: c.campaignFilter, google_data_source: c.googleDataSource }, agencyIds);
        const acc = scope.accountIds[0];
        if (acc && tokenByAccount.get(acc)) tz = await getAccountTimezone(acc, decrypt(tokenByAccount.get(acc)!));
        const inRange = (iso: string) => { const d = dayInTimezone(iso, tz); return d >= since && d <= until; };
        const byContact = new Map(leads.rows.map(r => [r.contactId, r] as const));
        const leadIds = new Set<string>();
        for (const r of leads.rows) if (inRange(r.date) && isQualifyingLead(r, s.ghl_leads_tag)) leadIds.add(r.contactId);
        for (const sub of subs.rows) {
          const contact = byContact.get(sub.contactId);
          if (contact && isQualifyingLead(contact, s.ghl_leads_tag) && inRange(sub.date)) leadIds.add(sub.contactId);
        }
        const bookIds = new Set(bookings.rows.filter(r => inRange(r.date)).map(r => r.contactId));
        rows[c.id] = { ghl_leads: leadIds.size, ghl_bookings: bookIds.size };
      } catch (err) {
        rows[c.id] = { error: err instanceof GhlError || err instanceof Error ? err.message : 'GHL fetch failed' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, scoped.length) }, worker));
  return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store' } });
}
