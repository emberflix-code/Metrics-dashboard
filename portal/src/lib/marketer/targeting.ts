// Server-only assembly for the marketer targeting-overlap report: pulls the
// active, spending ad sets across every scoped account, their normalized
// geo circles, the club coordinates, and runs the pure engine in
// lib/geoOverlap.ts over them.
//
// Three array-parameter queries and in-memory joins — the universe is a
// few thousand ad sets at most, and doing the joins here keeps the SQL
// readable and the attribution rules in one place.
import { query } from '../db';
import { loadMarketerScope, type MarketerClient } from '../marketerScope';
import {
  computeOverlaps, offClubFlags, type AdsetCircle, type OverlapPair, type OffClubFlag,
} from '../geoOverlap';

export interface TargetingFilters {
  since: string;
  until: string;
  clientIds?: string[];
  brand?: string;
  accountIds?: string[];
  minScore?: number;
  includeSameCampaign?: boolean;
  includeInactive?: boolean;
}

export interface TargetingClub {
  clientId: string;
  name: string;
  brand: string;
  lat: number;
  lng: number;
  offer: string;
  address: string;
  adsetCount: number;
  spend: number;
  results: number;
}

export interface BroadAdset {
  accountId: string;
  adsetId: string;
  adsetName: string;
  campaignName: string;
  clientName: string | null;
  kinds: string[];
  spend: number;
}

export interface TargetingReport {
  range: { since: string; until: string };
  clubs: TargetingClub[];
  adsets: AdsetCircle[];
  pairs: OverlapPair[];
  offClub: OffClubFlag[];
  broad: BroadAdset[];
  unmapped: {
    adsetsWithoutTargeting: number;
    adsetsWithoutCoordinates: { accountId: string; adsetId: string; adsetName: string; campaignName: string; spend: number }[];
    clientsWithoutGeocode: { clientId: string; name: string; address: string; error: string | null }[];
  };
  summary: {
    adsets: number;
    circles: number;
    pairsHigh: number;
    pairsMedium: number;
    pairsLow: number;
    spendInHighPairs: number;
    clubs: number;
    clubsGeocoded: number;
  };
}

interface AdsetRow {
  account_id: string;
  entity_id: string;
  name: string;
  campaign_id: string | null;
  campaign_name: string | null;
  effective_status: string;
  has_targeting: boolean;
  daily_budget: string | null;
  campaign_status: string | null;
  offer: string;
  client_id: string | null;
}

interface SpendRow { account_id: string; entity_id: string; spend: string; results: string }

interface GeoRowDb {
  account_id: string; adset_id: string; seq: number; kind: string;
  lat: number | null; lng: number | null; radius_km: number | null; approx: boolean;
}

const ACTIVE_STATUSES = ['ACTIVE'];
const INACTIVE_TOO = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'];

// 5-minute memo: the page and the JSON route hit the same filters back to
// back, and the underlying tables only change on sync. Invalidated by the
// geocode/backfill routes, which are the only in-app writers.
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 40;
const cache = new Map<string, { at: number; report: TargetingReport }>();

export function invalidateTargetingCache(): void {
  cache.clear();
}

function cacheKey(f: TargetingFilters): string {
  return JSON.stringify({
    since: f.since, until: f.until,
    clientIds: (f.clientIds ?? []).slice().sort(),
    brand: f.brand ?? '',
    accountIds: (f.accountIds ?? []).slice().sort(),
    minScore: f.minScore ?? 0.05,
    sc: !!f.includeSameCampaign,
    ia: !!f.includeInactive,
  });
}

export async function buildTargetingReport(f: TargetingFilters): Promise<TargetingReport> {
  const key = cacheKey(f);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.report;

  const report = await assemble(f);

  if (cache.size >= CACHE_MAX) {
    const oldest = Array.from(cache.entries()).sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { at: Date.now(), report });
  return report;
}

async function assemble(f: TargetingFilters): Promise<TargetingReport> {
  const scope = await loadMarketerScope();
  const wantedAccounts = f.accountIds && f.accountIds.length > 0
    ? scope.accountIds.filter(id => f.accountIds!.includes(id))
    : scope.accountIds;
  const clientIdFilter = f.clientIds && f.clientIds.length > 0 ? new Set(f.clientIds) : null;
  const brandFilter = f.brand ? f.brand : null;

  const clubMatchesFilter = (c: MarketerClient): boolean => {
    if (clientIdFilter && !clientIdFilter.has(c.id)) return false;
    if (brandFilter && c.brand !== brandFilter) return false;
    if (f.accountIds && f.accountIds.length > 0 && !c.adAccountIds.some(a => wantedAccounts.includes(a))) return false;
    return true;
  };

  const empty: TargetingReport = {
    range: { since: f.since, until: f.until },
    clubs: [], adsets: [], pairs: [], offClub: [], broad: [],
    unmapped: { adsetsWithoutTargeting: 0, adsetsWithoutCoordinates: [], clientsWithoutGeocode: [] },
    summary: { adsets: 0, circles: 0, pairsHigh: 0, pairsMedium: 0, pairsLow: 0, spendInHighPairs: 0, clubs: 0, clubsGeocoded: 0 },
  };
  if (wantedAccounts.length === 0) return empty;

  const statuses = f.includeInactive ? INACTIVE_TOO : ACTIVE_STATUSES;

  const [adsetRows, spendRows] = await Promise.all([
    query<AdsetRow>(
      `SELECT a.account_id, a.entity_id, a.name, a.campaign_id, a.campaign_name, a.effective_status,
              (a.targeting IS NOT NULL) AS has_targeting,
              a.daily_budget::text AS daily_budget,
              c.effective_status AS campaign_status,
              COALESCE(o.offer, c.offer_token, 'Unknown') AS offer,
              m.client_id::text AS client_id
       FROM meta_entities a
       LEFT JOIN meta_entities c ON c.account_id = a.account_id AND c.level = 'campaign' AND c.entity_id = a.campaign_id
       LEFT JOIN campaign_offer_overrides o ON o.account_id = a.account_id AND o.campaign_id = a.campaign_id
       LEFT JOIN marketer_campaign_client m ON m.account_id = a.account_id AND m.campaign_id = a.campaign_id AND m.is_primary
       WHERE a.level = 'adset' AND a.account_id = ANY($1) AND a.effective_status = ANY($2)`,
      [wantedAccounts, statuses]
    ),
    query<SpendRow>(
      `SELECT account_id, entity_id, SUM(spend)::text AS spend, SUM(results)::text AS results
       FROM meta_daily_insights
       WHERE level = 'adset' AND account_id = ANY($1) AND date >= $2 AND date <= $3
       GROUP BY account_id, entity_id
       HAVING SUM(spend) > 0`,
      [wantedAccounts, f.since, f.until]
    ),
  ]);

  const spendByAdset = new Map<string, { spend: number; results: number }>();
  for (const r of spendRows) spendByAdset.set(`${r.account_id}:${r.entity_id}`, { spend: parseFloat(r.spend) || 0, results: parseInt(r.results, 10) || 0 });

  // Universe: right status, parent campaign not paused, spent in range,
  // and passing the client/brand filters via primary attribution. A
  // missing campaign row (not yet synced) is not treated as paused — the
  // ad set's own effective_status already reflects a paused parent.
  const universe = adsetRows.filter(r => {
    const s = spendByAdset.get(`${r.account_id}:${r.entity_id}`);
    if (!s) return false;
    if (r.campaign_status && !statuses.includes(r.campaign_status)) return false;
    const client = r.client_id ? scope.clientById.get(r.client_id) : undefined;
    if (clientIdFilter && (!client || !clientIdFilter.has(client.id))) return false;
    if (brandFilter && (!client || client.brand !== brandFilter)) return false;
    return true;
  });

  const geoRows = universe.length > 0
    ? await query<GeoRowDb>(
        `SELECT account_id, adset_id, seq, kind, lat, lng, radius_km, approx
         FROM meta_adset_geo
         WHERE excluded = false AND account_id = ANY($1) AND adset_id = ANY($2)
         ORDER BY account_id, adset_id, seq`,
        [Array.from(new Set(universe.map(r => r.account_id))), universe.map(r => r.entity_id)]
      )
    : [];
  const geoByAdset = new Map<string, GeoRowDb[]>();
  for (const g of geoRows) {
    const k = `${g.account_id}:${g.adset_id}`;
    const list = geoByAdset.get(k);
    if (list) list.push(g); else geoByAdset.set(k, [g]);
  }

  const circles: AdsetCircle[] = [];
  const broad: BroadAdset[] = [];
  const withoutCoordinates: TargetingReport['unmapped']['adsetsWithoutCoordinates'] = [];
  let withoutTargeting = 0;

  for (const r of universe) {
    const k = `${r.account_id}:${r.entity_id}`;
    const s = spendByAdset.get(k)!;
    const client = r.client_id ? scope.clientById.get(r.client_id) : undefined;
    if (!r.has_targeting) { withoutTargeting++; continue; }

    const rows = geoByAdset.get(k) ?? [];
    const radiusRows = rows.filter(g => g.radius_km !== null && g.radius_km > 0);
    const located = radiusRows.filter(g => g.lat !== null && g.lng !== null);

    if (located.length > 0) {
      const dailyBudget = r.daily_budget ? Number(r.daily_budget) / 100 : null;
      for (const g of located) {
        circles.push({
          circleId: `${r.entity_id}#${g.seq}`,
          seq: g.seq,
          accountId: r.account_id,
          accountName: scope.accountNameById.get(r.account_id) || r.account_id,
          adsetId: r.entity_id,
          adsetName: r.name,
          campaignId: r.campaign_id || '',
          campaignName: r.campaign_name || '',
          clientId: client?.id ?? null,
          clientName: client?.name ?? null,
          brand: client?.brand ?? null,
          offer: r.offer,
          status: r.effective_status,
          lat: Number(g.lat),
          lng: Number(g.lng),
          radiusKm: Number(g.radius_km),
          approx: !!g.approx,
          kind: g.kind,
          spend: s.spend,
          results: s.results,
          cpl: s.results > 0 ? s.spend / s.results : null,
          dailyBudget: dailyBudget !== null && Number.isFinite(dailyBudget) ? dailyBudget : null,
        });
      }
      continue;
    }

    if (radiusRows.length > 0) {
      // City/zip rows whose key never resolved through geo_key_cache.
      withoutCoordinates.push({ accountId: r.account_id, adsetId: r.entity_id, adsetName: r.name, campaignName: r.campaign_name || '', spend: s.spend });
      continue;
    }

    broad.push({
      accountId: r.account_id,
      adsetId: r.entity_id,
      adsetName: r.name,
      campaignName: r.campaign_name || '',
      clientName: client?.name ?? null,
      kinds: rows.length > 0 ? Array.from(new Set(rows.map(g => g.kind))) : ['no geo rows'],
      spend: s.spend,
    });
  }
  broad.sort((x, y) => y.spend - x.spend);
  withoutCoordinates.sort((x, y) => y.spend - x.spend);

  // Clubs: per-club ad set counts come from the whole universe (including
  // broad/unlocated ad sets) — the pin popup answers "how many ad sets run
  // for this club", not "how many circles did we draw".
  const clubAgg = new Map<string, { adsets: Set<string>; spend: number; results: number }>();
  for (const r of universe) {
    if (!r.client_id) continue;
    const s = spendByAdset.get(`${r.account_id}:${r.entity_id}`)!;
    const agg = clubAgg.get(r.client_id) ?? { adsets: new Set<string>(), spend: 0, results: 0 };
    agg.adsets.add(`${r.account_id}:${r.entity_id}`);
    agg.spend += s.spend;
    agg.results += s.results;
    clubAgg.set(r.client_id, agg);
  }

  const clubs: TargetingClub[] = [];
  const clientsWithoutGeocode: TargetingReport['unmapped']['clientsWithoutGeocode'] = [];
  const clubCoords = new Map<string, { lat: number; lng: number }>();
  const visibleClubs = scope.locationClients.filter(clubMatchesFilter);
  for (const c of visibleClubs) {
    if (c.lat !== null && c.lng !== null) {
      const agg = clubAgg.get(c.id);
      clubs.push({
        clientId: c.id, name: c.name, brand: c.brand, lat: c.lat, lng: c.lng, offer: c.offer, address: c.locationAddress,
        adsetCount: agg?.adsets.size ?? 0, spend: agg?.spend ?? 0, results: agg?.results ?? 0,
      });
      clubCoords.set(c.id, { lat: c.lat, lng: c.lng });
    } else {
      clientsWithoutGeocode.push({ clientId: c.id, name: c.name, address: c.locationAddress, error: c.geocodeError ?? (c.locationAddress ? null : 'no address') });
    }
  }

  const pairs = computeOverlaps(circles, { minScore: f.minScore ?? 0.05, includeSameCampaign: !!f.includeSameCampaign });
  const offClub = offClubFlags(circles, clubCoords);

  let pairsHigh = 0, pairsMedium = 0, pairsLow = 0;
  const highAdsets = new Map<string, number>();
  for (const p of pairs) {
    if (p.severity === 'high') {
      pairsHigh++;
      highAdsets.set(`${p.a.accountId}:${p.a.adsetId}`, p.a.spend);
      highAdsets.set(`${p.b.accountId}:${p.b.adsetId}`, p.b.spend);
    } else if (p.severity === 'medium') pairsMedium++;
    else pairsLow++;
  }
  let spendInHighPairs = 0;
  highAdsets.forEach(v => { spendInHighPairs += v; });

  return {
    range: { since: f.since, until: f.until },
    clubs,
    adsets: circles,
    pairs,
    offClub,
    broad,
    unmapped: { adsetsWithoutTargeting: withoutTargeting, adsetsWithoutCoordinates: withoutCoordinates, clientsWithoutGeocode },
    summary: {
      adsets: universe.length,
      circles: circles.length,
      pairsHigh, pairsMedium, pairsLow,
      spendInHighPairs,
      clubs: visibleClubs.length,
      clubsGeocoded: clubs.length,
    },
  };
}
