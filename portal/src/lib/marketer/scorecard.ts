// Location health scorecard: one row per location client for the range,
// with CPL judged against a peer median (same brand + same dominant offer,
// falling back to brand, then agency) so a $40 CPL reads as good for one
// offer and bad for another instead of against one global number.
import { query } from '@/lib/db';
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
  results: number;
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
}

export interface Scorecard {
  range: { since: string; until: string };
  rows: ScorecardRow[];
  totals: Totals & { cpl: number | null; ctr: number | null };
  agencyMedianCpl: number | null;
  unattributed: { campaigns: number; spend: number; results: number };
}

export async function buildScorecard(f: { since: string; until: string; brand?: string; coach?: string }): Promise<Scorecard> {
  const scope = await loadMarketerScope();
  const stats = await loadCampaignStats(scope.accountIds, f.since, f.until, { includeUnattributed: true });

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

  const [adsetRows, syncRows] = await Promise.all([
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
  ]);
  const activeAdsetsByClient = new Map(adsetRows.map(r => [r.client_id, parseInt(r.n, 10) || 0]));
  const syncByAccount = new Map(syncRows.map(r => [r.account_id, r]));
  const staleCutoff = Date.now() - 36 * 3600_000;

  const clients: MarketerClient[] = scope.locationClients
    .filter(c => !f.brand || c.brand === f.brand)
    .filter(c => !f.coach || c.coachName.toLowerCase().includes(f.coach.toLowerCase()));

  const rows: ScorecardRow[] = clients.map(c => {
    const e = byClient.get(c.id);
    const t = e?.totals ?? emptyTotals();
    const offers = e ? Array.from(e.byOffer.entries()).sort((a, b) => b[1].spend - a[1].spend) : [];
    const dominantOffer = offers[0]?.[0] ?? 'Unknown';
    const sync = c.adAccountIds.map(id => syncByAccount.get(id)).filter(Boolean);
    const dataThrough = sync.length ? sync.map(s => s!.last_success_until).filter(Boolean).sort()[0] ?? null : null;
    const syncStale = c.adAccountIds.some(id => {
      const s = syncByAccount.get(id);
      return !s?.last_synced_at || new Date(s.last_synced_at).getTime() < staleCutoff;
    });
    return {
      clientId: c.id, name: c.name, brand: c.brand, coach: c.coachName, marketingType: c.marketingType,
      spend: t.spend, results: t.results, impressions: t.impressions, clicks: t.clicks,
      cpl: cplOf(t.spend, t.results), ctr: ctrOf(t.clicks, t.impressions),
      dominantOffer, offers: offers.map(o => o[0]),
      peerCpl: null, peerScope: null, peerCount: 0, cplDeltaPct: null,
      judged: t.spend >= MIN_PEER_SPEND && t.results >= MIN_PEER_RESULTS,
      activeCampaigns: e?.activeCampaigns ?? 0,
      activeAdsets: activeAdsetsByClient.get(c.id) ?? 0,
      accountIds: c.adAccountIds,
      dataThrough, syncStale,
      hasAddress: !!c.locationAddress, geocoded: c.lat !== null && c.lng !== null, geocodeError: c.geocodeError,
    };
  });

  // Peer medians from every location client in scope (not just the
  // filtered view), so a brand filter doesn't shrink the peer pool.
  const allRows: { brand: string; offer: string; cpl: number }[] = [];
  for (const c of scope.locationClients) {
    const e = byClient.get(c.id);
    if (!e) continue;
    const t = e.totals;
    if (t.spend < MIN_PEER_SPEND || t.results < MIN_PEER_RESULTS) continue;
    const dominant = Array.from(e.byOffer.entries()).sort((a, b) => b[1].spend - a[1].spend)[0]?.[0] ?? 'Unknown';
    const cpl = cplOf(t.spend, t.results);
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
  for (const r of rows) {
    totals.spend += r.spend;
    totals.results += r.results;
    totals.impressions += r.impressions;
    totals.clicks += r.clicks;
  }
  return {
    range: { since: f.since, until: f.until },
    rows,
    totals: { ...totals, cpl: cplOf(totals.spend, totals.results), ctr: ctrOf(totals.clicks, totals.impressions) },
    agencyMedianCpl,
    unattributed,
  };
}
