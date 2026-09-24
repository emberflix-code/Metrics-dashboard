// Campaign-level facts for a date range, attributed to location clients —
// the one query the scorecard, offer matrix and client-level alert rules
// all read. Uses meta_daily_insights level='campaign' (the rows every
// client dashboard already reads, so numbers match what each client sees)
// joined through marketer_campaign_client.is_primary.
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { resolveResultsFromActions } from '@/lib/meta';
import { getResultsRules, resultsUnderRule } from '@/lib/metaSync';

export interface CampaignStat {
  clientId: string | null;     // null = no primary client matched (unattributed)
  accountId: string;
  campaignId: string;
  campaignName: string;
  status: string | null;
  offer: string;
  spend: number;
  results: number;
  impressions: number;
  clicks: number;
  reach: number;
}

export function cplOf(spend: number, results: number): number | null {
  return results > 0 ? spend / results : null;
}
export function ctrOf(clicks: number, impressions: number): number | null {
  return impressions > 0 ? (clicks / impressions) * 100 : null;
}

export async function loadCampaignStats(accountIds: string[], since: string, until: string, opts: { includeUnattributed?: boolean; live?: boolean } = {}): Promise<CampaignStat[]> {
  if (accountIds.length === 0) return [];
  if (opts.live) return loadCampaignStatsLive(accountIds, since, until, opts);
  const rows = await query<{
    client_id: string | null; account_id: string; campaign_id: string; campaign_name: string | null; status: string | null; offer: string;
    spend: string; results: string; impressions: string; clicks: string; reach: string;
  }>(
    `WITH facts AS (
       SELECT d.account_id, d.entity_id AS campaign_id,
              SUM(d.spend)::text AS spend, SUM(d.results)::text AS results, SUM(d.impressions)::text AS impressions,
              SUM(d.link_clicks)::text AS clicks, SUM(d.reach)::text AS reach
       FROM meta_daily_insights d
       WHERE d.level = 'campaign' AND d.account_id = ANY($1) AND d.date BETWEEN $2 AND $3
       GROUP BY 1, 2
     )
     SELECT m.client_id, f.account_id, f.campaign_id, e.name AS campaign_name, e.effective_status AS status,
            COALESCE(o.offer, e.offer_token, 'Unknown') AS offer,
            f.spend, f.results, f.impressions, f.clicks, f.reach
     FROM facts f
     LEFT JOIN meta_entities e ON e.account_id = f.account_id AND e.level = 'campaign' AND e.entity_id = f.campaign_id
     LEFT JOIN campaign_offer_overrides o ON o.account_id = f.account_id AND o.campaign_id = f.campaign_id
     LEFT JOIN marketer_campaign_client m ON m.account_id = f.account_id AND m.campaign_id = f.campaign_id AND m.is_primary
     ${opts.includeUnattributed ? '' : 'WHERE m.client_id IS NOT NULL'}`,
    [accountIds, since, until]
  );
  return rows.map(r => ({
    clientId: r.client_id,
    accountId: r.account_id,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name || '',
    status: r.status,
    offer: r.offer || 'Unknown',
    spend: parseFloat(r.spend) || 0,
    results: parseInt(r.results, 10) || 0,
    impressions: parseInt(r.impressions, 10) || 0,
    clicks: parseInt(r.clicks, 10) || 0,
    reach: parseInt(r.reach, 10) || 0,
  }));
}

// ── Live mode ────────────────────────────────────────────────────────────
// For short ranges ("this week") the cache can lag a day behind Meta. Live
// mode asks Meta for one campaign-level row per campaign with delivery in
// the range (no time_increment, so a handful of pages per account even on
// Omega) and joins it to the cached entity/attribution tables for status,
// offer and client. Same results rules as the sync so numbers agree with
// the cached view once the cache catches up. Cached 2 minutes per
// (accounts, range).
const GRAPH = 'https://graph.facebook.com/v22.0';
const LIVE_TTL_MS = 2 * 60_000;
const LIVE_MAX_RANGE_DAYS = 31;
const _liveCache = new Map<string, { expires: number; rows: CampaignStat[] }>();

interface LiveRow { campaign_id?: string; campaign_name?: string; spend?: string; impressions?: string; inline_link_clicks?: string; reach?: string; actions?: { action_type: string; value: string }[] }

async function fetchLiveCampaignRows(accountId: string, token: string, since: string, until: string): Promise<LiveRow[]> {
  const out: LiveRow[] = [];
  const u = new URL(`${GRAPH}/act_${accountId}/insights`);
  u.searchParams.set('level', 'campaign');
  u.searchParams.set('fields', 'campaign_id,campaign_name,spend,impressions,inline_link_clicks,reach,actions');
  u.searchParams.set('time_range', JSON.stringify({ since, until }));
  u.searchParams.set('limit', '500');
  u.searchParams.set('action_attribution_windows', '["7d_click","1d_view","1d_ev"]');
  u.searchParams.set('access_token', token);
  let next: string | null = u.toString();
  let pages = 0;
  while (next && pages++ < 40) {
    const res = await fetch(next, { signal: AbortSignal.timeout(30_000) });
    const json = await res.json() as { data?: LiveRow[]; paging?: { next?: string }; error?: { message?: string; code?: number } };
    if (json.error) throw new Error(`Meta ${json.error.code ?? ''}: ${json.error.message ?? 'error'}`);
    out.push(...(json.data ?? []));
    next = json.paging?.next ?? null;
  }
  return out;
}

export function liveRangeAllowed(since: string, until: string): boolean {
  const d = (Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(d) && d >= 0 && d <= LIVE_MAX_RANGE_DAYS;
}

export async function loadCampaignStatsLive(accountIds: string[], since: string, until: string, opts: { includeUnattributed?: boolean } = {}): Promise<CampaignStat[]> {
  if (!liveRangeAllowed(since, until)) throw new Error(`Live mode is limited to ranges of ${LIVE_MAX_RANGE_DAYS} days or less`);
  const key = `${[...accountIds].sort().join(',')}|${since}|${until}`;
  const hit = _liveCache.get(key);
  let rows: CampaignStat[];
  if (hit && hit.expires > Date.now()) {
    rows = hit.rows;
  } else {
    const conns = await query<{ token_enc: string; account_ids: string[] }>(`SELECT token_enc, account_ids FROM agency_bm_connections`);
    const tokenFor = (acct: string) => { const c = conns.find(x => (x.account_ids || []).includes(acct)); return c ? decrypt(c.token_enc) : null; };

    const perAccount = await Promise.all(accountIds.map(async acct => {
      const token = tokenFor(acct);
      if (!token) return { acct, rows: [] as LiveRow[], error: 'no token' };
      try {
        return { acct, rows: await fetchLiveCampaignRows(acct, token, since, until), error: null as string | null };
      } catch (err) {
        console.error('[MARKETER-LIVE]', JSON.stringify({ acct, error: err instanceof Error ? err.message : String(err) }));
        return { acct, rows: [] as LiveRow[], error: err instanceof Error ? err.message : String(err) };
      }
    }));

    // Status / offer / attribution from the cached tables (entities sync daily).
    const meta = await query<{ account_id: string; campaign_id: string; status: string | null; offer: string; client_id: string | null }>(
      `SELECT e.account_id, e.entity_id AS campaign_id, e.effective_status AS status,
              COALESCE(o.offer, e.offer_token, 'Unknown') AS offer, m.client_id
       FROM meta_entities e
       LEFT JOIN campaign_offer_overrides o ON o.account_id = e.account_id AND o.campaign_id = e.entity_id
       LEFT JOIN marketer_campaign_client m ON m.account_id = e.account_id AND m.campaign_id = e.entity_id AND m.is_primary
       WHERE e.level = 'campaign' AND e.account_id = ANY($1)`,
      [accountIds]
    );
    const metaByKey = new Map(meta.map(m => [`${m.account_id}:${m.campaign_id}`, m]));

    rows = [];
    for (const { acct, rows: liveRows } of perAccount) {
      const rules = await getResultsRules(acct);
      for (const r of liveRows) {
        if (!r.campaign_id) continue;
        const m = metaByKey.get(`${acct}:${r.campaign_id}`);
        const campaignName = r.campaign_name || '';
        const results = rules
          ? resultsUnderRule(r.actions, rules.byCampaign.get(r.campaign_id) || 'lead')
          : resolveResultsFromActions(r.actions, campaignName);
        rows.push({
          clientId: m?.client_id ?? null,
          accountId: acct,
          campaignId: r.campaign_id,
          campaignName,
          status: m?.status ?? null,
          offer: m?.offer ?? 'Unknown',
          spend: parseFloat(r.spend || '0') || 0,
          results,
          impressions: parseInt(r.impressions || '0', 10) || 0,
          clicks: parseInt(r.inline_link_clicks || '0', 10) || 0,
          reach: parseInt(r.reach || '0', 10) || 0,
        });
      }
    }
    _liveCache.set(key, { expires: Date.now() + LIVE_TTL_MS, rows });
    if (_liveCache.size > 50) _liveCache.delete(_liveCache.keys().next().value as string);
  }
  return opts.includeUnattributed ? rows : rows.filter(r => r.clientId !== null);
}

/** Median of a numeric list (null when empty). */
export function median(values: number[]): number | null {
  const v = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export interface Totals { spend: number; results: number; impressions: number; clicks: number; reach: number }
export const emptyTotals = (): Totals => ({ spend: 0, results: 0, impressions: 0, clicks: 0, reach: 0 });
export function addTotals(t: Totals, s: Pick<CampaignStat, 'spend' | 'results' | 'impressions' | 'clicks' | 'reach'>): void {
  t.spend += s.spend; t.results += s.results; t.impressions += s.impressions; t.clicks += s.clicks; t.reach += s.reach;
}
