// Server-side inputs for the insights engine, from the Meta cache only
// (meta_daily_insights, campaign level) — the coach board's insights pop-up.
// Campaign scope = the client's dashboard scope (ad_account_ids +
// campaign_filter). Leads = Meta results (the dashboard can use sheet / GHL
// leads instead; the pop-up says so). Comparison = previous period of the
// same length.
import { query } from '../db';
import { getAdminClientMetaScope, matchesCampaignFilter } from '../meta';
import type { InsightFormat, InsightInput, InsightRow } from './engine';

// Same output as DashboardClient.tsx's formatters (copied verbatim) so a
// finding reads the same in the pop-up and on the dashboard.
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DELIVERY_STYLES: Record<string, { dot: string; text: string; label: string }> = {
  ACTIVE:      { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Active' },
  PAUSED:      { dot: 'bg-slate-400',   text: 'text-slate-400',   label: 'Paused' },
  IN_PROCESS:  { dot: 'bg-blue-400 animate-pulse', text: 'text-blue-400', label: 'In Process' },
  WITH_ISSUES: { dot: 'bg-amber-400',   text: 'text-amber-400',   label: 'With Issues' },
  ARCHIVED:    { dot: 'bg-slate-600',   text: 'text-slate-500',   label: 'Archived' },
};
export const SERVER_INSIGHT_FORMAT: InsightFormat = {
  fmt: (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 }),
  fmtUsd: (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  fmtPct: (n: number) => n.toFixed(2) + '%',
  shortName: (name: string, max = 22) => (name.length > max ? name.slice(0, max - 1) + '…' : name),
  formatDateLabel: (since: string, until: string) => {
    if (!since || !until) return '';
    const [sy, sm, sd] = since.split('-').map(Number);
    const [ey, em, ed] = until.split('-').map(Number);
    if (since === until) return `${M[sm - 1]} ${sd}, ${sy}`;
    const s = `${M[sm - 1]} ${sd}`, e = `${M[em - 1]} ${ed}`;
    return sy === ey ? `${s} – ${e}, ${ey}` : `${s}, ${sy} – ${e}, ${ey}`;
  },
  esc: (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  deliveryBadge: (status: string | undefined) => {
    const s = DELIVERY_STYLES[status || ''] || { dot: 'bg-slate-500', text: 'text-slate-400', label: status || '—' };
    return `<span class="inline-flex items-center gap-1.5 ${s.text} text-xs font-medium whitespace-nowrap"><span class="w-2 h-2 rounded-full ${s.dot} flex-shrink-0"></span>${s.label}</span>`;
  },
};

const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
// Delivery labels: the dashboard shows Meta's effective_status; campaign-level
// equivalents of the ad-level ones collapse the same way.
const STATUS_MAP: Record<string, string> = { CAMPAIGN_PAUSED: 'PAUSED', ADSET_PAUSED: 'PAUSED', DELETED: 'ARCHIVED' };

export async function buildClientInsightInput(
  client: { adAccountIds: string[]; campaignFilter: string; googleDataSource: string },
  since: string, until: string,
): Promise<InsightInput> {
  const bm = await query<{ account_ids: string[] }>(`SELECT account_ids FROM agency_bm_connections`);
  const scope = await getAdminClientMetaScope(
    { ad_account_ids: client.adAccountIds, campaign_filter: client.campaignFilter, google_data_source: client.googleDataSource },
    Array.from(new Set(bm.flatMap(r => r.account_ids || []))));
  const days = daysBetween(since, until) + 1;
  const prevSince = addDays(since, -days), prevUntil = addDays(since, -1);

  const daily = scope.accountIds.length ? await query<{ account_id: string; campaign_id: string; campaign_name: string; date: string; spend: string; results: string; impressions: string; link_clicks: string }>(
    `SELECT account_id, campaign_id, campaign_name, to_char(date, 'YYYY-MM-DD') AS date, spend::text, results::text, impressions::text, link_clicks::text
     FROM meta_daily_insights WHERE account_id = ANY($1) AND level = 'campaign' AND date BETWEEN $2 AND $3`,
    [scope.accountIds, prevSince, until]) : [];
  const mine = daily.filter(r => matchesCampaignFilter(r.campaign_name || '', scope.campaignFilter, r.account_id));

  const statusRows = mine.length ? await query<{ account_id: string; entity_id: string; effective_status: string }>(
    `SELECT account_id, entity_id, effective_status FROM meta_entities WHERE level = 'campaign' AND account_id = ANY($1) AND entity_id = ANY($2)`,
    [Array.from(new Set(mine.map(r => r.account_id))), Array.from(new Set(mine.map(r => r.campaign_id)))]) : [];
  const statusOf = new Map<string, string>(statusRows.map(s => [`${s.account_id}|${s.entity_id}`, STATUS_MAP[s.effective_status] || s.effective_status]));

  const byCampaign = new Map<string, InsightRow>();
  const trend = new Map<string, { date: string; spend: number; results: number }>();
  const prev = { spent: 0, results: 0, impressions: 0, linkClicks: 0 };
  for (const r of mine) {
    const spend = Number(r.spend) || 0, results = Number(r.results) || 0, impressions = Number(r.impressions) || 0, clicks = Number(r.link_clicks) || 0;
    if (r.date < since) {
      prev.spent += spend; prev.results += results; prev.impressions += impressions; prev.linkClicks += clicks;
      continue;
    }
    const k = `${r.account_id}|${r.campaign_id}`;
    const c = byCampaign.get(k) ?? { id: k, name: r.campaign_name, status: statusOf.get(k) || '', spent: 0, results: 0, impressions: 0, linkClicks: 0, cpl: 0, ctr: 0 };
    c.spent += spend; c.results += results; c.impressions += impressions; c.linkClicks += clicks;
    byCampaign.set(k, c);
    const t = trend.get(r.date) ?? { date: r.date, spend: 0, results: 0 };
    t.spend += spend; t.results += results;
    trend.set(r.date, t);
  }
  const rows = Array.from(byCampaign.values())
    .filter(c => c.spent > 0 || c.impressions > 0)
    .map(c => ({ ...c, spent: Math.round(c.spent * 100) / 100, cpl: c.results > 0 ? c.spent / c.results : 0, ctr: c.impressions > 0 ? (c.linkClicks / c.impressions) * 100 : 0 }));

  return {
    since, until, level: 'campaign', rows,
    kpi: { spend: null, leads: null, impressions: null },
    comparison: prev.spent > 0 || prev.impressions > 0 ? { since: prevSince, until: prevUntil, totals: prev } : null,
    trend: Array.from(trend.values()).sort((a, b) => a.date.localeCompare(b.date)),
    showThemes: false, themes: null, leadsSource: 'meta', filtersOn: [],
    format: SERVER_INSIGHT_FORMAT,
  };
}
