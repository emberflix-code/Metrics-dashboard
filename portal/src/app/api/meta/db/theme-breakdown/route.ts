import { NextRequest, NextResponse } from 'next/server';
import { getClientDbScope, matchesCampaignFilter } from '@/lib/meta';
import { query } from '@/lib/db';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

const THEME_LABELS: Record<string, string> = {
  strength: 'Strength',
  tread: 'Tread',
  'non-active': 'Non-Active',
  'strength+tread': 'Strength + Tread',
};
const THEME_ORDER = ['strength', 'tread', 'non-active', 'strength+tread'];

interface Row {
  spend: number; impressions: number; linkClicks: number; results: number;
}
function emptyRow(): Row {
  return { spend: 0, impressions: 0, linkClicks: 0, results: 0 };
}
function addInto(target: Row, spend: number, impressions: number, linkClicks: number, results: number) {
  target.spend += spend;
  target.impressions += impressions;
  target.linkClicks += linkClicks;
  target.results += results;
}

// Theme/UGC creative-performance breakdown, across EVERY ad account this
// client can see (unlike the per-account Creatives v2/v3 routes) — this
// table sums BY CATEGORY, not by individual card, so a creative tagged the
// same theme on two different accounts (a real, common case for a
// cross-account-tagging rollup client like Anytime Fitness Corporate)
// correctly contributes its own distinct spend from each account under
// that one category. No cross-account creative dedup is needed here,
// unlike the Creatives tabs, which must avoid double-counting one physical
// creative's spend into two separate CARDS.
//
// Reach is summed per day per entity, same as everywhere else in this
// dashboard — a known imprecision (Meta's reach is a deduplicated
// unique-user count, not additive across days), left as-is here
// deliberately rather than introduce a second, inconsistent Reach
// convention just for this table (see feedback memory on this).
//
// Bookings/CPB/Joins/CPJ are NOT computed — Meta's per-creative breakdown
// has no concept of a Booking or a Join; those exist only as CLIENT-LEVEL
// totals from the separate sheet-KPI feature, with no path back to which
// individual creative drove one. Confirmed against the user's own KPI
// sheet (Account tab, 2026-09-11): Joins are reported per Campaign
// Type/Audience/Landing Page, never per creative. The client returns
// bookings/cpb/joins/cpj as null so the UI can render an honest "—"
// instead of a fabricated number.
export async function GET(req: NextRequest) {
  try {
    const { accountIds, campaignFilter } = await getClientDbScope();
    const sp = req.nextUrl.searchParams;

    let since = '', until = '';
    try {
      const range = JSON.parse(sp.get('time_range') || '{}');
      since = range.since || '';
      until = range.until || '';
    } catch { /* empty range below returns nothing */ }
    if (!since || !until) {
      return NextResponse.json({ byTheme: [], byUgc: [] }, NO_STORE);
    }

    const byTheme = new Map<string, Row>();
    const byUgc = new Map<string, Row>();
    for (const key of THEME_ORDER) byTheme.set(key, emptyRow());
    byUgc.set('ugc', emptyRow());
    byUgc.set('non-ugc', emptyRow());

    for (const accountId of accountIds) {
      // Ads whose campaign matches this client's filter — same scoping
      // every other DB-backed route applies.
      const scopedAdRows = await query<{ entity_id: string; campaign_name: string }>(
        `SELECT entity_id, campaign_name FROM meta_entities WHERE account_id = $1 AND level = 'ad'`,
        [accountId]
      );
      const allowedAdIds = new Set(
        scopedAdRows.filter(r => matchesCampaignFilter(r.campaign_name || '', campaignFilter, accountId)).map(r => r.entity_id)
      );
      if (allowedAdIds.size === 0) continue;

      const rows = await query<{ asset_key: string; theme: string | null; ugc_status: string | null; spend: string; impressions: string; link_clicks: string; results: string }>(
        `SELECT b.asset_key, a.theme, a.ugc_status,
                SUM(b.spend)::text AS spend, SUM(b.impressions)::text AS impressions,
                SUM(b.link_clicks)::text AS link_clicks, SUM(b.results)::text AS results
         FROM meta_asset_breakdown_daily b
         JOIN meta_creative_assets a ON a.account_id = b.account_id AND a.asset_key = b.asset_key
         WHERE b.account_id = $1 AND b.date BETWEEN $2 AND $3 AND b.ad_id = ANY($4)
         GROUP BY b.asset_key, a.theme, a.ugc_status`,
        [accountId, since, until, Array.from(allowedAdIds)]
      );

      for (const r of rows) {
        const spend = parseFloat(r.spend) || 0;
        const impressions = parseInt(r.impressions, 10) || 0;
        const linkClicks = parseInt(r.link_clicks, 10) || 0;
        const results = parseInt(r.results, 10) || 0;

        if (r.theme && byTheme.has(r.theme)) {
          addInto(byTheme.get(r.theme)!, spend, impressions, linkClicks, results);
        }
        const ugcKey = r.ugc_status === 'ugc' ? 'ugc' : r.ugc_status === 'non-ugc' ? 'non-ugc' : null;
        if (ugcKey) {
          addInto(byUgc.get(ugcKey)!, spend, impressions, linkClicks, results);
        }
      }
    }

    const toOutput = (key: string, label: string, r: Row) => {
      const ctr = r.impressions > 0 ? Math.round((r.linkClicks / r.impressions) * 10000) / 100 : 0;
      const cpl = r.results > 0 ? Math.round((r.spend / r.results) * 100) / 100 : null;
      return {
        key, label,
        spend: Math.round(r.spend * 100) / 100,
        // Not tracked per-creative anywhere (meta_asset_breakdown_daily
        // has no reach column — Reach only ever exists at the campaign/
        // account level in this app) — null renders as "—", not a
        // fabricated 0 that could misread as "this theme has zero reach."
        reach: null,
        impressions: r.impressions,
        linkClicks: r.linkClicks,
        ctr,
        leads: r.results,
        cpl,
        bookings: null, cpb: null, joins: null, cpj: null,
      };
    };

    const themeOut = THEME_ORDER.map(key => toOutput(key, THEME_LABELS[key], byTheme.get(key)!));
    const ugcOut = [
      toOutput('non-ugc', 'Non-UGC', byUgc.get('non-ugc')!),
      toOutput('ugc', 'UGC', byUgc.get('ugc')!),
    ];

    return NextResponse.json({ byTheme: themeOut, byUgc: ugcOut }, NO_STORE);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
