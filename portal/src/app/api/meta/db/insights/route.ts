import { NextRequest, NextResponse } from 'next/server';
import { getClientDbScope, matchesCampaignFilter, resolveResultsFromTypeTotals, campaignOptimizationGoals } from '@/lib/meta';
import { query } from '@/lib/db';

// Every response below carries the dashboard's live campaign/spend/leads
// numbers — a stale cached copy (browser heuristic caching, or an
// intermediary proxy) silently shows outdated data with zero indication
// anything is wrong. This route reads cookies via getClientDbScope
// (already forces Next.js dynamic rendering server-side), but that alone
// doesn't stop the BROWSER from caching the fetch() response, so every
// return path sets Cache-Control explicitly rather than relying on that.
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

interface DailyInsightRow {
  entity_id: string;
  date: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_name: string;
  reach: string;
  impressions: string;
  spend: string;
  link_clicks: string;
  results: string;
  results_pixel: string;
  results_onsite: string;
  results_generic: string;
}

// DB-backed mirror of /api/meta/insights. Supports the same level/time_range/
// time_increment shape the dashboard already calls with, reading from
// meta_daily_insights instead of hitting Meta live. Two response modes:
//   - time_increment=1: one row per entity per day (trend chart)
//   - otherwise: summed into one row per entity across the whole range (main table, KPIs)
// level=account additionally collapses everything into a single summed row
// (no entity_id), matching Meta's own /insights?level=account shape.
//
// The one non-standard param this route also accepts is `filtering`, used
// only by the dashboard's ad-ID-discovery call (DashboardClient.tsx line
// ~963) to constrain by an explicit campaign.id IN [...] list — everything
// else about Meta's generic filtering syntax is intentionally NOT
// implemented here since nothing else in the app sends it.
export async function GET(req: NextRequest) {
  try {
    const { accountIds, campaignFilter } = await getClientDbScope();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    const level = sp.get('level') || 'campaign';
    const timeIncrement = sp.get('time_increment');
    let since = '', until = '';
    try {
      const range = JSON.parse(sp.get('time_range') || '{}');
      since = range.since || '';
      until = range.until || '';
    } catch { /* leave empty — query below returns nothing */ }
    if (!since || !until) return NextResponse.json({ data: [], paging: null }, NO_STORE);

    // Optional explicit campaign.id IN [...] constraint (ad-ID discovery call).
    let campaignIdIn: string[] | null = null;
    const filteringRaw = sp.get('filtering');
    if (filteringRaw) {
      try {
        const clauses = JSON.parse(filteringRaw) as { field: string; operator: string; value: unknown }[];
        const idClause = clauses.find(c => c.field === 'campaign.id' && c.operator === 'IN' && Array.isArray(c.value));
        if (idClause) campaignIdIn = (idClause.value as unknown[]).map(String);
      } catch { /* ignore malformed filtering */ }
    }

    if (level === 'account') {
      // The live route only applies a single-keyword campaign_filter at
      // level=account (insights/route.ts's `else if (nameFilter.length > 0)`
      // branch) because Meta's CONTAIN can't express OR server-side — but
      // this DB-backed route filters locally regardless, so it CAN (and
      // must) apply a multi-keyword filter here too. Skipping it for
      // multi-keyword filters was a bug: every rollup client's filter is
      // multi-keyword (pipe-delimited club list), so level=account KPI
      // totals were silently unfiltered for all of them. Always filter
      // per-campaign before summing; matchesCampaignFilter treats an empty
      // string as "match everything" so this is a no-op for unfiltered
      // clients.
{
        // Sum results_pixel/_onsite/_generic separately PER CAMPAIGN across
        // the whole range before picking a winning type, instead of summing
        // the old per-day-resolved `results` — see migration 030. A
        // campaign's nonzero action type can flip day to day; resolving
        // per-day and then summing produces a total matching neither the
        // campaign's true range-level pixel total nor its true onsite total.
        const campaignRows = await query<{ campaign_id: string; campaign_name: string; reach: string; impressions: string; spend: string; link_clicks: string; results: string; results_pixel: string; results_onsite: string; results_generic: string }>(
          `SELECT campaign_id, campaign_name, SUM(reach)::text AS reach, SUM(impressions)::text AS impressions,
                  SUM(spend)::text AS spend, SUM(link_clicks)::text AS link_clicks, SUM(results)::text AS results,
                  SUM(results_pixel)::text AS results_pixel, SUM(results_onsite)::text AS results_onsite, SUM(results_generic)::text AS results_generic
           FROM meta_daily_insights
           WHERE account_id = $1 AND level = 'campaign' AND date BETWEEN $2 AND $3
           GROUP BY campaign_id, campaign_name`,
          [accountId, since, until]
        );
        const goalByCampaignId = await campaignOptimizationGoals(accountId, campaignRows.map(r => r.campaign_id));
        const totals = { reach: 0, impressions: 0, spend: 0, linkClicks: 0, results: 0 };
        for (const r of campaignRows) {
          if (!matchesCampaignFilter(r.campaign_name || '', campaignFilter, accountId)) continue;
          totals.reach += parseInt(r.reach, 10) || 0;
          totals.impressions += parseInt(r.impressions, 10) || 0;
          totals.spend += parseFloat(r.spend) || 0;
          totals.linkClicks += parseInt(r.link_clicks, 10) || 0;
          const pixel = parseInt(r.results_pixel, 10) || 0;
          const onsite = parseInt(r.results_onsite, 10) || 0;
          const generic = parseInt(r.results_generic, 10) || 0;
          // Not-yet-backfilled rows (synced before migration 030) have all 3
          // new columns at their 0 default — fall back to the legacy
          // per-day-summed `results` rather than silently showing 0 leads
          // for a range that hasn't been re-synced yet.
          totals.results += (pixel || onsite || generic)
            ? resolveResultsFromTypeTotals(pixel, onsite, generic, goalByCampaignId.get(r.campaign_id))
            : (parseInt(r.results, 10) || 0);
        }
        // Round once at the end, not per-addition — avoids float drift into
        // artifacts like "0.9999999999999999" across however many campaigns
        // got summed.
        const roundedSpend = Math.round(totals.spend * 100) / 100;
        return NextResponse.json({
          data: [{ reach: String(totals.reach), impressions: String(totals.impressions), spend: String(roundedSpend), inline_link_clicks: String(totals.linkClicks), actions: buildActionsArray(String(totals.results)) }],
          paging: null,
        }, NO_STORE);
      }
    }

    const dbLevel = level === 'ad' ? 'ad' : level === 'adset' ? 'adset' : 'campaign';
    const rows = await query<DailyInsightRow>(
      `SELECT entity_id, date::text AS date, campaign_id, campaign_name, adset_id, adset_name, ad_name,
              reach::text AS reach, impressions::text AS impressions, spend::text AS spend,
              link_clicks::text AS link_clicks, results::text AS results,
              results_pixel::text AS results_pixel, results_onsite::text AS results_onsite, results_generic::text AS results_generic
       FROM meta_daily_insights
       WHERE account_id = $1 AND level = $2 AND date BETWEEN $3 AND $4`,
      [accountId, dbLevel, since, until]
    );

    const filtered = rows.filter(r => {
      if (!matchesCampaignFilter(r.campaign_name || '', campaignFilter, accountId)) return false;
      if (campaignIdIn && !campaignIdIn.includes(r.campaign_id)) return false;
      return true;
    });

    const idField = dbLevel === 'campaign' ? 'campaign_id' : dbLevel === 'adset' ? 'adset_id' : 'ad_id';
    const nameField = dbLevel === 'campaign' ? 'campaign_name' : dbLevel === 'adset' ? 'adset_name' : 'ad_name';

    if (timeIncrement === '1') {
      const data = filtered.map(r => ({
        [idField]: r.entity_id,
        [nameField]: dbLevel === 'ad' ? r.ad_name : (dbLevel === 'adset' ? r.adset_name : r.campaign_name),
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        adset_id: r.adset_id,
        adset_name: r.adset_name,
        ad_id: dbLevel === 'ad' ? r.entity_id : undefined,
        ad_name: r.ad_name,
        reach: r.reach,
        impressions: r.impressions,
        spend: r.spend,
        inline_link_clicks: r.link_clicks,
        actions: buildActionsArray(r.results),
        date_start: r.date,
        date_stop: r.date,
      }));
      return NextResponse.json({ data, paging: null }, NO_STORE);
    }

    // Sum across the range into one row per entity. results_pixel/_onsite/
    // _generic are summed separately and resolved to a winner ONCE per
    // entity across the whole range (not per-day then summed) — see
    // migration 030; a campaign/ad's nonzero action type can flip day to
    // day, so summing the old per-day-resolved `results` doesn't match any
    // single range-level total BM reports.
const byEntity = new Map<string, { entity: DailyInsightRow; reach: number; impressions: number; spend: number; linkClicks: number; resultsLegacy: number; resultsPixel: number; resultsOnsite: number; resultsGeneric: number }>();
    for (const r of filtered) {
      const existing = byEntity.get(r.entity_id);
      const reach = parseInt(r.reach, 10) || 0;
      const impressions = parseInt(r.impressions, 10) || 0;
      const spend = parseFloat(r.spend) || 0;
      const linkClicks = parseInt(r.link_clicks, 10) || 0;
      const resultsLegacy = parseInt(r.results, 10) || 0;
      const resultsPixel = parseInt(r.results_pixel, 10) || 0;
      const resultsOnsite = parseInt(r.results_onsite, 10) || 0;
      const resultsGeneric = parseInt(r.results_generic, 10) || 0;
      if (!existing) {
        byEntity.set(r.entity_id, { entity: r, reach, impressions, spend, linkClicks, resultsLegacy, resultsPixel, resultsOnsite, resultsGeneric });
      } else {
        existing.reach += reach;
        existing.impressions += impressions;
        existing.spend += spend;
        existing.linkClicks += linkClicks;
        existing.resultsLegacy += resultsLegacy;
        existing.resultsPixel += resultsPixel;
        existing.resultsOnsite += resultsOnsite;
        existing.resultsGeneric += resultsGeneric;
      }
    }

    // Campaign-level goal lookup, keyed by campaign_id regardless of
    // dbLevel — an adset/ad row's own campaign_id joins to the same goal
    // its parent campaign resolves with.
    const goalByCampaignId = await campaignOptimizationGoals(accountId, Array.from(byEntity.values()).map(v => v.entity.campaign_id));

    // Round spend once at the end (not per-addition) — simpler, and avoids
    // any float drift across however many rows got summed for this entity.
    const data = Array.from(byEntity.values()).map(({ entity: r, reach, impressions, spend, linkClicks, resultsLegacy, resultsPixel, resultsOnsite, resultsGeneric }) => {
      // Not-yet-backfilled rows (synced before migration 030) have all 3 new
      // columns at their 0 default — fall back to the legacy per-day-summed
      // value rather than silently showing 0 leads for an un-re-synced range.
      const results = (resultsPixel || resultsOnsite || resultsGeneric)
        ? resolveResultsFromTypeTotals(resultsPixel, resultsOnsite, resultsGeneric, goalByCampaignId.get(r.campaign_id))
        : resultsLegacy;
      return ({
      [idField]: r.entity_id,
      [nameField]: dbLevel === 'ad' ? r.ad_name : (dbLevel === 'adset' ? r.adset_name : r.campaign_name),
      campaign_id: r.campaign_id,
      campaign_name: r.campaign_name,
      adset_id: r.adset_id,
      adset_name: r.adset_name,
      ad_id: dbLevel === 'ad' ? r.entity_id : undefined,
      ad_name: r.ad_name,
      reach: String(reach),
      impressions: String(impressions),
      spend: String(Math.round(spend * 100) / 100),
      inline_link_clicks: String(linkClicks),
      actions: buildActionsArray(String(results)),
      });
    });

    return NextResponse.json({ data, paging: null }, NO_STORE);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}

// meta_daily_insights stores `results` pre-resolved (see resolveResultsFromActions
// in lib/meta.ts), but every consumer in DashboardClient.tsx expects an actions[]
// array and re-derives results from it via the same pixel-lead fallback chain.
// Synthesizing a single 'lead' action reproduces that fallback's output exactly
// (the chain falls through to the generic 'lead' key when pixel/onsite are both
// absent, which is what we store).
function buildActionsArray(results: string): { action_type: string; value: string }[] {
  return [{ action_type: 'lead', value: results }];
}
