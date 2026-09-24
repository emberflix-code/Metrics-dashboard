// Pure geometry for the marketer targeting-overlap report: which ad set
// radius circles overlap each other, and which sit away from the club they
// are attributed to. No I/O — the data assembly lives in
// lib/marketer/targeting.ts so this file stays importable from client
// components (types + pairKey) without dragging in the DB.

export interface LatLng { lat: number; lng: number }

export interface AdsetCircle {
  circleId: string;            // `${adsetId}#${seq}` — an ad set with several included locations yields several circles
  seq: number;
  accountId: string;
  accountName: string;
  adsetId: string;
  adsetName: string;
  campaignId: string;
  campaignName: string;
  clientId: string | null;
  clientName: string | null;
  brand: string | null;
  offer: string;
  status: string;
  lat: number;
  lng: number;
  radiusKm: number;
  approx: boolean;             // radius is an assumption (city/zip without an explicit "+N mi")
  kind: string;
  spend: number;
  results: number;
  cpl: number | null;
  dailyBudget: number | null;  // dollars
}

export type Severity = 'high' | 'medium' | 'low';

export interface OverlapPair {
  a: AdsetCircle;
  b: AdsetCircle;
  distanceKm: number;
  score: number;               // lens area / smaller circle's area, 0..1
  severity: Severity;
  sameClient: boolean;
  sameCampaign: boolean;
  sameOffer: boolean;
  combinedSpend: number;
}

export interface OffClubFlag {
  adset: AdsetCircle;
  clubLat: number;
  clubLng: number;
  distanceKm: number;
}

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_DEG_LAT = 111.32;

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Fraction of the SMALLER circle covered by the other one: 1 when one
 * circle contains the other, 0 when they don't touch. Normalizing by the
 * smaller circle (not the union) is deliberate — a 3 km ad set fully
 * inside a 40 km one is a 100% overlap for the small one even though it
 * barely dents the big one, and that is exactly the case a marketer wants
 * flagged.
 */
export function circleOverlapFraction(dKm: number, r1Km: number, r2Km: number): number {
  if (!(r1Km > 0) || !(r2Km > 0) || !Number.isFinite(dKm)) return 0;
  const rMin = Math.min(r1Km, r2Km);
  if (dKm >= r1Km + r2Km) return 0;
  if (dKm <= Math.abs(r1Km - r2Km)) return 1;
  const d = dKm, r1 = r1Km, r2 = r2Km;
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  const part1 = r1 * r1 * Math.acos(clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)));
  const part2 = r2 * r2 * Math.acos(clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2)));
  const kernel = (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2);
  const lens = part1 + part2 - 0.5 * Math.sqrt(Math.max(0, kernel));
  const frac = lens / (Math.PI * rMin * rMin);
  return Math.max(0, Math.min(1, frac));
}

/**
 * Two ad sets of the SAME client overlapping is usually intentional (a
 * retargeting set on top of a prospecting set), so it is demoted one tier;
 * different clients competing for the same people is the real problem.
 */
export function severityFor(score: number, sameClient: boolean): Severity {
  let sev: Severity = score >= 0.5 ? 'high' : score >= 0.2 ? 'medium' : 'low';
  if (sameClient) sev = sev === 'high' ? 'medium' : 'low';
  return sev;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

/** Stable identity for a pair regardless of which circle came first. */
export function pairKey(p: Pick<OverlapPair, 'a' | 'b'>): string {
  return `${p.a.accountId}:${p.a.adsetId}|${p.b.accountId}:${p.b.adsetId}`;
}

function orderPair(x: AdsetCircle, y: AdsetCircle): [AdsetCircle, AdsetCircle] {
  const kx = `${x.adsetId}#${x.seq}`;
  const ky = `${y.adsetId}#${y.seq}`;
  return kx <= ky ? [x, y] : [y, x];
}

export function computeOverlaps(
  circles: AdsetCircle[],
  opts: { minScore?: number; includeSameCampaign?: boolean } = {}
): OverlapPair[] {
  const minScore = opts.minScore ?? 0.05;
  const includeSameCampaign = !!opts.includeSameCampaign;
  const sorted = circles.filter(c => c.radiusKm > 0 && Number.isFinite(c.lat) && Number.isFinite(c.lng)).sort((a, b) => a.lat - b.lat);
  const maxR = sorted.reduce((m, c) => Math.max(m, c.radiusKm), 0);
  const pairs: OverlapPair[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      const dLat = b.lat - a.lat;
      // Sorted by latitude, so once the gap exceeds the largest possible
      // reach no later circle can touch `a` either.
      if (dLat > (a.radiusKm + maxR) / KM_PER_DEG_LAT) break;
      const reach = a.radiusKm + b.radiusKm;
      if (dLat > reach / KM_PER_DEG_LAT) continue;
      const cosLat = Math.max(0.05, Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180));
      if (Math.abs(b.lng - a.lng) > reach / (KM_PER_DEG_LAT * cosLat)) continue;
      if (a.adsetId === b.adsetId && a.accountId === b.accountId) continue;
      const sameCampaign = a.accountId === b.accountId && a.campaignId === b.campaignId;
      if (sameCampaign && !includeSameCampaign) continue;

      const distanceKm = haversineKm(a, b);
      const score = circleOverlapFraction(distanceKm, a.radiusKm, b.radiusKm);
      if (score <= minScore) continue;

      const sameClient = a.clientId !== null && a.clientId === b.clientId;
      const [pa, pb] = orderPair(a, b);
      pairs.push({
        a: pa, b: pb, distanceKm, score,
        severity: severityFor(score, sameClient),
        sameClient, sameCampaign,
        sameOffer: a.offer === b.offer,
        combinedSpend: a.spend + b.spend,
      });
    }
  }

  pairs.sort((x, y) =>
    SEVERITY_RANK[y.severity] - SEVERITY_RANK[x.severity]
    || y.score - x.score
    || y.combinedSpend - x.combinedSpend);
  return pairs;
}

/**
 * Circles whose center is farther from their attributed club than the
 * circle's own radius (min 5 km, so a tight 1-mile radius one street over
 * doesn't fire). Usually a copied ad set that kept the old city.
 */
export function offClubFlags(circles: AdsetCircle[], clubs: Map<string, LatLng>): OffClubFlag[] {
  const out: OffClubFlag[] = [];
  for (const c of circles) {
    if (!c.clientId) continue;
    const club = clubs.get(c.clientId);
    if (!club) continue;
    const distanceKm = haversineKm(c, club);
    if (distanceKm > Math.max(c.radiusKm, 5)) {
      out.push({ adset: c, clubLat: club.lat, clubLng: club.lng, distanceKm });
    }
  }
  out.sort((x, y) => y.distanceKm - x.distanceKm || y.adset.spend - x.adset.spend);
  return out;
}
