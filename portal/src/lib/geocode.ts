// Geocoding for the marketer targeting map: club street addresses
// (clients.location_address) and Meta targeting keys (cities/zips, which
// Meta's targeting spec carries WITHOUT coordinates).
//
// Provider: Google Geocoding when GOOGLE_MAPS_API_KEY is set (accurate on
// strip-mall suite addresses), else OpenStreetMap Nominatim (free, 1 req/s,
// identifying User-Agent required by its usage policy). Results are
// persisted (clients.location_lat/lng, geo_key_cache) so each address is
// geocoded once.
import { query } from './db';

export interface GeocodeResult {
  lat: number;
  lng: number;
  source: 'google' | 'nominatim';
  precision?: string;      // Google location_type (ROOFTOP, RANGE_INTERPOLATED, ...) or Nominatim class/type
  formatted?: string;
}

const GOOGLE_KEY = () => (process.env.GOOGLE_MAPS_API_KEY || '').trim();
const CONTACT = () => (process.env.GEOCODER_CONTACT_EMAIL || 'dashboard@gymmembersnow.com').trim();

// Nominatim usage policy: max 1 request/second, identifying User-Agent.
// A module-level promise chain serializes calls across concurrent callers.
let nominatimChain: Promise<void> = Promise.resolve();
const NOMINATIM_GAP_MS = 1100;
function nominatimSlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = nominatimChain.then(fn);
  nominatimChain = run.then(() => new Promise(r => setTimeout(r, NOMINATIM_GAP_MS)), () => new Promise(r => setTimeout(r, NOMINATIM_GAP_MS)));
  return run;
}

async function geocodeGoogle(q: string): Promise<GeocodeResult | null> {
  const u = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  u.searchParams.set('address', q);
  u.searchParams.set('key', GOOGLE_KEY());
  const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
  const json = await res.json() as { status: string; error_message?: string; results?: { geometry: { location: { lat: number; lng: number }; location_type?: string }; formatted_address?: string }[] };
  if (json.status === 'ZERO_RESULTS') return null;
  if (json.status !== 'OK') throw new Error(`Google geocode ${json.status}${json.error_message ? `: ${json.error_message}` : ''}`);
  const r = json.results?.[0];
  if (!r) return null;
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, source: 'google', precision: r.geometry.location_type, formatted: r.formatted_address };
}

async function geocodeNominatim(q: string): Promise<GeocodeResult | null> {
  return nominatimSlot(async () => {
    const u = new URL('https://nominatim.openstreetmap.org/search');
    u.searchParams.set('format', 'jsonv2');
    u.searchParams.set('limit', '1');
    u.searchParams.set('q', q);
    u.searchParams.set('countrycodes', 'us,ca');
    const res = await fetch(u, {
      headers: { 'User-Agent': `GymMembersNow-Dashboard/1.0 (${CONTACT()})`, 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const json = await res.json() as { lat: string; lon: string; display_name?: string; class?: string; type?: string }[];
    const r = json[0];
    if (!r) return null;
    return { lat: Number(r.lat), lng: Number(r.lon), source: 'nominatim', precision: r.type ? `${r.class}/${r.type}` : undefined, formatted: r.display_name };
  });
}

export function geocoderName(): 'google' | 'nominatim' {
  return GOOGLE_KEY() ? 'google' : 'nominatim';
}

/** Geocodes one free-text address/place string. Null when nothing matched; throws on provider errors. */
export async function geocodeAddress(q: string): Promise<GeocodeResult | null> {
  const s = q.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return GOOGLE_KEY() ? geocodeGoogle(s) : geocodeNominatim(s);
}

/**
 * Geocodes every active client whose location_address is set and either
 * never geocoded or edited since (geocode_query differs). Failures are
 * stored on clients.geocode_error and don't stop the batch.
 */
export async function geocodePendingClients(opts: { clientId?: string; limit?: number; force?: boolean } = {}): Promise<{ geocoded: number; failed: number; skipped: number }> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 200));
  const rows = await query<{ id: string; name: string; location_address: string }>(
    `SELECT id, name, location_address FROM clients
     WHERE active = true AND is_rollup = false AND location_address <> ''
       AND ($1::uuid IS NULL OR id = $1::uuid)
       AND ($2::boolean OR location_lat IS NULL OR geocode_query IS DISTINCT FROM location_address)
     ORDER BY sort_order ASC, name ASC
     LIMIT $3`,
    [opts.clientId ?? null, !!opts.force, limit]
  );
  let geocoded = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    try {
      const hit = await geocodeAddress(r.location_address);
      if (!hit) {
        skipped++;
        await query(`UPDATE clients SET geocode_query = $2, geocode_error = 'no match', geocoded_at = now() WHERE id = $1`, [r.id, r.location_address]);
        continue;
      }
      await query(
        `UPDATE clients SET location_lat = $2, location_lng = $3, geocode_source = $4, geocode_query = $5, geocode_error = NULL, geocoded_at = now() WHERE id = $1`,
        [r.id, hit.lat, hit.lng, `${hit.source}${hit.precision ? `:${hit.precision}` : ''}`, r.location_address]
      );
      geocoded++;
    } catch (err) {
      failed++;
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      await query(`UPDATE clients SET geocode_query = $2, geocode_error = $3, geocoded_at = now() WHERE id = $1`, [r.id, r.location_address, msg]).catch(() => {});
      console.error('[GEOCODE]', JSON.stringify({ clientId: r.id, name: r.name, error: msg }));
    }
  }
  return { geocoded, failed, skipped };
}

/**
 * Resolves Meta targeting keys (city/zip/region/geo_market) to coordinates via
 * geo_key_cache, geocoding the ones not seen before. Returns a map keyed
 * by `${kind}:${key}`; null value = looked up before, no match.
 */
export async function resolveGeoKeys(items: { kind: string; key: string; query: string }[]): Promise<Map<string, { lat: number; lng: number } | null>> {
  const out = new Map<string, { lat: number; lng: number } | null>();
  const uniq = new Map<string, { kind: string; key: string; query: string }>();
  for (const it of items) if (it.key && it.query) uniq.set(`${it.kind}:${it.key}`, it);
  if (uniq.size === 0) return out;

  const kinds = Array.from(uniq.values()).map(i => i.kind);
  const keys = Array.from(uniq.values()).map(i => i.key);
  const cached = await query<{ kind: string; key: string; lat: number | null; lng: number | null; error: string | null }>(
    `SELECT c.kind, c.key, c.lat, c.lng, c.error
     FROM geo_key_cache c
     JOIN unnest($1::text[], $2::text[]) AS t(kind, key) ON t.kind = c.kind AND t.key = c.key`,
    [kinds, keys]
  );
  for (const c of cached) {
    out.set(`${c.kind}:${c.key}`, c.lat !== null && c.lng !== null ? { lat: Number(c.lat), lng: Number(c.lng) } : null);
  }

  for (const [k, it] of Array.from(uniq.entries())) {
    if (out.has(k)) continue;
    try {
      const hit = await geocodeAddress(it.query);
      out.set(k, hit ? { lat: hit.lat, lng: hit.lng } : null);
      await query(
        `INSERT INTO geo_key_cache (kind, key, query, lat, lng, source, resolved_at, error)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7)
         ON CONFLICT (kind, key) DO UPDATE SET query = EXCLUDED.query, lat = EXCLUDED.lat, lng = EXCLUDED.lng, source = EXCLUDED.source, resolved_at = now(), error = EXCLUDED.error`,
        [it.kind, it.key, it.query, hit?.lat ?? null, hit?.lng ?? null, hit?.source ?? geocoderName(), hit ? null : 'no match']
      );
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      out.set(k, null);
      await query(
        `INSERT INTO geo_key_cache (kind, key, query, source, resolved_at, error) VALUES ($1, $2, $3, $4, now(), $5)
         ON CONFLICT (kind, key) DO UPDATE SET error = EXCLUDED.error, resolved_at = now()`,
        [it.kind, it.key, it.query, geocoderName(), msg]
      ).catch(() => {});
    }
  }
  return out;
}
