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

const COUNTRY_NAME: Record<string, string> = { US: 'United States', CA: 'Canada' };

/**
 * Geocodes a postal code for a country (Meta zip keys look like "US:33602").
 * US zips resolve fine as free text. Canadian forward sortation areas
 * ("V3V") do NOT — free text finds nothing and Nominatim's structured
 * postalcode search returned wrong cities (H9A → Toronto instead of
 * Montreal, checked 2026-09-24) — so callers pass a city-level `query`
 * taken from Meta's own adgeolocationmeta ("Surrey, British Columbia,
 * Canada") for anything non-US, and this only handles the postal string.
 */
export async function geocodePostalCode(code: string, countryCode: string): Promise<GeocodeResult | null> {
  const cc = (countryCode || 'US').toUpperCase();
  const c = code.trim().toUpperCase();
  if (!c) return null;
  if (GOOGLE_KEY()) return geocodeGoogle(`${c}, ${COUNTRY_NAME[cc] || cc}`);
  if (cc !== 'US') return null;
  return geocodeNominatim(`${c}, ${COUNTRY_NAME[cc] || cc}`);
}

/** Geocodes one free-text address/place string exactly as given. Null when nothing matched; throws on provider errors. */
export async function geocodeAddress(q: string): Promise<GeocodeResult | null> {
  const s = q.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return GOOGLE_KEY() ? geocodeGoogle(s) : geocodeNominatim(s);
}

// Nominatim rejects most US strip-mall addresses verbatim ("8333 Greenway
// Blvd Suite 140, Middleton, WI 53562" -> no match; 46 of 84 clubs failed on
// the first prod run, 2026-09-24). Progressively simpler variants, most
// precise first; the variant that matched is recorded in geocode_source so
// an approximate pin is visible as such.
export function addressVariants(raw: string): { query: string; precision: 'exact' | 'no-suite' | 'street' | 'locality' }[] {
  let s = raw.replace(/\s+/g, ' ').trim();
  // Trailing notes after the postal code ("…, Canada. In behind Bo's").
  s = s.replace(/,?\s*(United States|USA|Canada)\b.*$/i, '');
  const out: { query: string; precision: 'exact' | 'no-suite' | 'street' | 'locality' }[] = [{ query: s, precision: 'exact' }];
  // Suite / unit / store / building tokens, anywhere (incl. a "Unit 200 "
  // prefix before the street number) and "#123" fragments.
  const noSuite = s
    .replace(/^(unit|suite|ste|#)\s*[\w-]+\s+/i, '')
    .replace(/,?\s*\b(suite|ste\.?|unit|apt|bldg|building|store|rm|room)\b\.?\s*#?\s*[\w-]+(\s+(unit|ste|suite)\s*[\w-]+)?/gi, '')
    .replace(/\s*#\s*[\w-]+/g, '')
    .replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim();
  if (noSuite !== s) out.push({ query: noSuite, precision: 'no-suite' });
  // Street without the house number ("Greenway Blvd, Middleton, WI 53562").
  const street = noSuite.replace(/^\d+[\w-]*\s+/, '');
  if (street !== noSuite && street.includes(',')) out.push({ query: street, precision: 'street' });
  // Locality only: everything after the first comma.
  const locality = noSuite.includes(',') ? noSuite.slice(noSuite.indexOf(',') + 1).trim() : '';
  if (locality && locality !== street) out.push({ query: locality, precision: 'locality' });
  return out;
}

/** Tries geocodeAddress over addressVariants(); returns the first hit with its precision tier. */
export async function geocodeAddressLenient(raw: string): Promise<(GeocodeResult & { tier: 'exact' | 'no-suite' | 'street' | 'locality'; query: string }) | null> {
  for (const v of addressVariants(raw)) {
    const hit = await geocodeAddress(v.query);
    if (hit) return { ...hit, tier: v.precision, query: v.query };
  }
  return null;
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
      const hit = await geocodeAddressLenient(r.location_address);
      if (!hit) {
        skipped++;
        await query(`UPDATE clients SET geocode_query = $2, geocode_error = 'no match', geocoded_at = now() WHERE id = $1`, [r.id, r.location_address]);
        continue;
      }
      // geocode_source records provider + the variant tier that matched
      // (exact / no-suite / street / locality) so the map can flag
      // approximate pins.
      await query(
        `UPDATE clients SET location_lat = $2, location_lng = $3, geocode_source = $4, geocode_query = $5, geocode_error = NULL, geocoded_at = now() WHERE id = $1`,
        [r.id, hit.lat, hit.lng, `${hit.source}:${hit.tier}${hit.precision ? `:${hit.precision}` : ''}`, r.location_address]
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
// A cached miss is retried after this long (the resolver improves over
// time — e.g. Canadian postal prefixes failed until the structured lookup
// existed — and OSM data changes).
const GEO_KEY_RETRY_MS = 24 * 3600_000;

export async function resolveGeoKeys(items: { kind: string; key: string; query: string }[]): Promise<Map<string, { lat: number; lng: number } | null>> {
  const out = new Map<string, { lat: number; lng: number } | null>();
  const uniq = new Map<string, { kind: string; key: string; query: string }>();
  for (const it of items) if (it.key && it.query) uniq.set(`${it.kind}:${it.key}`, it);
  if (uniq.size === 0) return out;

  const kinds = Array.from(uniq.values()).map(i => i.kind);
  const keys = Array.from(uniq.values()).map(i => i.key);
  const cached = await query<{ kind: string; key: string; lat: number | null; lng: number | null; error: string | null; resolved_at: string | null }>(
    `SELECT c.kind, c.key, c.lat, c.lng, c.error, c.resolved_at::text
     FROM geo_key_cache c
     JOIN unnest($1::text[], $2::text[]) AS t(kind, key) ON t.kind = c.kind AND t.key = c.key`,
    [kinds, keys]
  );
  for (const c of cached) {
    const hasCoords = c.lat !== null && c.lng !== null;
    const stale = !hasCoords && (!c.resolved_at || Date.now() - Date.parse(c.resolved_at) > GEO_KEY_RETRY_MS);
    if (stale) continue; // fall through to a fresh attempt below
    out.set(`${c.kind}:${c.key}`, hasCoords ? { lat: Number(c.lat), lng: Number(c.lng) } : null);
  }

  for (const [k, it] of Array.from(uniq.entries())) {
    if (out.has(k)) continue;
    try {
      // Meta zip keys are "<CC>:<code>". US zips go through the postal
      // resolver; everything else uses the caller's city-level query
      // (from Meta's adgeolocationmeta) since postal prefixes don't geocode.
      const zipMatch = it.kind === 'zip' ? it.key.match(/^([A-Z]{2}):(.+)$/i) : null;
      let hit: GeocodeResult | null = null;
      if (zipMatch && zipMatch[1].toUpperCase() === 'US') hit = await geocodePostalCode(zipMatch[2], 'US');
      if (!hit && it.query && !/^[A-Z0-9]{3,10}, [A-Z]{2}$/i.test(it.query)) hit = await geocodeAddress(it.query);
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
