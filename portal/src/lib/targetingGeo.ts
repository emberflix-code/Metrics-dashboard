// Normalizes a Meta ad set `targeting` spec into flat geo rows (see
// meta_adset_geo). Pure — no I/O; coordinate resolution for keyed
// locations (cities/zips/regions) happens in lib/geocode.ts resolveGeoKeys.
//
// Meta's spec shape (geo_locations and excluded_geo_locations share it):
//   countries:        ['US']
//   regions:          [{ key:'3847', name:'Florida', country:'US' }]
//   cities:           [{ key:'2420605', name:'Tampa', region:'Florida', country:'US', radius:25, distance_unit:'mile' }]
//   zips:             [{ key:'US:33602', name:'33602', country:'US' }]
//   custom_locations: [{ latitude, longitude, radius, distance_unit, address_string, name? }]
//   places:           [{ key, name, latitude, longitude, radius, distance_unit }]
//   geo_markets:      [{ key:'DMA:539', name:'Tampa-St. Petersburg (Sarasota)' }]
//   location_types:   ['home','recent']

export type GeoKind = 'custom_location' | 'place' | 'city' | 'zip' | 'region' | 'country' | 'geo_market' | 'other';

export interface GeoRow {
  seq: number;
  kind: GeoKind;
  key: string | null;
  name: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  radiusKm: number | null;
  approx: boolean;          // true when the radius is an assumption (city/zip without an explicit radius)
  excluded: boolean;
  locationTypes: string[] | null;
}

// Radii assumed for keyed locations Meta gives no radius for. A city
// without "+N mi" targets the city polygon; 15 km is a reasonable average
// US suburb. Zip codes are small; 5 km.
export const CITY_DEFAULT_RADIUS_KM = 15;
export const ZIP_DEFAULT_RADIUS_KM = 5;
const MILE_KM = 1.609344;

function toKm(radius: unknown, unit: unknown): number | null {
  const r = Number(radius);
  if (!Number.isFinite(r) || r <= 0) return null;
  return String(unit || 'mile').toLowerCase().startsWith('kilo') ? r : r * MILE_KM;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type AnyRec = Record<string, unknown>;
function arr(v: unknown): AnyRec[] {
  return Array.isArray(v) ? (v as AnyRec[]) : [];
}
function str(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v);
}

function extractBlock(block: AnyRec | undefined, excluded: boolean, seqStart: number): GeoRow[] {
  if (!block) return [];
  const rows: GeoRow[] = [];
  let seq = seqStart;
  const locationTypes = Array.isArray(block.location_types) ? (block.location_types as string[]) : null;
  const base = { excluded, locationTypes };

  for (const c of arr(block.custom_locations)) {
    rows.push({ ...base, seq: seq++, kind: 'custom_location', key: null, name: str(c.address_string ?? c.name), region: null, country: str(c.country),
      lat: num(c.latitude), lng: num(c.longitude), radiusKm: toKm(c.radius, c.distance_unit), approx: false });
  }
  for (const p of arr(block.places)) {
    rows.push({ ...base, seq: seq++, kind: 'place', key: str(p.key), name: str(p.name), region: null, country: str(p.country),
      lat: num(p.latitude), lng: num(p.longitude), radiusKm: toKm(p.radius, p.distance_unit), approx: false });
  }
  for (const c of arr(block.cities)) {
    const explicit = toKm(c.radius, c.distance_unit);
    rows.push({ ...base, seq: seq++, kind: 'city', key: str(c.key), name: str(c.name), region: str(c.region), country: str(c.country),
      lat: null, lng: null, radiusKm: explicit ?? CITY_DEFAULT_RADIUS_KM, approx: explicit === null });
  }
  for (const z of arr(block.zips)) {
    rows.push({ ...base, seq: seq++, kind: 'zip', key: str(z.key), name: str(z.name), region: str(z.region), country: str(z.country) ?? (str(z.key)?.split(':')[0] ?? null),
      lat: null, lng: null, radiusKm: ZIP_DEFAULT_RADIUS_KM, approx: true });
  }
  for (const r of arr(block.regions)) {
    rows.push({ ...base, seq: seq++, kind: 'region', key: str(r.key), name: str(r.name), region: str(r.name), country: str(r.country),
      lat: null, lng: null, radiusKm: null, approx: false });
  }
  for (const g of arr(block.geo_markets)) {
    rows.push({ ...base, seq: seq++, kind: 'geo_market', key: str(g.key), name: str(g.name), region: null, country: str(g.country),
      lat: null, lng: null, radiusKm: null, approx: false });
  }
  for (const c of arr(block.countries)) {
    rows.push({ ...base, seq: seq++, kind: 'country', key: String(c), name: String(c), region: null, country: String(c),
      lat: null, lng: null, radiusKm: null, approx: false });
  }
  return rows;
}

export function extractGeoRows(targeting: unknown): GeoRow[] {
  if (!targeting || typeof targeting !== 'object') return [];
  const t = targeting as AnyRec;
  const inc = extractBlock(t.geo_locations as AnyRec | undefined, false, 0);
  const exc = extractBlock(t.excluded_geo_locations as AnyRec | undefined, true, inc.length);
  return [...inc, ...exc];
}

/** Query string for resolving a keyed location's coordinates (null when the kind has no point). */
export function geoKeyQuery(row: Pick<GeoRow, 'kind' | 'key' | 'name' | 'region' | 'country'>): string | null {
  const country = row.country || 'US';
  switch (row.kind) {
    case 'city': return [row.name, row.region, country].filter(Boolean).join(', ');
    case 'zip': return [row.name || row.key?.split(':').pop(), country].filter(Boolean).join(', ');
    case 'region': return [row.name, country].filter(Boolean).join(', ');
    case 'geo_market': return row.name ? `${row.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()}, ${country}` : null;
    default: return null;
  }
}

/** True when the ad set has at least one included location with a real or approximate circle. */
export function hasCircle(rows: GeoRow[]): boolean {
  return rows.some(r => !r.excluded && r.radiusKm !== null && r.lat !== null && r.lng !== null);
}

/** Summary of an ad set's non-geo targeting for display (age range, genders, count of interests). */
export function summarizeAudience(targeting: unknown): { ageMin: number | null; ageMax: number | null; genders: string; interests: number; advantageAudience: boolean } {
  const t = (targeting && typeof targeting === 'object') ? targeting as AnyRec : {};
  const genders = Array.isArray(t.genders) ? (t.genders as number[]) : [];
  let interests = 0;
  for (const spec of arr(t.flexible_spec)) for (const v of Object.values(spec)) if (Array.isArray(v)) interests += v.length;
  return {
    ageMin: num(t.age_min),
    ageMax: num(t.age_max),
    genders: genders.length === 0 ? 'All' : genders.map(g => g === 1 ? 'Men' : g === 2 ? 'Women' : String(g)).join('/'),
    interests,
    advantageAudience: !!(t.targeting_automation as AnyRec | undefined)?.advantage_audience,
  };
}
