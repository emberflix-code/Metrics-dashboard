// Coach board numbers — cache only, never a live Meta/Google call, so a big
// board stays fast and can't burn API rate limits. Meta: one SUM over
// meta_daily_insights per (account, campaign), then each client's
// campaign_filter (the Agency Overview method — correct for rollups that
// share accounts with their locations). Google: one SUM over google_ads_daily
// per (customer, campaign), then google_campaign_filter.
import { query } from '../db';
import { getAdminClientMetaScope, matchesCampaignFilter } from '../meta';
import { normalizeCustomerId } from '../googleAds';
import { addDaysToISODate, daysBetweenISO } from '../dateRange';
import type { CoachClient } from './scope';

export type MetricRow = Partial<Record<
  'spend' | 'leads' | 'cpl' | 'impressions' | 'reach' | 'link_clicks' | 'ctr' | 'g_spend' | 'g_leads' | 'g_cpl' | 'total_spend' | 'spend_delta',
  number | null
>>;

const META_KEYS = new Set(['spend', 'leads', 'cpl', 'impressions', 'reach', 'link_clicks', 'ctr', 'total_spend', 'spend_delta']);
const GOOGLE_KEYS = new Set(['g_spend', 'g_leads', 'g_cpl', 'total_spend', 'spend_delta']);

interface Sums { spend: number; results: number; impressions: number; reach: number; clicks: number; prevSpend: number }
const zero = (): Sums => ({ spend: 0, results: 0, impressions: 0, reach: 0, clicks: 0, prevSpend: 0 });
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function computeBoardMetrics(clients: CoachClient[], keys: string[], since: string, until: string): Promise<Record<string, MetricRow>> {
  const want = new Set(keys);
  const needMeta = keys.some(k => META_KEYS.has(k));
  const needGoogle = keys.some(k => GOOGLE_KEYS.has(k));
  const needPrev = want.has('spend_delta');
  // Previous period of the same length, ending the day before `since`.
  const days = daysBetweenISO(since, until) + 1;
  const prevSince = addDaysToISODate(since, -days);
  const from = needPrev ? prevSince : since;

  // ── Meta ──
  const metaByClient = new Map<string, Sums>();
  if (needMeta) {
    const bm = await query<{ account_ids: string[] }>(`SELECT account_ids FROM agency_bm_connections`);
    const agencyIds = Array.from(new Set(bm.flatMap(r => r.account_ids || [])));
    const scopes = await Promise.all(clients.map(c => getAdminClientMetaScope(
      { ad_account_ids: c.adAccountIds, campaign_filter: c.campaignFilter, google_data_source: c.googleDataSource }, agencyIds)));
    const accountIds = Array.from(new Set(scopes.flatMap(s => s.accountIds)));
    const rows = accountIds.length ? await query<{ account_id: string; campaign_name: string; spend: string; results: string; impressions: string; reach: string; clicks: string; prev_spend: string }>(
      `SELECT account_id, campaign_name,
              SUM(spend) FILTER (WHERE date >= $2)::text AS spend,
              SUM(results) FILTER (WHERE date >= $2)::text AS results,
              SUM(impressions) FILTER (WHERE date >= $2)::text AS impressions,
              SUM(reach) FILTER (WHERE date >= $2)::text AS reach,
              SUM(link_clicks) FILTER (WHERE date >= $2)::text AS clicks,
              SUM(spend) FILTER (WHERE date < $2)::text AS prev_spend
       FROM meta_daily_insights
       WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $3 AND $4
       GROUP BY account_id, campaign_name`,
      [accountIds, since, from, until]
    ) : [];
    const byAccount = new Map<string, typeof rows>();
    for (const r of rows) { const l = byAccount.get(r.account_id) || []; l.push(r); byAccount.set(r.account_id, l); }
    clients.forEach((c, i) => {
      const s = zero();
      for (const acc of scopes[i].accountIds) {
        for (const r of byAccount.get(acc) || []) {
          if (!matchesCampaignFilter(r.campaign_name || '', scopes[i].campaignFilter, acc)) continue;
          s.spend += Number(r.spend) || 0; s.results += Number(r.results) || 0; s.impressions += Number(r.impressions) || 0;
          s.reach += Number(r.reach) || 0; s.clicks += Number(r.clicks) || 0; s.prevSpend += Number(r.prev_spend) || 0;
        }
      }
      metaByClient.set(c.id, s);
    });
  }

  // ── Google (API-source clients only) ──
  const googleByClient = new Map<string, Sums>();
  const gClients = clients.filter(c => c.googleDataSource === 'api' && c.googleCustomerIds.length > 0);
  if (needGoogle && gClients.length) {
    const custIds = Array.from(new Set(gClients.flatMap(c => c.googleCustomerIds.map(normalizeCustomerId))));
    const rows = await query<{ customer_id: string; campaign_name: string; cost: string; leads: string; impressions: string; clicks: string; prev_cost: string }>(
      `SELECT d.customer_id, c.campaign_name,
              SUM(d.cost) FILTER (WHERE d.date >= $2)::text AS cost,
              SUM(d.leads) FILTER (WHERE d.date >= $2)::text AS leads,
              SUM(d.impressions) FILTER (WHERE d.date >= $2)::text AS impressions,
              SUM(d.clicks) FILTER (WHERE d.date >= $2)::text AS clicks,
              SUM(d.cost) FILTER (WHERE d.date < $2)::text AS prev_cost
       FROM google_ads_daily d JOIN google_ads_campaigns c USING (customer_id, campaign_id)
       WHERE d.customer_id = ANY($1) AND d.date BETWEEN $3 AND $4
       GROUP BY d.customer_id, c.campaign_name`,
      [custIds, since, from, until]
    );
    for (const c of gClients) {
      const s = zero();
      const mine = new Set(c.googleCustomerIds.map(normalizeCustomerId));
      for (const r of rows) {
        if (!mine.has(r.customer_id) || !matchesCampaignFilter(r.campaign_name || '', c.googleCampaignFilter, r.customer_id)) continue;
        s.spend += Number(r.cost) || 0; s.results += Number(r.leads) || 0; s.impressions += Number(r.impressions) || 0;
        s.clicks += Number(r.clicks) || 0; s.prevSpend += Number(r.prev_cost) || 0;
      }
      googleByClient.set(c.id, s);
    }
  }

  const out: Record<string, MetricRow> = {};
  for (const c of clients) {
    const m = metaByClient.get(c.id);
    const g = googleByClient.get(c.id);
    const row: MetricRow = {};
    if (m) {
      if (want.has('spend')) row.spend = r2(m.spend);
      if (want.has('leads')) row.leads = m.results;
      if (want.has('cpl')) row.cpl = m.results > 0 ? r2(m.spend / m.results) : null;
      if (want.has('impressions')) row.impressions = m.impressions;
      if (want.has('reach')) row.reach = m.reach;
      if (want.has('link_clicks')) row.link_clicks = m.clicks;
      if (want.has('ctr')) row.ctr = m.impressions > 0 ? Math.round((m.clicks / m.impressions) * 10000) / 100 : null;
    }
    if (want.has('g_spend')) row.g_spend = g ? r2(g.spend) : null;
    if (want.has('g_leads')) row.g_leads = g ? r2(g.results) : null;
    if (want.has('g_cpl')) row.g_cpl = g && g.results > 0 ? r2(g.spend / g.results) : null;
    const total = (m?.spend || 0) + (g?.spend || 0);
    const prevTotal = (m?.prevSpend || 0) + (g?.prevSpend || 0);
    if (want.has('total_spend')) row.total_spend = r2(total);
    if (want.has('spend_delta')) row.spend_delta = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : null;
    out[c.id] = row;
  }
  return out;
}

/** How far the cache goes for these clients' own accounts (the stalest one wins) — the board's "data through" chip. */
export async function cachedThrough(clients: CoachClient[]): Promise<{ meta: string | null; google: string | null }> {
  const metaIds = Array.from(new Set(clients.flatMap(c => c.adAccountIds)));
  const googleIds = Array.from(new Set(clients.filter(c => c.googleDataSource === 'api').flatMap(c => c.googleCustomerIds.map(normalizeCustomerId))));
  const [m] = metaIds.length ? await query<{ d: string | null }>(
    `SELECT MIN(last_success_until) AS d FROM agency_meta_sync_state WHERE account_id = ANY($1)`, [metaIds]) : [];
  const [g] = googleIds.length ? await query<{ d: string | null }>(
    `SELECT to_char(MIN(last_success_until), 'YYYY-MM-DD') AS d FROM google_ads_sync_state WHERE customer_id = ANY($1)`, [googleIds]) : [];
  return { meta: m?.d ?? null, google: g?.d ?? null };
}
