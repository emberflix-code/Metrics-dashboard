import { NextRequest, NextResponse } from 'next/server';
import { getClientDbScope, matchesCampaignFilter, isMultiKeywordFilter } from '@/lib/meta';
import { query } from '@/lib/db';

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
    if (!since || !until) return NextResponse.json({ data: [], paging: null });

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
      // The live route DOES apply a single-keyword campaign_filter at
      // level=account (insights/route.ts's `else if (nameFilter.length > 0)`
      // branch) — only multi-keyword filters go unscoped there, since Meta's
      // CONTAIN can't express OR. Match that exactly: sum from unfiltered
      // per-campaign rows only when the filter is multi-keyword or absent;
      // otherwise filter per-campaign rows before summing.
      if (campaignFilter && !isMultiKeywordFilter(campaignFilter)) {
        const campaignRows = await query<{ campaign_name: string; reach: string; impressions: string; spend: string; link_clicks: string; results: string }>(
          `SELECT campaign_name, SUM(reach)::text AS reach, SUM(impressions)::text AS impressions,
                  SUM(spend)::text AS spend, SUM(link_clicks)::text AS link_clicks, SUM(results)::text AS results
           FROM meta_daily_insights
           WHERE account_id = $1 AND level = 'campaign' AND date BETWEEN $2 AND $3
           GROUP BY campaign_name`,
          [accountId, since, until]
        );
        const totals = { reach: 0, impressions: 0, spend: 0, linkClicks: 0, results: 0 };
        for (const r of campaignRows) {
          if (!matchesCampaignFilter(r.campaign_name || '', campaignFilter)) continue;
          totals.reach += parseInt(r.reach, 10) || 0;
          totals.impressions += parseInt(r.impressions, 10) || 0;
          totals.spend += parseFloat(r.spend) || 0;
          totals.linkClicks += parseInt(r.link_clicks, 10) || 0;
          totals.results += parseInt(r.results, 10) || 0;
        }
        // Round once at the end, not per-addition — matches the other
        // summing branch below in effect (rounding after every add and
        // rounding once at the end converge to the same cent-accurate
        // value; only accumulating with NO rounding at all, as this branch
        // did before, can drift into artifacts like "0.9999999999999999").
        const roundedSpend = Math.round(totals.spend * 100) / 100;
        return NextResponse.json({
          data: [{ reach: String(totals.reach), impressions: String(totals.impressions), spend: String(roundedSpend), inline_link_clicks: String(totals.linkClicks), actions: buildActionsArray(String(totals.results)) }],
          paging: null,
        });
      }

      const rows = await query<{ reach: string; impressions: string; spend: string; link_clicks: string; results: string }>(
        `SELECT COALESCE(SUM(reach),0)::text AS reach, COALESCE(SUM(impressions),0)::text AS impressions,
                COALESCE(SUM(spend),0)::text AS spend, COALESCE(SUM(link_clicks),0)::text AS link_clicks,
                COALESCE(SUM(results),0)::text AS results
         FROM meta_daily_insights
         WHERE account_id = $1 AND level = 'campaign' AND date BETWEEN $2 AND $3`,
        [accountId, since, until]
      );
      const r = rows[0];
      return NextResponse.json({
        data: [{ reach: r?.reach ?? '0', impressions: r?.impressions ?? '0', spend: r?.spend ?? '0', inline_link_clicks: r?.link_clicks ?? '0', actions: buildActionsArray(r?.results ?? '0') }],
        paging: null,
      });
    }

    const dbLevel = level === 'ad' ? 'ad' : level === 'adset' ? 'adset' : 'campaign';
    const rows = await query<DailyInsightRow>(
      `SELECT entity_id, date::text AS date, campaign_id, campaign_name, adset_id, adset_name, ad_name,
              reach::text AS reach, impressions::text AS impressions, spend::text AS spend,
              link_clicks::text AS link_clicks, results::text AS results
       FROM meta_daily_insights
       WHERE account_id = $1 AND level = $2 AND date BETWEEN $3 AND $4`,
      [accountId, dbLevel, since, until]
    );

    const filtered = rows.filter(r => {
      if (!matchesCampaignFilter(r.campaign_name || '', campaignFilter)) return false;
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
      return NextResponse.json({ data, paging: null });
    }

    // Sum across the range into one row per entity.
    const byEntity = new Map<string, { entity: DailyInsightRow; reach: number; impressions: number; spend: number; linkClicks: number; results: number }>();
    for (const r of filtered) {
      const existing = byEntity.get(r.entity_id);
      const reach = parseInt(r.reach, 10) || 0;
      const impressions = parseInt(r.impressions, 10) || 0;
      const spend = parseFloat(r.spend) || 0;
      const linkClicks = parseInt(r.link_clicks, 10) || 0;
      const results = parseInt(r.results, 10) || 0;
      if (!existing) {
        byEntity.set(r.entity_id, { entity: r, reach, impressions, spend, linkClicks, results });
      } else {
        existing.reach += reach;
        existing.impressions += impressions;
        existing.spend += spend;
        existing.linkClicks += linkClicks;
        existing.results += results;
      }
    }

    // Round spend once at the end (not per-addition) — simpler, and avoids
    // any float drift across however many rows got summed for this entity.
    const data = Array.from(byEntity.values()).map(({ entity: r, reach, impressions, spend, linkClicks, results }) => ({
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
    }));

    return NextResponse.json({ data, paging: null });
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
