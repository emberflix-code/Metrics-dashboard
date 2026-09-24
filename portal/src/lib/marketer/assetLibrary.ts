// Server-only read model for the marketer cross-account asset library
// (/marketer/assets). One asset = one creative (image/video by Meta
// asset_key) or one copy variant (body/title/description by text hash),
// aggregated across every ad, campaign, client and ad account that used it.
//
// Every number here comes from Meta's OWN per-asset rows:
//   creatives  -> meta_asset_breakdown_daily (image_asset/video_asset
//                 breakdowns, one row per asset x ad x day)
//   copy (DCO) -> meta_copy_breakdown_daily (body/title/description_asset
//                 breakdowns)
//   copy (static ads) -> the ad's own meta_daily_insights row, because a
//                 static ad has exactly one body/title/description so the
//                 ad's metrics ARE that variant's metrics.
// We never divide an ad's totals across the assets it contains — that would
// fabricate per-asset results (see project memory "BM breakdown per
// creatives results").
import { query } from '@/lib/db';
import { loadMarketerScope, type MarketerScope } from '@/lib/marketerScope';
import type { CopyKind } from '@/lib/adCopy';

export type AssetKind = 'creative' | 'body' | 'title' | 'description';
export type AssetSort = 'spend' | 'results' | 'cpl' | 'ctr' | 'cpm' | 'impressions' | 'reach' | 'adCount' | 'clientCount';

export interface AssetLibraryQuery {
  kind: AssetKind;
  since: string;
  until: string;
  sort: AssetSort;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  offers?: string[];
  clientIds?: string[];
  brand?: string;
  accountIds?: string[];
  q?: string;
  minSpend?: number;
  type?: 'image' | 'video';
  theme?: string;
  ugc?: string;
  onlyActive?: boolean;
}

export interface AssetLibraryRow {
  key: string;
  kind: AssetKind;
  type: string | null;
  thumbAccountId: string | null;
  hasBytes: boolean;
  thumbnailUrl: string | null;
  text: string | null;
  theme: string | null;
  ugcStatus: string | null;
  spend: number;
  impressions: number;
  reach: number | null;
  linkClicks: number;
  results: number;
  cpl: number | null;
  ctr: number | null;
  cpm: number | null;
  adCount: number;
  campaignCount: number;
  clientCount: number;
  accountIds: string[];
  offers: string[];
  firstDate: string;
  lastDate: string;
  activeAdCount: number;
  isStaticOnly?: boolean;
}

export interface AssetLibraryResult {
  rows: AssetLibraryRow[];
  total: number;
  totals: { spend: number; results: number; impressions: number };
}

export interface AssetDetail {
  row: AssetLibraryRow;
  byCampaign: { accountId: string; campaignId: string; campaignName: string; clientName: string | null; offer: string; spend: number; results: number; cpl: number | null }[];
  byClient: { clientId: string; clientName: string; spend: number; results: number; cpl: number | null }[];
  byOffer: { offer: string; spend: number; results: number; cpl: number | null }[];
  weekly: { week: string; spend: number; results: number; cpl: number | null; ctr: number | null; impressions: number; reach: number | null }[];
  ads: { accountId: string; adId: string; adName: string; campaignName: string; status: string; spend: number; results: number }[];
  pairedCopy?: { kind: CopyKind; text: string; hash: string; adCount: number }[];
  pairedCreatives?: { assetKey: string; type: string | null; thumbAccountId: string; hasBytes: boolean; thumbnailUrl: string | null; adCount: number }[];
  linkUrls?: string[];
  ctaTypes?: string[];
}

// ── helpers ──────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const round2 = (n: number): number => Math.round(n * 100) / 100;

function derive(spend: number, results: number, impressions: number, clicks: number) {
  return {
    cpl: results > 0 ? round2(spend / results) : null,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    cpm: impressions > 0 ? round2((spend / impressions) * 1000) : null,
  };
}

export function thumbnailUrlFor(assetKey: string, thumbAccountId: string | null, hasBytes: boolean, metaUrl: string | null): string | null {
  if (hasBytes && thumbAccountId) return `/api/meta/db/asset-thumbnail/${encodeURIComponent(thumbAccountId)}/${encodeURIComponent(assetKey)}`;
  return metaUrl || null;
}

/** Small positional-parameter builder so long CTE strings stay readable. */
class Params {
  values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}

const COPY_KINDS: CopyKind[] = ['body', 'title', 'description'];
const isCopyKind = (k: AssetKind): k is CopyKind => (COPY_KINDS as string[]).includes(k);

// kind -> meta_ad_copy column names. `kind` is validated against AssetKind
// before it ever reaches SQL, so these are the only strings interpolated.
const PRIMARY_HASH_COL: Record<CopyKind, string> = { body: 'primary_body_hash', title: 'primary_title_hash', description: 'primary_description_hash' };
const VARIANTS_COL: Record<CopyKind, string> = { body: 'bodies', title: 'titles', description: 'descriptions' };

// Whitelisted ORDER BY targets — the only place user-selected sort keys
// touch the SQL string.
const SORT_COLS: Record<AssetSort, string> = {
  spend: 'spend', results: 'results', cpl: 'cpl', ctr: 'ctr', cpm: 'cpm',
  impressions: 'impressions', reach: 'reach', adCount: 'ad_count', clientCount: 'client_count',
};

// ── scope resolution ─────────────────────────────────────────────────────

interface ResolvedScope {
  scope: MarketerScope;
  accountIds: string[];
  /** null = no client filter; [] = filter that matches nothing */
  clientFilter: string[] | null;
}

async function resolveScope(q: Pick<AssetLibraryQuery, 'accountIds' | 'clientIds' | 'brand'>): Promise<ResolvedScope> {
  const scope = await loadMarketerScope();
  let accountIds = scope.accountIds;
  if (q.accountIds && q.accountIds.length > 0) {
    const want = new Set(q.accountIds.map(a => a.replace(/^act_/i, '')));
    accountIds = accountIds.filter(a => want.has(a));
  }

  // Brand = the set of scoped clients whose name prefix matches; combined
  // with an explicit client list by intersection so both filters narrow.
  let clientFilter: string[] | null = null;
  if (q.clientIds && q.clientIds.length > 0) clientFilter = Array.from(new Set(q.clientIds));
  if (q.brand) {
    const brandIds = scope.clients.filter(c => c.brand === q.brand).map(c => c.id);
    clientFilter = clientFilter ? clientFilter.filter(id => brandIds.includes(id)) : brandIds;
  }
  return { scope, accountIds, clientFilter };
}

// Every ad in scope with its campaign-derived attributes. Offer precedence
// is manual override > parsed campaign token > 'Unknown'; client is the
// campaign's primary (most specific non-rollup) attribution. Offer/client
// filters are applied here so every downstream aggregate is already narrowed.
//
// Breakdown facts LEFT JOIN this CTE: an ad whose meta_entities row is
// missing (archived/deleted before an entity sync, or a stale local
// snapshot) still has real spend that must not vanish. `acct` is the
// account-array placeholder so those facts stay limited to scoped accounts,
// and `filtered` tells the caller to require a match (s.ad_id IS NOT NULL)
// when the user set an offer/client/brand filter — an unmatched row can't
// satisfy a filter, and a matched-but-filtered-out ad must not sneak back in
// as an "Unknown" row.
interface ScopedAds { sql: string; acct: string; filtered: boolean }

function scopedAdsCte(p: Params, accountIds: string[], offers: string[] | undefined, clientFilter: string[] | null): ScopedAds {
  const acct = p.add(accountIds);
  const hasOffers = !!offers && offers.length > 0;
  const offerCond = hasOffers ? `AND COALESCE(o.offer, c.offer_token, 'Unknown') = ANY(${p.add(offers)}::text[])` : '';
  const clientCond = clientFilter ? `AND m.client_id::text = ANY(${p.add(clientFilter)}::text[])` : '';
  const sql = `scoped_ads AS (
    SELECT e.account_id,
           e.entity_id AS ad_id,
           e.name AS ad_name,
           COALESCE(e.campaign_id, '') AS campaign_id,
           COALESCE(c.name, e.campaign_name, '') AS campaign_name,
           COALESCE(o.offer, c.offer_token, 'Unknown') AS offer,
           m.client_id::text AS client_id,
           e.effective_status AS ad_status
    FROM meta_entities e
    LEFT JOIN meta_entities c ON c.account_id = e.account_id AND c.level = 'campaign' AND c.entity_id = e.campaign_id
    LEFT JOIN campaign_offer_overrides o ON o.account_id = e.account_id AND o.campaign_id = e.campaign_id
    LEFT JOIN marketer_campaign_client m ON m.account_id = e.account_id AND m.campaign_id = e.campaign_id AND m.is_primary
    WHERE e.level = 'ad' AND e.account_id = ANY(${acct}::text[]) ${offerCond} ${clientCond}
  )`;
  return { sql, acct, filtered: hasOffers || clientFilter !== null };
}

// Columns a breakdown fact takes from its (possibly missing) scoped ad.
// Unmatched rows fall back to the breakdown table's own campaign_name,
// offer 'Unknown', no client, no status; campaign_id stays NULL so
// COUNT(DISTINCT campaign_id) doesn't count a phantom campaign.
const factAdCols = (alias: string) => `
             s.campaign_id,
             COALESCE(s.campaign_name, NULLIF(${alias}.campaign_name, ''), '') AS campaign_name,
             COALESCE(s.ad_name, '(not synced)') AS ad_name,
             s.client_id,
             COALESCE(s.offer, 'Unknown') AS offer,
             s.ad_status`;

// Shared SELECT list for the per-key aggregate: same shape for creatives and
// copy so the outer ORDER BY / derived-metric code is identical. Sums stay
// numeric (node-pg returns NUMERIC/BIGINT as strings anyway) so the outer
// ORDER BY compares numbers, not text.
const AGG_COLS = `
    SUM(f.spend) AS spend,
    SUM(f.impressions) AS impressions,
    SUM(f.link_clicks) AS link_clicks,
    SUM(f.results) AS results,
    SUM(f.reach) AS reach,
    CASE WHEN SUM(f.results) > 0 THEN (SUM(f.spend) / SUM(f.results))::float8 END AS cpl,
    CASE WHEN SUM(f.impressions) > 0 THEN (SUM(f.link_clicks)::float8 / SUM(f.impressions) * 100) END AS ctr,
    CASE WHEN SUM(f.impressions) > 0 THEN (SUM(f.spend) / SUM(f.impressions) * 1000)::float8 END AS cpm,
    COUNT(DISTINCT f.ad_id)::int AS ad_count,
    COUNT(DISTINCT COALESCE(f.campaign_id, f.campaign_name))::int AS campaign_count,
    COUNT(DISTINCT f.client_id)::int AS client_count,
    array_remove(array_agg(DISTINCT f.offer), NULL) AS offers,
    array_agg(DISTINCT f.account_id) AS account_ids,
    MIN(f.date)::text AS first_date,
    MAX(f.date)::text AS last_date,
    COUNT(DISTINCT f.ad_id) FILTER (WHERE f.ad_status = 'ACTIVE')::int AS active_ad_count`;

interface AggDbRow {
  key: string; spend: string; impressions: string; link_clicks: string; results: string; reach: string | null;
  cpl: number | null; ctr: number | null; cpm: number | null;
  ad_count: number; campaign_count: number; client_count: number; offers: string[]; account_ids: string[];
  first_date: string; last_date: string; active_ad_count: number;
  // creative-only
  type?: string | null; theme?: string | null; ugc_status?: string | null; thumbnail?: string | null; thumb_account_id?: string | null; has_bytes?: boolean | null;
  // copy-only
  text?: string | null; static_only?: boolean | null;
  // paging/totals
  total?: string; total_spend?: string; total_results?: string; total_impressions?: string;
}

function rowFromDb(kind: AssetKind, r: AggDbRow): AssetLibraryRow {
  const spend = round2(num(r.spend));
  const impressions = num(r.impressions);
  const linkClicks = num(r.link_clicks);
  const results = num(r.results);
  const d = derive(spend, results, impressions, linkClicks);
  const isCreative = kind === 'creative';
  const thumbAccountId = isCreative ? (r.thumb_account_id ?? null) : null;
  const hasBytes = isCreative ? !!r.has_bytes : false;
  return {
    key: r.key,
    kind,
    type: isCreative ? (r.type ?? r.key.split(':')[0] ?? null) : null,
    thumbAccountId,
    hasBytes,
    thumbnailUrl: isCreative ? thumbnailUrlFor(r.key, thumbAccountId, hasBytes, r.thumbnail ?? null) : null,
    text: isCreative ? null : (r.text ?? null),
    theme: isCreative ? (r.theme ?? null) : null,
    ugcStatus: isCreative ? (r.ugc_status ?? null) : null,
    spend,
    impressions,
    reach: numOrNull(r.reach),
    linkClicks,
    results,
    cpl: d.cpl,
    ctr: d.ctr,
    cpm: d.cpm,
    adCount: num(r.ad_count),
    campaignCount: num(r.campaign_count),
    clientCount: num(r.client_count),
    accountIds: r.account_ids || [],
    offers: r.offers || [],
    firstDate: r.first_date,
    lastDate: r.last_date,
    activeAdCount: num(r.active_ad_count),
    ...(isCreative ? {} : { isStaticOnly: !!r.static_only }),
  };
}

// ── list query ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const CACHE_CAP = 200;
const cache = new Map<string, { at: number; value: AssetLibraryResult }>();

/** Drops every cached page — call after a tag write or a sync so the next read is fresh. */
export function invalidateAssetLibraryCache(): void {
  cache.clear();
}

function cacheGet(key: string): AssetLibraryResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key: string, value: AssetLibraryResult): void {
  // Map preserves insertion order, so the first key is the oldest entry.
  while (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

const EMPTY: AssetLibraryResult = { rows: [], total: 0, totals: { spend: 0, results: 0, impressions: 0 } };

export async function queryAssetLibrary(q: AssetLibraryQuery): Promise<AssetLibraryResult> {
  const cacheKey = JSON.stringify(q);
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { accountIds, clientFilter } = await resolveScope(q);
  if (accountIds.length === 0 || (clientFilter && clientFilter.length === 0)) return EMPTY;

  const p = new Params();
  const since = p.add(q.since);
  const until = p.add(q.until);
  const minSpend = p.add(Math.max(0, q.minSpend ?? 0));
  const { sql: scoped, acct, filtered } = scopedAdsCte(p, accountIds, q.offers, clientFilter);
  const requireMatch = filtered ? `AND s.ad_id IS NOT NULL` : '';

  const outerConds: string[] = [];
  if (q.onlyActive) outerConds.push(`a.active_ad_count > 0`);

  let body: string;
  if (q.kind === 'creative') {
    // Best metadata row per asset among the accounts it ran in: prefer one
    // with stored thumbnail bytes (never expires), then one that's been
    // tagged, then the most recently touched.
    if (q.type) outerConds.push(`COALESCE(a.type, split_part(a.key, ':', 1)) = ${p.add(q.type)}`);
    if (q.theme) outerConds.push(`a.theme = ${p.add(q.theme)}`);
    if (q.ugc) outerConds.push(`a.ugc_status = ${p.add(q.ugc)}`);
    if (q.q && q.q.trim()) {
      // Campaign/ad names come from meta_entities via scoped_ads, not the
      // breakdown table's own campaign_name column — that one is a later
      // last-write-wins addition and is blank for rows synced before it.
      const like = p.add(`%${q.q.trim()}%`);
      outerConds.push(`(a.key ILIKE ${like} OR EXISTS (
        SELECT 1 FROM facts f WHERE f.key = a.key AND (f.campaign_name ILIKE ${like} OR f.ad_name ILIKE ${like})))`);
    }
    body = `${scoped},
    facts AS (
      SELECT b.asset_key AS key, b.account_id, b.ad_id, b.date, b.spend, b.impressions, b.link_clicks, b.results, b.reach,
             ${factAdCols('b')}
      FROM meta_asset_breakdown_daily b
      LEFT JOIN scoped_ads s ON s.account_id = b.account_id AND s.ad_id = b.ad_id
      WHERE b.account_id = ANY(${acct}::text[]) AND b.date BETWEEN ${since}::date AND ${until}::date ${requireMatch}
    ),
    agg AS (
      SELECT f.key, ${AGG_COLS}
      FROM facts f
      GROUP BY f.key
      HAVING SUM(f.spend) >= ${minSpend}
    ),
    enriched AS (
      SELECT g.*, ca.type, ca.theme, ca.ugc_status, ca.thumbnail, ca.account_id AS thumb_account_id, ca.has_bytes
      FROM agg g
      LEFT JOIN LATERAL (
        SELECT x.account_id, x.type, x.theme, x.ugc_status, x.thumbnail, (x.thumbnail_bytes IS NOT NULL) AS has_bytes
        FROM meta_creative_assets x
        WHERE x.asset_key = g.key AND x.account_id = ANY(g.account_ids)
        ORDER BY (x.thumbnail_bytes IS NOT NULL) DESC, (x.theme IS NOT NULL) DESC, x.updated_at DESC
        LIMIT 1
      ) ca ON true
    )`;
  } else {
    const kind = q.kind;
    if (!isCopyKind(kind)) return EMPTY;
    const kindP = p.add(kind);
    if (q.q && q.q.trim()) outerConds.push(`a.text ILIKE ${p.add(`%${q.q.trim()}%`)}`);
    // Branch A: Meta's per-variant breakdown rows (DCO ads), LEFT JOINed so
    // an ad missing from meta_entities keeps its spend. Branch B: static
    // ads, where the single variant's metrics are the ad's own daily row —
    // inner join is fine there because it already requires a meta_ad_copy
    // row, which only exists for synced ads. Guarded so an ad with
    // breakdown rows is never counted twice.
    body = `${scoped},
    facts AS (
      SELECT cb.text_hash AS key, cb.account_id, cb.ad_id, cb.date, cb.spend, cb.impressions, cb.link_clicks, cb.results, cb.reach,
             ${factAdCols('cb')}, false AS is_static
      FROM meta_copy_breakdown_daily cb
      LEFT JOIN scoped_ads s ON s.account_id = cb.account_id AND s.ad_id = cb.ad_id
      WHERE cb.account_id = ANY(${acct}::text[]) AND cb.kind = ${kindP} AND cb.date BETWEEN ${since}::date AND ${until}::date ${requireMatch}
      UNION ALL
      SELECT mc.${PRIMARY_HASH_COL[kind]} AS key, d.account_id, d.entity_id AS ad_id, d.date, d.spend, d.impressions, d.link_clicks, d.results, d.reach,
             s.campaign_id, s.campaign_name, s.ad_name, s.client_id, s.offer, s.ad_status, true AS is_static
      FROM meta_daily_insights d
      JOIN meta_ad_copy mc ON mc.account_id = d.account_id AND mc.ad_id = d.entity_id AND NOT mc.is_dco
      JOIN scoped_ads s ON s.account_id = d.account_id AND s.ad_id = d.entity_id
      WHERE d.level = 'ad' AND d.date BETWEEN ${since}::date AND ${until}::date
        AND mc.${PRIMARY_HASH_COL[kind]} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM meta_copy_breakdown_daily x WHERE x.account_id = d.account_id AND x.ad_id = d.entity_id AND x.kind = ${kindP})
    ),
    agg AS (
      SELECT f.key, ${AGG_COLS}, bool_and(f.is_static) AS static_only
      FROM facts f
      GROUP BY f.key
      HAVING SUM(f.spend) >= ${minSpend}
    ),
    enriched AS (
      SELECT g.*, t.text
      FROM agg g
      LEFT JOIN meta_copy_texts t ON t.kind = ${kindP} AND t.text_hash = g.key
    )`;
  }

  const sortCol = SORT_COLS[q.sort] ?? 'spend';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const where = outerConds.length > 0 ? `WHERE ${outerConds.join(' AND ')}` : '';
  const pageSize = Math.max(1, Math.min(5000, q.pageSize));
  const offset = Math.max(0, (Math.max(1, q.page) - 1) * pageSize);

  // Totals are window sums over the FILTERED set (pre-pagination) so the
  // strip above the table always describes exactly what's being paged.
  const sql = `WITH ${body}
    SELECT a.*,
           COUNT(*) OVER() AS total,
           SUM(a.spend) OVER() AS total_spend,
           SUM(a.results) OVER() AS total_results,
           SUM(a.impressions) OVER() AS total_impressions
    FROM enriched a
    ${where}
    ORDER BY a.${sortCol} ${dir} NULLS LAST, a.key ASC
    LIMIT ${p.add(pageSize)} OFFSET ${p.add(offset)}`;

  const dbRows = await query<AggDbRow>(sql, p.values);
  const result: AssetLibraryResult = {
    rows: dbRows.map(r => rowFromDb(q.kind, r)),
    total: dbRows.length > 0 ? num(dbRows[0].total) : 0,
    totals: dbRows.length > 0
      ? { spend: round2(num(dbRows[0].total_spend)), results: num(dbRows[0].total_results), impressions: num(dbRows[0].total_impressions) }
      : { spend: 0, results: 0, impressions: 0 },
  };
  cacheSet(cacheKey, result);
  return result;
}

// ── URL params -> query ──────────────────────────────────────────────────

export const ASSET_KINDS: AssetKind[] = ['creative', 'body', 'title', 'description'];
export const ASSET_SORTS: AssetSort[] = ['spend', 'results', 'cpl', 'ctr', 'cpm', 'impressions', 'reach', 'adCount', 'clientCount'];
const THEMES = ['non-active', 'strength', 'tread', 'strength+tread'];
const UGC = ['ugc', 'non-ugc'];

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;
const readParam = (src: ParamSource, name: string): string | undefined => {
  if (src instanceof URLSearchParams) return src.get(name) ?? undefined;
  const v = src[name];
  return Array.isArray(v) ? v[0] : v;
};
const csv = (v: string | undefined): string[] | undefined => {
  const parts = (v || '').split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? Array.from(new Set(parts)) : undefined;
};

/**
 * Shared by the list/export API routes and the server page so a URL means
 * the same thing everywhere. Unknown enum values fall back to defaults
 * rather than erroring — a stale bookmarked URL should still load.
 */
export function parseAssetLibraryParams(src: ParamSource, range: { since: string; until: string }, opts?: { pageSize?: number }): AssetLibraryQuery {
  const kindRaw = readParam(src, 'kind') as AssetKind | undefined;
  const kind: AssetKind = kindRaw && ASSET_KINDS.includes(kindRaw) ? kindRaw : 'creative';
  const sortRaw = readParam(src, 'sort') as AssetSort | undefined;
  const sort: AssetSort = sortRaw && ASSET_SORTS.includes(sortRaw) ? sortRaw : 'spend';
  const dirRaw = readParam(src, 'dir');
  // CPL reads best ascending (cheapest first); everything else descending.
  const dir: 'asc' | 'desc' = dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : (sort === 'cpl' ? 'asc' : 'desc');
  const page = Math.max(1, parseInt(readParam(src, 'page') || '1', 10) || 1);
  const pageSizeRaw = parseInt(readParam(src, 'pageSize') || '', 10);
  const pageSize = opts?.pageSize ?? (Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(200, pageSizeRaw) : 50);
  const minSpendRaw = parseFloat(readParam(src, 'minSpend') || '0');
  const typeRaw = readParam(src, 'type');
  const themeRaw = readParam(src, 'theme');
  const ugcRaw = readParam(src, 'ugc');
  const brand = (readParam(src, 'brand') || '').trim() || undefined;
  const q = (readParam(src, 'q') || '').trim() || undefined;
  const onlyActiveRaw = readParam(src, 'onlyActive');

  return {
    kind, since: range.since, until: range.until, sort, dir, page, pageSize,
    offers: csv(readParam(src, 'offer')),
    clientIds: csv(readParam(src, 'client')),
    brand,
    accountIds: csv(readParam(src, 'account')),
    q,
    minSpend: Number.isFinite(minSpendRaw) && minSpendRaw > 0 ? minSpendRaw : 0,
    type: typeRaw === 'image' || typeRaw === 'video' ? typeRaw : undefined,
    theme: kind === 'creative' && themeRaw && THEMES.includes(themeRaw) ? themeRaw : undefined,
    ugc: kind === 'creative' && ugcRaw && UGC.includes(ugcRaw) ? ugcRaw : undefined,
    onlyActive: onlyActiveRaw === '1' || onlyActiveRaw === 'true',
  };
}

// ── offers (filter options) ──────────────────────────────────────────────

/** Same aggregation as /api/marketer/offers, for the page's filter dropdown. */
export async function listOffers(accountIds: string[]): Promise<{ token: string; campaignCount: number; clientCount: number }[]> {
  if (accountIds.length === 0) return [];
  const rows = await query<{ offer: string; campaign_count: string; client_count: string }>(
    `SELECT COALESCE(o.offer, e.offer_token, 'Unknown') AS offer,
            COUNT(*)::text AS campaign_count,
            COUNT(DISTINCT m.client_id)::text AS client_count
     FROM meta_entities e
     LEFT JOIN campaign_offer_overrides o ON o.account_id = e.account_id AND o.campaign_id = e.entity_id
     LEFT JOIN marketer_campaign_client m ON m.account_id = e.account_id AND m.campaign_id = e.entity_id AND m.is_primary
     WHERE e.level = 'campaign' AND e.account_id = ANY($1)
     GROUP BY 1
     ORDER BY COUNT(*) DESC, 1 ASC`,
    [accountIds]
  );
  return rows.map(r => ({ token: r.offer, campaignCount: Number(r.campaign_count), clientCount: Number(r.client_count) }));
}

// ── detail ───────────────────────────────────────────────────────────────

interface DetailFacts {
  /** `WITH scoped_ads AS (...), facts AS (...)` — facts has one row per (ad, day) for this one asset. */
  cte: string;
  p: Params;
}

// The facts CTE for a single asset, same sources as the list query so the
// drawer's totals always reconcile with the table row that opened it.
function detailFactsCte(kind: AssetKind, key: string, since: string, until: string, accountIds: string[]): DetailFacts {
  const p = new Params();
  const sinceP = p.add(since);
  const untilP = p.add(until);
  const { sql: scoped, acct } = scopedAdsCte(p, accountIds, undefined, null);
  const keyP = p.add(key);
  // Static branch reads straight from the matched scoped ad (inner join).
  const staticCols = `s.campaign_id, s.campaign_name, s.ad_name, s.client_id, s.offer, s.ad_status`;
  let facts: string;
  if (kind === 'creative') {
    facts = `facts AS (
      SELECT b.account_id, b.ad_id, b.date, b.spend, b.impressions, b.link_clicks, b.results, b.reach, ${factAdCols('b')}, false AS is_static
      FROM meta_asset_breakdown_daily b
      LEFT JOIN scoped_ads s ON s.account_id = b.account_id AND s.ad_id = b.ad_id
      WHERE b.account_id = ANY(${acct}::text[]) AND b.asset_key = ${keyP} AND b.date BETWEEN ${sinceP}::date AND ${untilP}::date
    )`;
  } else {
    const kindP = p.add(kind);
    const col = PRIMARY_HASH_COL[kind];
    facts = `facts AS (
      SELECT cb.account_id, cb.ad_id, cb.date, cb.spend, cb.impressions, cb.link_clicks, cb.results, cb.reach, ${factAdCols('cb')}, false AS is_static
      FROM meta_copy_breakdown_daily cb
      LEFT JOIN scoped_ads s ON s.account_id = cb.account_id AND s.ad_id = cb.ad_id
      WHERE cb.account_id = ANY(${acct}::text[]) AND cb.kind = ${kindP} AND cb.text_hash = ${keyP} AND cb.date BETWEEN ${sinceP}::date AND ${untilP}::date
      UNION ALL
      SELECT d.account_id, d.entity_id AS ad_id, d.date, d.spend, d.impressions, d.link_clicks, d.results, d.reach, ${staticCols}, true AS is_static
      FROM meta_daily_insights d
      JOIN meta_ad_copy mc ON mc.account_id = d.account_id AND mc.ad_id = d.entity_id AND NOT mc.is_dco AND mc.${col} = ${keyP}
      JOIN scoped_ads s ON s.account_id = d.account_id AND s.ad_id = d.entity_id
      WHERE d.level = 'ad' AND d.date BETWEEN ${sinceP}::date AND ${untilP}::date
        AND NOT EXISTS (SELECT 1 FROM meta_copy_breakdown_daily x WHERE x.account_id = d.account_id AND x.ad_id = d.entity_id AND x.kind = ${kindP})
    )`;
  }
  return { cte: `WITH ${scoped}, ${facts}`, p };
}

interface GroupDbRow { spend: string; results: string; impressions?: string; link_clicks?: string; reach?: string | null; [k: string]: unknown }

const groupMetrics = (r: GroupDbRow) => {
  const spend = round2(num(r.spend));
  const results = num(r.results);
  return { spend, results, cpl: results > 0 ? round2(spend / results) : null };
};

export async function getAssetDetail(kind: AssetKind, key: string, since: string, until: string): Promise<AssetDetail | null> {
  if (kind !== 'creative' && !isCopyKind(kind)) return null;
  const { scope, accountIds } = await resolveScope({});
  if (accountIds.length === 0) return null;

  const { cte, p } = detailFactsCte(kind, key, since, until, accountIds);
  const params = p.values;

  // One aggregate for the header row (same column shape as the list query).
  // HAVING without GROUP BY collapses to zero rows when nothing matched,
  // which is the "not found" signal.
  const [summaryDb] = await query<Omit<AggDbRow, 'key'>>(
    `${cte}
     SELECT ${AGG_COLS}, bool_and(f.is_static) AS static_only
     FROM facts f
     HAVING COUNT(*) > 0`,
    params
  );
  if (!summaryDb) return null;
  const summary: AggDbRow = { ...summaryDb, key };

  const [byCampaignRows, byClientRows, byOfferRows, weeklyRows, adRows] = await Promise.all([
    // Unmatched (not-synced) ads have no campaign_id, so they group by the
    // breakdown row's campaign name instead; matched ads group by id.
    query<GroupDbRow & { account_id: string; campaign_id: string | null; campaign_name: string; client_id: string | null; offer: string }>(
      `${cte}
       SELECT f.account_id, f.campaign_id, MAX(f.campaign_name) AS campaign_name, MAX(f.client_id) AS client_id, MAX(f.offer) AS offer,
              SUM(f.spend)::text AS spend, SUM(f.results)::text AS results
       FROM facts f
       GROUP BY f.account_id, f.campaign_id, CASE WHEN f.campaign_id IS NULL THEN f.campaign_name END
       ORDER BY SUM(f.spend) DESC LIMIT 200`,
      params
    ),
    query<GroupDbRow & { client_id: string | null }>(
      `${cte}
       SELECT f.client_id, SUM(f.spend)::text AS spend, SUM(f.results)::text AS results
       FROM facts f GROUP BY f.client_id ORDER BY SUM(f.spend) DESC LIMIT 200`,
      params
    ),
    query<GroupDbRow & { offer: string }>(
      `${cte}
       SELECT f.offer, SUM(f.spend)::text AS spend, SUM(f.results)::text AS results
       FROM facts f GROUP BY f.offer ORDER BY SUM(f.spend) DESC`,
      params
    ),
    query<GroupDbRow & { week: string }>(
      `${cte}
       SELECT date_trunc('week', f.date)::date::text AS week,
              SUM(f.spend)::text AS spend, SUM(f.results)::text AS results, SUM(f.impressions)::text AS impressions,
              SUM(f.link_clicks)::text AS link_clicks, SUM(f.reach)::text AS reach
       FROM facts f GROUP BY 1 ORDER BY 1 ASC`,
      params
    ),
    query<GroupDbRow & { account_id: string; ad_id: string; ad_name: string; campaign_name: string; ad_status: string }>(
      `${cte}
       SELECT f.account_id, f.ad_id, MAX(f.ad_name) AS ad_name, MAX(f.campaign_name) AS campaign_name, MAX(f.ad_status) AS ad_status,
              SUM(f.spend)::text AS spend, SUM(f.results)::text AS results
       FROM facts f GROUP BY f.account_id, f.ad_id ORDER BY SUM(f.spend) DESC LIMIT 200`,
      params
    ),
  ]);

  const clientName = (id: string | null): string | null => (id ? scope.clientById.get(id)?.name ?? null : null);
  const assetAccountIds: string[] = summary.account_ids || [];

  const detail: AssetDetail = {
    row: rowFromDb(kind, summary),
    byCampaign: byCampaignRows.map(r => ({
      accountId: r.account_id, campaignId: r.campaign_id || '', campaignName: r.campaign_name || '', clientName: clientName(r.client_id), offer: r.offer || 'Unknown', ...groupMetrics(r),
    })),
    byClient: byClientRows.map(r => ({
      clientId: r.client_id || '', clientName: clientName(r.client_id) ?? (r.client_id ? r.client_id : 'Unattributed'), ...groupMetrics(r),
    })),
    byOffer: byOfferRows.map(r => ({ offer: r.offer || 'Unknown', ...groupMetrics(r) })),
    weekly: weeklyRows.map(r => {
      const spend = round2(num(r.spend));
      const results = num(r.results);
      const impressions = num(r.impressions);
      const clicks = num(r.link_clicks);
      return { week: r.week, spend, results, cpl: results > 0 ? round2(spend / results) : null, ctr: impressions > 0 ? (clicks / impressions) * 100 : null, impressions, reach: numOrNull(r.reach) };
    }),
    ads: adRows.map(r => ({
      accountId: r.account_id, adId: r.ad_id, adName: r.ad_name || '', campaignName: r.campaign_name || '', status: r.ad_status || 'UNKNOWN', spend: round2(num(r.spend)), results: num(r.results),
    })),
  };

  if (kind === 'creative') {
    // Header-row metadata (type/tags/thumbnail) — same "best row" choice as
    // the list query's LATERAL so the drawer shows the same preview.
    const [meta] = await query<{ account_id: string; type: string | null; theme: string | null; ugc_status: string | null; thumbnail: string | null; has_bytes: boolean }>(
      `SELECT x.account_id, x.type, x.theme, x.ugc_status, x.thumbnail, (x.thumbnail_bytes IS NOT NULL) AS has_bytes
       FROM meta_creative_assets x
       WHERE x.asset_key = $1 AND x.account_id = ANY($2)
       ORDER BY (x.thumbnail_bytes IS NOT NULL) DESC, (x.theme IS NOT NULL) DESC, x.updated_at DESC
       LIMIT 1`,
      [key, assetAccountIds.length > 0 ? assetAccountIds : accountIds]
    );
    if (meta) {
      detail.row = rowFromDb(kind, { ...summary, type: meta.type, theme: meta.theme, ugc_status: meta.ugc_status, thumbnail: meta.thumbnail, thumb_account_id: meta.account_id, has_bytes: meta.has_bytes });
    }

    // Copy that ran alongside this creative: every ad mapped to the asset,
    // flattened across its body/title/description variants with how many of
    // those ads carried each variant.
    const copyRows = await query<{ bodies: { text: string; hash: string }[]; titles: { text: string; hash: string }[]; descriptions: { text: string; hash: string }[]; link_urls: string[]; cta_types: string[] }>(
      `SELECT mc.bodies, mc.titles, mc.descriptions, mc.link_urls, mc.cta_types
       FROM meta_creative_asset_ad_map am
       JOIN meta_ad_copy mc ON mc.account_id = am.account_id AND mc.ad_id = am.ad_id
       WHERE am.asset_key = $1 AND am.account_id = ANY($2)
       LIMIT 2000`,
      [key, assetAccountIds.length > 0 ? assetAccountIds : accountIds]
    );
    const paired = new Map<string, { kind: CopyKind; text: string; hash: string; adCount: number }>();
    const links = new Set<string>();
    const ctas = new Set<string>();
    for (const r of copyRows) {
      const groups: [CopyKind, { text: string; hash: string }[]][] = [['body', r.bodies || []], ['title', r.titles || []], ['description', r.descriptions || []]];
      for (const [k, variants] of groups) {
        for (const v of variants) {
          if (!v?.hash) continue;
          const id = `${k}:${v.hash}`;
          const cur = paired.get(id);
          if (cur) cur.adCount += 1; else paired.set(id, { kind: k, text: v.text || '', hash: v.hash, adCount: 1 });
        }
      }
      for (const u of r.link_urls || []) if (typeof u === 'string' && u) links.add(u);
      for (const c of r.cta_types || []) if (c) ctas.add(c);
    }
    detail.pairedCopy = Array.from(paired.values()).sort((a, b) => b.adCount - a.adCount).slice(0, 60);
    detail.linkUrls = Array.from(links).slice(0, 50);
    detail.ctaTypes = Array.from(ctas);
  } else {
    // Creatives that ran alongside this copy: ads whose copy JSONB contains
    // the hash (DCO) or whose primary hash is it (static), via the ad map.
    const col = VARIANTS_COL[kind];
    const hashCol = PRIMARY_HASH_COL[kind];
    const matchAd = `(mc.${hashCol} = $2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(mc.${col}) v WHERE v->>'hash' = $2))`;
    const [creativeRows, copyMeta] = await Promise.all([
      query<{ asset_key: string; thumb_account_id: string; type: string | null; thumbnail: string | null; has_bytes: boolean; ad_count: number }>(
        `SELECT am.asset_key,
                (array_agg(ca.account_id ORDER BY (ca.thumbnail_bytes IS NOT NULL) DESC, ca.updated_at DESC))[1] AS thumb_account_id,
                (array_agg(ca.type ORDER BY (ca.thumbnail_bytes IS NOT NULL) DESC, ca.updated_at DESC))[1] AS type,
                (array_agg(ca.thumbnail ORDER BY (ca.thumbnail_bytes IS NOT NULL) DESC, ca.updated_at DESC))[1] AS thumbnail,
                bool_or(ca.thumbnail_bytes IS NOT NULL) AS has_bytes,
                COUNT(DISTINCT mc.ad_id)::int AS ad_count
         FROM meta_ad_copy mc
         JOIN meta_creative_asset_ad_map am ON am.account_id = mc.account_id AND am.ad_id = mc.ad_id
         JOIN meta_creative_assets ca ON ca.account_id = am.account_id AND ca.asset_key = am.asset_key
         WHERE mc.account_id = ANY($1) AND ${matchAd}
         GROUP BY am.asset_key
         ORDER BY COUNT(DISTINCT mc.ad_id) DESC
         LIMIT 60`,
        [accountIds, key]
      ),
      query<{ link_urls: string[]; cta_types: string[] }>(
        `SELECT mc.link_urls, mc.cta_types FROM meta_ad_copy mc WHERE mc.account_id = ANY($1) AND ${matchAd} LIMIT 2000`,
        [accountIds, key]
      ),
    ]);
    detail.pairedCreatives = creativeRows.map(r => ({
      assetKey: r.asset_key, type: r.type, thumbAccountId: r.thumb_account_id, hasBytes: !!r.has_bytes,
      thumbnailUrl: thumbnailUrlFor(r.asset_key, r.thumb_account_id, !!r.has_bytes, r.thumbnail), adCount: num(r.ad_count),
    }));
    const links = new Set<string>();
    const ctas = new Set<string>();
    for (const r of copyMeta) {
      for (const u of r.link_urls || []) if (typeof u === 'string' && u) links.add(u);
      for (const c of r.cta_types || []) if (c) ctas.add(c);
    }
    detail.linkUrls = Array.from(links).slice(0, 50);
    detail.ctaTypes = Array.from(ctas);
  }

  return detail;
}
