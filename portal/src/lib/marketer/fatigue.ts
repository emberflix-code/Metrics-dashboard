// Creative fatigue detector: an asset whose CTR has slid for three
// consecutive weeks and sits well below its own best week, or whose
// frequency (impressions / reach) is high, is probably worn out. Reads
// Meta's own per-asset breakdown rows (never splits ad metrics).
import { query } from '@/lib/db';
import { loadMarketerScope } from '@/lib/marketerScope';
import { addDaysToISODate } from '@/lib/dateRange';

export const FATIGUE_WINDOW_DAYS = 28;
export const FATIGUE_MIN_SPEND = 300;
export const FATIGUE_CTR_DROP = 0.30;      // last week's CTR >= 30% below the best week
export const FATIGUE_FREQUENCY = 3.5;

export interface WeekPoint { week: string; spend: number; impressions: number; clicks: number; results: number; reach: number | null; ctr: number | null; cpl: number | null }
export interface FatigueRow {
  assetKey: string;
  type: string | null;
  thumbAccountId: string | null;
  hasBytes: boolean;
  thumbnailUrl: string | null;
  spend: number;
  results: number;
  impressions: number;
  reach: number | null;
  frequency: number | null;
  bestCtr: number | null;
  lastCtr: number | null;
  ctrDropPct: number | null;     // positive = last week below best
  weeks: WeekPoint[];
  reasons: ('ctr_decline' | 'high_frequency')[];
  activeAds: number;
  clients: string[];
}

export async function detectFatigue(f: { until: string; accountIds?: string[] }): Promise<{ range: { since: string; until: string }; rows: FatigueRow[] }> {
  const scope = await loadMarketerScope();
  const accountIds = f.accountIds?.length ? scope.accountIds.filter(a => f.accountIds!.includes(a)) : scope.accountIds;
  const since = addDaysToISODate(f.until, -(FATIGUE_WINDOW_DAYS - 1));
  if (accountIds.length === 0) return { range: { since, until: f.until }, rows: [] };

  // Week index 0..3 counted back from `until` so the last bucket always
  // ends on the range end (a calendar-week bucket would leave a partial
  // final week and a misleading "drop").
  const rows = await query<{
    asset_key: string; wk: string; spend: string; impressions: string; clicks: string; results: string; reach: string | null;
  }>(
    `SELECT b.asset_key,
            (3 - ((($3::date - b.date)::int) / 7))::text AS wk,
            SUM(b.spend)::text AS spend, SUM(b.impressions)::text AS impressions, SUM(b.link_clicks)::text AS clicks,
            SUM(b.results)::text AS results, SUM(b.reach)::text AS reach
     FROM meta_asset_breakdown_daily b
     WHERE b.account_id = ANY($1) AND b.date BETWEEN $2 AND $3
     GROUP BY 1, 2`,
    [accountIds, since, f.until]
  );

  const byAsset = new Map<string, WeekPoint[]>();
  for (const r of rows) {
    const wk = parseInt(r.wk, 10);
    if (!Number.isFinite(wk) || wk < 0 || wk > 3) continue;
    let weeks = byAsset.get(r.asset_key);
    if (!weeks) {
      weeks = [0, 1, 2, 3].map(i => ({ week: addDaysToISODate(since, i * 7), spend: 0, impressions: 0, clicks: 0, results: 0, reach: null, ctr: null, cpl: null }));
      byAsset.set(r.asset_key, weeks);
    }
    const w = weeks[wk];
    w.spend += parseFloat(r.spend) || 0;
    w.impressions += parseInt(r.impressions, 10) || 0;
    w.clicks += parseInt(r.clicks, 10) || 0;
    w.results += parseInt(r.results, 10) || 0;
    if (r.reach !== null) w.reach = (w.reach ?? 0) + (parseInt(r.reach, 10) || 0);
  }

  const flagged: { assetKey: string; row: Omit<FatigueRow, 'type' | 'thumbAccountId' | 'hasBytes' | 'thumbnailUrl' | 'activeAds' | 'clients'> }[] = [];
  for (const [assetKey, weeks] of Array.from(byAsset.entries())) {
    for (const w of weeks) { w.ctr = w.impressions > 0 ? (w.clicks / w.impressions) * 100 : null; w.cpl = w.results > 0 ? w.spend / w.results : null; }
    const spend = weeks.reduce((s, w) => s + w.spend, 0);
    if (spend < FATIGUE_MIN_SPEND) continue;
    const impressions = weeks.reduce((s, w) => s + w.impressions, 0);
    const results = weeks.reduce((s, w) => s + w.results, 0);
    const reachVals = weeks.map(w => w.reach).filter((v): v is number => v !== null);
    const reach = reachVals.length ? reachVals.reduce((a, b) => a + b, 0) : null;
    const frequency = reach && reach > 0 ? impressions / reach : null;
    const ctrs = weeks.map(w => w.ctr);
    const bestCtr = Math.max(...ctrs.filter((c): c is number => c !== null), -1);
    const lastCtr = ctrs[3];
    const reasons: FatigueRow['reasons'] = [];
    // Three consecutive declines (w1 > w2 > w3 > w4) and w4 well below best.
    if (ctrs.every(c => c !== null) && ctrs[1]! < ctrs[0]! && ctrs[2]! < ctrs[1]! && ctrs[3]! < ctrs[2]! && bestCtr > 0 && lastCtr !== null && lastCtr <= bestCtr * (1 - FATIGUE_CTR_DROP)) {
      reasons.push('ctr_decline');
    }
    if (frequency !== null && frequency > FATIGUE_FREQUENCY) reasons.push('high_frequency');
    if (reasons.length === 0) continue;
    flagged.push({
      assetKey,
      row: {
        assetKey, spend, results, impressions, reach, frequency,
        bestCtr: bestCtr >= 0 ? bestCtr : null, lastCtr,
        ctrDropPct: bestCtr > 0 && lastCtr !== null ? ((bestCtr - lastCtr) / bestCtr) * 100 : null,
        weeks, reasons,
      },
    });
  }
  if (flagged.length === 0) return { range: { since, until: f.until }, rows: [] };

  const keys = flagged.map(f => f.assetKey);
  const [assets, adInfo] = await Promise.all([
    query<{ asset_key: string; account_id: string; type: string | null; thumbnail: string | null; has_bytes: boolean }>(
      `SELECT DISTINCT ON (asset_key) asset_key, account_id, type, thumbnail, (thumbnail_bytes IS NOT NULL) AS has_bytes
       FROM meta_creative_assets WHERE account_id = ANY($1) AND asset_key = ANY($2)
       ORDER BY asset_key, (thumbnail_bytes IS NOT NULL) DESC, updated_at DESC`,
      [accountIds, keys]
    ),
    query<{ asset_key: string; active_ads: string; clients: string[] }>(
      `SELECT b.asset_key, COUNT(DISTINCT e.entity_id) FILTER (WHERE e.effective_status = 'ACTIVE')::text AS active_ads,
              array_remove(array_agg(DISTINCT c.name), NULL) AS clients
       FROM (SELECT DISTINCT account_id, asset_key, ad_id FROM meta_asset_breakdown_daily WHERE account_id = ANY($1) AND asset_key = ANY($2) AND date BETWEEN $3 AND $4) b
       LEFT JOIN meta_entities e ON e.account_id = b.account_id AND e.level = 'ad' AND e.entity_id = b.ad_id
       LEFT JOIN marketer_campaign_client m ON m.account_id = e.account_id AND m.campaign_id = e.campaign_id AND m.is_primary
       LEFT JOIN clients c ON c.id = m.client_id
       GROUP BY 1`,
      [accountIds, keys, since, f.until]
    ),
  ]);
  const assetByKey = new Map(assets.map(a => [a.asset_key, a]));
  const adByKey = new Map(adInfo.map(a => [a.asset_key, a]));

  const out: FatigueRow[] = flagged.map(({ assetKey, row }) => {
    const a = assetByKey.get(assetKey);
    const ad = adByKey.get(assetKey);
    const hasBytes = !!a?.has_bytes;
    return {
      ...row,
      type: a?.type ?? (assetKey.startsWith('video:') ? 'video' : 'image'),
      thumbAccountId: a?.account_id ?? null,
      hasBytes,
      thumbnailUrl: a ? (hasBytes ? `/api/meta/db/asset-thumbnail/${a.account_id}/${encodeURIComponent(assetKey)}` : a.thumbnail) : null,
      activeAds: ad ? parseInt(ad.active_ads, 10) || 0 : 0,
      clients: ad?.clients ?? [],
    };
  }).sort((a, b) => b.spend - a.spend);

  return { range: { since, until: f.until }, rows: out };
}
