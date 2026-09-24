// Location health scorecard: one row per location client for the range,
// with CPL judged against a peer median (same brand + same dominant offer,
// falling back to brand, then agency) so a $40 CPL reads as good for one
// offer and bad for another instead of against one global number. Bookings
// come from each client's GHL contacts (same rule as the client dashboard
// and Agency Overview), with the booking calendar the marketing sheet maps
// for that location shown as a pill.
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { getAccountTimezone } from '@/lib/meta';
import { fetchGhlBookings, fetchGhlLeads, fetchGhlFormSubmissions, isQualifyingLead, dayInTimezone, GhlError } from '@/lib/ghl';
import { fetchSheetRows } from '@/lib/sheets';
import { loadMarketerScope, type MarketerClient } from '@/lib/marketerScope';
import { loadCampaignStats, median, emptyTotals, addTotals, cplOf, ctrOf, type Totals } from './campaignStats';

// Minimum sample before a client's CPL is judged or used as a peer.
export const MIN_PEER_SPEND = 100;
export const MIN_PEER_RESULTS = 3;

export interface ScorecardRow {
  clientId: string;
  name: string;
  brand: string;
  coach: string;
  marketingType: string;
  spend: number;
  // Leads as the client's own dashboard defines them (leadsSource): Meta
  // results, GHL qualifying contacts, or the leads sheet. CPL uses this.
  results: number;
  leadsSource: 'meta' | 'ghl' | 'sheet';
  metaResults: number;          // Meta's own results, always available for reference
  leadsError: string | null;    // GHL/sheet fetch failure — results then fall back to metaResults
  impressions: number;
  clicks: number;
  cpl: number | null;
  ctr: number | null;
  dominantOffer: string;        // offer with the most spend in range
  offers: string[];
  peerCpl: number | null;
  peerScope: 'brand+offer' | 'brand' | 'agency' | null;
  peerCount: number;
  cplDeltaPct: number | null;   // (cpl - peer) / peer * 100; negative = better than peers
  judged: boolean;              // false when below the minimum sample
  activeCampaigns: number;
  activeAdsets: number;
  accountIds: string[];
  dataThrough: string | null;   // oldest last_success_until across the client's accounts
  syncStale: boolean;
  hasAddress: boolean;
  geocoded: boolean;
  geocodeError: string | null;
  // Bookings: null when the client has no GHL token (or the fetch failed —
  // see bookingsError). Distinct contacts tagged as booked in the range,
  // bucketed by the ad account's timezone.
  bookings: number | null;
  cpb: number | null;
  bookingsError: string | null;
  bookingCalendar: { name: string; platform: string; link: string } | null;
}

export interface Scorecard {
  range: { since: string; until: string };
  live: boolean;
  rows: ScorecardRow[];
  totals: Totals & { cpl: number | null; ctr: number | null; bookings: number; cpb: number | null; bookingsClients: number };
  agencyMedianCpl: number | null;
  unattributed: { campaigns: number; spend: number; results: number };
}

export interface ScorecardFilters { since: string; until: string; brand?: string; coach?: string; live?: boolean; withBookings?: boolean }

interface ExternalCounts { bookings: number | null; bookingsError: string | null; leads: number | null; leadsError: string | null }

// GHL bookings (every client with a token) and, for clients whose Leads KPI
// is GHL- or sheet-sourced, their leads — the same rules the client
// dashboard and Agency Overview apply, so the marketer sees the number the
// client sees. Bucketed by the first ad account's timezone, like the Meta
// figures on the same row.
async function externalCountsForClients(clients: MarketerClient[], since: string, until: string): Promise<Map<string, ExternalCounts>> {
  const out = new Map<string, ExternalCounts>();
  const needGhl = clients.filter(c => c.hasGhlToken);
  const needSheet = clients.filter(c => c.leadsSource === 'sheet' && c.sheetId && c.sheetTab);
  if (needGhl.length === 0 && needSheet.length === 0) return out;

  const [tokens, conns] = await Promise.all([
    needGhl.length ? query<{ id: string; ghl_token_enc: string }>(`SELECT id, ghl_token_enc FROM clients WHERE id = ANY($1)`, [needGhl.map(c => c.id)]) : Promise.resolve([]),
    query<{ token_enc: string; account_ids: string[] }>(`SELECT token_enc, account_ids FROM agency_bm_connections`),
  ]);
  const ghlTokenById = new Map(tokens.map(t => [t.id, t.ghl_token_enc]));
  const metaTokenFor = (acct: string) => { const c = conns.find(x => (x.account_ids || []).includes(acct)); return c ? decrypt(c.token_enc) : null; };
  const entry = (id: string): ExternalCounts => { let e = out.get(id); if (!e) { e = { bookings: null, bookingsError: null, leads: null, leadsError: null }; out.set(id, e); } return e; };

  await Promise.all([
    ...needGhl.map(async c => {
      const e = entry(c.id);
      const enc = ghlTokenById.get(c.id);
      if (!enc) { e.bookingsError = 'no token'; return; }
      let token: string;
      try { token = decrypt(enc); } catch { e.bookingsError = 'token decrypt failed'; return; }
      const acct = c.adAccountIds[0];
      const metaToken = acct ? metaTokenFor(acct) : null;
      const timezone = acct && metaToken ? await getAccountTimezone(acct, metaToken).catch(() => 'UTC') : 'UTC';
      const inRange = (iso: string) => { const d = dayInTimezone(iso, timezone); return d >= since && d <= until; };
      try {
        const booked = await fetchGhlBookings({ token, locationId: c.ghlLocationId, leadsTag: c.ghlLeadsTag });
        e.bookings = new Set(booked.rows.filter(r => inRange(r.date)).map(r => r.contactId)).size;
      } catch (err) {
        e.bookingsError = (err instanceof GhlError ? `${err.code}: ${err.message}` : (err instanceof Error ? err.message : String(err))).slice(0, 160);
      }
      if (c.leadsSource === 'ghl') {
        try {
          const [leadsResult, submissions] = await Promise.all([
            fetchGhlLeads({ token, locationId: c.ghlLocationId }),
            fetchGhlFormSubmissions({ token, locationId: c.ghlLocationId }),
          ]);
          const byContact = new Map(leadsResult.rows.map(r => [r.contactId, r] as const));
          const ids = new Set<string>();
          for (const r of leadsResult.rows) if (inRange(r.date) && isQualifyingLead(r, c.ghlLeadsTag)) ids.add(r.contactId);
          for (const s of submissions.rows) {
            const contact = byContact.get(s.contactId);
            if (contact && isQualifyingLead(contact, c.ghlLeadsTag) && inRange(s.date)) ids.add(s.contactId);
          }
          e.leads = ids.size;
        } catch (err) {
          e.leadsError = (err instanceof GhlError ? `${err.code}: ${err.message}` : (err instanceof Error ? err.message : String(err))).slice(0, 160);
        }
      }
    }),
    ...needSheet.map(async c => {
      const e = entry(c.id);
      try {
        const { rows } = await fetchSheetRows(c.sheetId, c.sheetTab);
        e.leads = rows.filter(r => r.day >= since && r.day <= until).reduce((s, r) => s + (r.leads || 0), 0);
      } catch (err) {
        e.leadsError = (err instanceof Error ? err.message : String(err)).slice(0, 160);
      }
    }),
  ]);
  return out;
}

/** Distinct coach names across active location clients (comma-separated cells split). */
export function coachNames(clients: MarketerClient[]): string[] {
  const set = new Set<string>();
  for (const c of clients) for (const part of c.coachName.split(',')) { const p = part.trim(); if (p) set.add(p); }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function coachMatches(client: MarketerClient, coach: string): boolean {
  const want = coach.trim().toLowerCase();
  return client.coachName.split(',').some(p => p.trim().toLowerCase() === want);
}

export async function buildScorecard(f: ScorecardFilters): Promise<Scorecard> {
  const scope = await loadMarketerScope();
  const live = !!f.live;
  const stats = await loadCampaignStats(scope.accountIds, f.since, f.until, { includeUnattributed: true, live });

  const byClient = new Map<string, { totals: Totals; byOffer: Map<string, Totals>; activeCampaigns: number }>();
  const unattributed = { campaigns: 0, spend: 0, results: 0 };
  for (const s of stats) {
    if (!s.clientId) { unattributed.campaigns++; unattributed.spend += s.spend; unattributed.results += s.results; continue; }
    let e = byClient.get(s.clientId);
    if (!e) { e = { totals: emptyTotals(), byOffer: new Map(), activeCampaigns: 0 }; byClient.set(s.clientId, e); }
    addTotals(e.totals, s);
    let o = e.byOffer.get(s.offer);
    if (!o) { o = emptyTotals(); e.byOffer.set(s.offer, o); }
    addTotals(o, s);
    if (s.status === 'ACTIVE') e.activeCampaigns++;
  }

  const clients: MarketerClient[] = scope.locationClients
    .filter(c => !f.brand || c.brand === f.brand)
    .filter(c => !f.coach || coachMatches(c, f.coach));

  const [adsetRows, syncRows, bookingsByClient] = await Promise.all([
    scope.accountIds.length
      ? query<{ client_id: string; n: string }>(
          `SELECT m.client_id, COUNT(*)::text AS n
           FROM meta_entities a
           JOIN meta_entities c ON c.account_id = a.account_id AND c.level = 'campaign' AND c.entity_id = a.campaign_id
           JOIN marketer_campaign_client m ON m.account_id = a.account_id AND m.campaign_id = a.campaign_id AND m.is_primary
           WHERE a.level = 'adset' AND a.effective_status = 'ACTIVE' AND c.effective_status = 'ACTIVE' AND a.account_id = ANY($1)
           GROUP BY 1`,
          [scope.accountIds]
        )
      : Promise.resolve([]),
    scope.accountIds.length
      ? query<{ account_id: string; last_success_until: string | null; last_synced_at: string | null }>(
          `SELECT account_id, last_success_until, last_synced_at FROM agency_meta_sync_state WHERE account_id = ANY($1)`,
          [scope.accountIds]
        )
      : Promise.resolve([]),
    f.withBookings === false ? Promise.resolve(new Map<string, ExternalCounts>()) : externalCountsForClients(clients, f.since, f.until),
  ]);
  const externalByClient = bookingsByClient;
  const activeAdsetsByClient = new Map(adsetRows.map(r => [r.client_id, parseInt(r.n, 10) || 0]));
  const syncByAccount = new Map(syncRows.map(r => [r.account_id, r]));
  const staleCutoff = Date.now() - 36 * 3600_000;

  const rows: ScorecardRow[] = clients.map(c => {
    const e = byClient.get(c.id);
    const t = e?.totals ?? emptyTotals();
    const offers = e ? Array.from(e.byOffer.entries()).sort((a, b) => b[1].spend - a[1].spend) : [];
    const dominantOffer = offers[0]?.[0] ?? 'Unknown';
    const sync = c.adAccountIds.map(id => syncByAccount.get(id)).filter(Boolean);
    const dataThrough = live ? f.until : (sync.length ? sync.map(s => s!.last_success_until).filter(Boolean).sort()[0] ?? null : null);
    const syncStale = !live && c.adAccountIds.some(id => {
      const s = syncByAccount.get(id);
      return !s?.last_synced_at || new Date(s.last_synced_at).getTime() < staleCutoff;
    });
    const ext = externalByClient.get(c.id);
    const bookings = ext?.bookings ?? null;
    // Leads follow the client's configured source; a failed GHL/sheet fetch
    // falls back to Meta results and says so (leadsError).
    const externalLeads = c.leadsSource !== 'meta' ? ext?.leads ?? null : null;
    const results = externalLeads ?? t.results;
    const leadsError = c.leadsSource !== 'meta' ? (ext?.leadsError ?? (externalLeads === null ? 'source not configured' : null)) : null;
    return {
      clientId: c.id, name: c.name, brand: c.brand, coach: c.coachName, marketingType: c.marketingType,
      spend: t.spend, results, leadsSource: c.leadsSource, metaResults: t.results, leadsError,
      impressions: t.impressions, clicks: t.clicks,
      cpl: cplOf(t.spend, results), ctr: ctrOf(t.clicks, t.impressions),
      dominantOffer, offers: offers.map(o => o[0]),
      peerCpl: null, peerScope: null, peerCount: 0, cplDeltaPct: null,
      judged: t.spend >= MIN_PEER_SPEND && results >= MIN_PEER_RESULTS,
      activeCampaigns: e?.activeCampaigns ?? 0,
      activeAdsets: activeAdsetsByClient.get(c.id) ?? 0,
      accountIds: c.adAccountIds,
      dataThrough, syncStale,
      hasAddress: !!c.locationAddress, geocoded: c.lat !== null && c.lng !== null, geocodeError: c.geocodeError,
      bookings,
      cpb: bookings !== null && bookings > 0 ? t.spend / bookings : null,
      bookingsError: ext?.bookingsError ?? null,
      bookingCalendar: c.bookingCalendar,
    };
  });

  // Peer medians from every location client in scope (not just the
  // filtered view), so a brand filter doesn't shrink the peer pool. Uses
  // each row's own lead definition where the row exists; unfiltered
  // clients fall back to Meta results (their external sources weren't
  // fetched for this view).
  const rowById = new Map(rows.map(r => [r.clientId, r]));
  const allRows: { brand: string; offer: string; cpl: number }[] = [];
  for (const c of scope.locationClients) {
    const e = byClient.get(c.id);
    if (!e) continue;
    const t = e.totals;
    const leads = rowById.get(c.id)?.results ?? t.results;
    if (t.spend < MIN_PEER_SPEND || leads < MIN_PEER_RESULTS) continue;
    const dominant = Array.from(e.byOffer.entries()).sort((a, b) => b[1].spend - a[1].spend)[0]?.[0] ?? 'Unknown';
    const cpl = cplOf(t.spend, leads);
    if (cpl !== null) allRows.push({ brand: c.brand, offer: dominant, cpl });
  }
  const agencyMedianCpl = median(allRows.map(r => r.cpl));
  const peerFor = (brand: string, offer: string, selfCpl: number): { cpl: number | null; scope: ScorecardRow['peerScope']; n: number } => {
    // Exclude the row itself from its own peer set (one occurrence).
    const without = (list: number[]) => { const i = list.indexOf(selfCpl); if (i >= 0) list.splice(i, 1); return list; };
    const bo = without(allRows.filter(r => r.brand === brand && r.offer === offer).map(r => r.cpl));
    if (bo.length >= 3) return { cpl: median(bo), scope: 'brand+offer', n: bo.length };
    const b = without(allRows.filter(r => r.brand === brand).map(r => r.cpl));
    if (b.length >= 3) return { cpl: median(b), scope: 'brand', n: b.length };
    const a = without(allRows.map(r => r.cpl));
    return a.length > 0 ? { cpl: median(a), scope: 'agency', n: a.length } : { cpl: null, scope: null, n: 0 };
  };
  for (const r of rows) {
    if (!r.judged || r.cpl === null) continue;
    const p = peerFor(r.brand, r.dominantOffer, r.cpl);
    r.peerCpl = p.cpl; r.peerScope = p.scope; r.peerCount = p.n;
    r.cplDeltaPct = p.cpl && p.cpl > 0 ? ((r.cpl - p.cpl) / p.cpl) * 100 : null;
  }

  // Worst delta first; unjudged rows (too little data) after, by spend.
  rows.sort((a, b) => {
    if (a.judged !== b.judged) return a.judged ? -1 : 1;
    if (a.judged) return (b.cplDeltaPct ?? -Infinity) - (a.cplDeltaPct ?? -Infinity);
    return b.spend - a.spend;
  });

  const totals = emptyTotals();
  let bookings = 0, bookingsClients = 0, bookingsSpend = 0;
  for (const r of rows) {
    totals.spend += r.spend;
    totals.results += r.results;
    totals.impressions += r.impressions;
    totals.clicks += r.clicks;
    if (r.bookings !== null) { bookings += r.bookings; bookingsClients++; bookingsSpend += r.spend; }
  }
  return {
    range: { since: f.since, until: f.until },
    live,
    rows,
    totals: {
      ...totals,
      cpl: cplOf(totals.spend, totals.results), ctr: ctrOf(totals.clicks, totals.impressions),
      bookings, bookingsClients, cpb: bookings > 0 ? bookingsSpend / bookings : null,
    },
    agencyMedianCpl,
    unattributed,
  };
}
