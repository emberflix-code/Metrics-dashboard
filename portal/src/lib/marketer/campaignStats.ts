// Campaign-level facts for a date range, attributed to location clients —
// the one query the scorecard, offer matrix and client-level alert rules
// all read. Uses meta_daily_insights level='campaign' (the rows every
// client dashboard already reads, so numbers match what each client sees)
// joined through marketer_campaign_client.is_primary.
import { query } from '@/lib/db';

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

export async function loadCampaignStats(accountIds: string[], since: string, until: string, opts: { includeUnattributed?: boolean } = {}): Promise<CampaignStat[]> {
  if (accountIds.length === 0) return [];
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
