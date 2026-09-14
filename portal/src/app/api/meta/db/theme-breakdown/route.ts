import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getClientDbScope, matchesCampaignFilter } from '@/lib/meta';
import { query } from '@/lib/db';
import { fetchMetaKpiSheetRows } from '@/lib/metaKpiSheet';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

const THEME_LABELS: Record<string, string> = {
  strength: 'Strength',
  tread: 'Tread',
  'non-active': 'Non-Active',
  'strength+tread': 'Strength + Tread',
};
const THEME_ORDER = ['strength', 'tread', 'non-active', 'strength+tread'];

interface Row {
  spend: number; impressions: number; linkClicks: number; results: number; reach: number; hasReach: boolean;
  bookings: number; joins: number; hasBookingsData: boolean;
}
function emptyRow(): Row {
  return { spend: 0, impressions: 0, linkClicks: 0, results: 0, reach: 0, hasReach: false, bookings: 0, joins: 0, hasBookingsData: false };
}
function addInto(target: Row, spend: number, impressions: number, linkClicks: number, results: number, reach: number | null) {
  target.spend += spend;
  target.impressions += impressions;
  target.linkClicks += linkClicks;
  target.results += results;
  // Nullable: reach was only added to meta_asset_breakdown_daily on
  // 2026-09-15 (see db.ts) — rows synced before then have reach = NULL,
  // not 0, so hasReach tracks whether ANY contributing row actually
  // carries a real value. Without this, a theme whose spend is entirely
  // from not-yet-re-synced rows would show "0" (looks like a real,
  // confirmed zero-reach theme) instead of "—" (no data captured yet).
  if (reach !== null) {
    target.reach += reach;
    target.hasReach = true;
  }
}
// Adds a creative's SHARE of one campaign's bookings/joins — see the
// attribution comment above GET() for the full method. hasBookingsData
// tracks whether any KPI-sheet row for the matching campaign existed at
// all (regardless of the resulting share, which can legitimately be 0),
// same null-vs-zero distinction as hasReach.
function addBookingsShare(target: Row, bookingsShare: number, joinsShare: number) {
  target.bookings += bookingsShare;
  target.joins += joinsShare;
  target.hasBookingsData = true;
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
// Bookings/CPB/Joins/CPJ — ESTIMATED via campaign-level attribution, added
// 2026-09-16. The sheet-KPI feature reports bookings/joins per CAMPAIGN
// (never per creative — confirmed 2026-09-11 against the user's own sheet),
// but 353 of 357 campaign names in that sheet match this account's synced
// campaign_name exactly (99%), so a campaign's bookings/joins CAN be
// distributed across whichever creatives ran in it. Split proportionally by
// each creative's share of that campaign's spend within the selected date
// range (user's explicit choice, 2026-09-16, over splitting by lead share) —
// e.g. a creative with 60% of a campaign's spend gets 60% of its bookings.
// This is a real ESTIMATE, not Meta-reported per-creative data — a campaign
// running one dominant creative and several minor variants will attribute
// bookings mostly to the dominant one even if a minor variant happened to
// convert better, since the sheet has no way to say which specific ad
// within the campaign drove a given booking. bookings/joins/cpb/cpj are
// still null (renders "—") for any bucket with zero matching campaign rows
// in the sheet, same honest-gap convention as reach.
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
      return NextResponse.json({ byTheme: [], byUgc: [], byType: [] }, NO_STORE);
    }

    // Client config for the sheet-KPI bookings/joins attribution — resolved
    // once up front (session-based, same pattern as /api/sheets/meta-kpi)
    // rather than per-account below, since it's the same client regardless
    // of which account is being scanned.
    const session = await getServerSession(authOptions);
    const [kpiClient] = session ? await query<{ id: string; meta_kpi_sheet_id: string | null; show_meta_kpi_sheet: boolean }>(
      `SELECT c.id, c.meta_kpi_sheet_id, c.show_meta_kpi_sheet
       FROM clients c JOIN client_users cu ON cu.client_id = c.id
       WHERE cu.user_id = $1 LIMIT 1`,
      [session.user.id]
    ) : [];

    // campaignSpend: per-campaign-name total spend across every asset that
    // touched it, used as the denominator for each asset's share. Populated
    // in the same pass as byTheme/byUgc/byType below, then the sheet's
    // bookings/joins get distributed across assetSpendByCampaign once both
    // are known (spend must be fully summed first — a campaign's total
    // isn't known until every account/asset row has been scanned).
    const campaignSpend = new Map<string, number>();
    // assetRowsForAttribution: every (campaign, asset) pair's own spend and
    // which output buckets (theme/ugc/type Row objects) it contributes to —
    // kept separately from byTheme/byUgc/byType's running totals since the
    // bookings/joins share can only be computed AFTER campaignSpend is fully
    // summed, but must still be added into the SAME Row objects those totals
    // live in.
    const assetRowsForAttribution: { campaignName: string; spend: number; targets: Row[] }[] = [];

    const byTheme = new Map<string, Row>();
    const byUgc = new Map<string, Row>();
    const byType = new Map<string, Row>();
    for (const key of THEME_ORDER) byTheme.set(key, emptyRow());
    byUgc.set('ugc', emptyRow());
    byUgc.set('non-ugc', emptyRow());
    byType.set('image', emptyRow());
    byType.set('video', emptyRow());

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

      // Grouped by campaign_name too (not just asset_key) — needed to know
      // each creative's OWN spend within each campaign for the bookings/
      // joins attribution share below. b.campaign_name can be '' for rows
      // that predate migration 022 (not yet re-synced) — those simply can't
      // be attributed and are skipped in the share pass, same as any other
      // "no matching campaign in the sheet" case.
      const rows = await query<{ asset_key: string; campaign_name: string; theme: string | null; ugc_status: string | null; spend: string; impressions: string; link_clicks: string; results: string; reach: string | null; any_reach_synced: boolean }>(
        `SELECT b.asset_key, b.campaign_name, a.theme, a.ugc_status,
                SUM(b.spend)::text AS spend, SUM(b.impressions)::text AS impressions,
                SUM(b.link_clicks)::text AS link_clicks, SUM(b.results)::text AS results,
                SUM(b.reach)::text AS reach, (COUNT(b.reach) > 0) AS any_reach_synced
         FROM meta_asset_breakdown_daily b
         JOIN meta_creative_assets a ON a.account_id = b.account_id AND a.asset_key = b.asset_key
         WHERE b.account_id = $1 AND b.date BETWEEN $2 AND $3 AND b.ad_id = ANY($4)
         GROUP BY b.asset_key, b.campaign_name, a.theme, a.ugc_status`,
        [accountId, since, until, Array.from(allowedAdIds)]
      );

      for (const r of rows) {
        const spend = parseFloat(r.spend) || 0;
        const impressions = parseInt(r.impressions, 10) || 0;
        const linkClicks = parseInt(r.link_clicks, 10) || 0;
        const results = parseInt(r.results, 10) || 0;
        // SUM() over an all-NULL group returns SQL NULL, not 0 — COUNT(b.reach)
        // (which skips NULLs) is what actually tells us whether any
        // contributing row has been re-synced with reach captured.
        const reach = r.any_reach_synced ? (parseInt(r.reach || '0', 10) || 0) : null;

        const targets: Row[] = [];
        if (r.theme && byTheme.has(r.theme)) {
          const target = byTheme.get(r.theme)!;
          addInto(target, spend, impressions, linkClicks, results, reach);
          targets.push(target);
        }
        const ugcKey = r.ugc_status === 'ugc' ? 'ugc' : r.ugc_status === 'non-ugc' ? 'non-ugc' : null;
        if (ugcKey) {
          const target = byUgc.get(ugcKey)!;
          addInto(target, spend, impressions, linkClicks, results, reach);
          targets.push(target);
        }
        // Unlike Theme/UGC (admin-tag-dependent, so a real gap exists
        // between them whenever tagging lags — confirmed live 2026-09-15:
        // Anytime Fitness Corporate had $299,708 tagged Theme but not UGC),
        // Image/Video is a structural split on asset_key's own prefix, not
        // an admin tag — every DCO row lands in exactly one of these two
        // buckets regardless of tag status, so this table's total reconciles
        // much closer to the tab's own KPI cards (only the DCO-vs-static
        // gap remains, not an additional tagging gap).
        const typeKey = r.asset_key.startsWith('video:') ? 'video' : 'image';
        const typeTarget = byType.get(typeKey)!;
        addInto(typeTarget, spend, impressions, linkClicks, results, reach);
        targets.push(typeTarget);

        // Bookings/joins attribution bookkeeping — see the comment above
        // GET() for the method. campaign_name can be '' (pre-migration-022
        // rows) — those simply never match a sheet row later, same as any
        // other campaign the sheet has no data for.
        if (r.campaign_name && spend > 0) {
          campaignSpend.set(r.campaign_name, (campaignSpend.get(r.campaign_name) || 0) + spend);
          assetRowsForAttribution.push({ campaignName: r.campaign_name, spend, targets });
        }
      }
    }

    // Fetch the client's sheet-KPI bookings/joins per campaign for this same
    // date range, then distribute each campaign's totals across the assets
    // that ran in it, proportional to spend share (see comment above GET()).
    // Reuses client_meta_kpi_sheet_tabs + fetchMetaKpiSheetRows exactly like
    // /api/sheets/meta-kpi — falls back to meta_kpi_sheet_cache for any
    // month with no live tab configured, same as that route, so this stays
    // consistent with whatever the Bookings/Joins KPI cards show.
    if (kpiClient?.show_meta_kpi_sheet && kpiClient.meta_kpi_sheet_id) {
      const bookingsJoinsByCampaign = new Map<string, { bookings: number; joins: number }>();
      const monthsInRange: string[] = [];
      {
        const [sy, sm] = since.split('-').map(Number);
        const [ey, em] = until.split('-').map(Number);
        let y = sy, m = sm;
        while (y < ey || (y === ey && m <= em)) {
          monthsInRange.push(`${y}-${String(m).padStart(2, '0')}-01`);
          m++;
          if (m > 12) { m = 1; y++; }
        }
      }
      const tabRows = await query<{ month: string; tab_name: string }>(
        `SELECT to_char(month, 'YYYY-MM-DD') AS month, tab_name FROM client_meta_kpi_sheet_tabs WHERE client_id = $1`,
        [kpiClient.id]
      );
      const tabByMonth = new Map(tabRows.map(r => [r.month.slice(0, 7), r.tab_name]));

      for (const month of monthsInRange) {
        const tabName = tabByMonth.get(month.slice(0, 7));
        let monthRows: { day: string; campaign: string; bookings: number; joins: number }[] | null = null;
        if (tabName) {
          try {
            const result = await fetchMetaKpiSheetRows(kpiClient.meta_kpi_sheet_id, tabName);
            monthRows = result.rows;
          } catch { /* fall through to cache below */ }
        }
        if (monthRows === null) {
          const [y, m] = month.split('-').map(Number);
          const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
          monthRows = await query<{ day: string; campaign: string; bookings: number; joins: number }>(
            `SELECT day::text AS day, campaign, bookings, joins FROM meta_kpi_sheet_cache
             WHERE client_id = $1 AND day >= $2::date AND day < $3::date`,
            [kpiClient.id, month, nextMonth]
          );
        }
        for (const r of monthRows) {
          if (r.day < since || r.day > until) continue; // clip to the exact requested range, not just the month
          const cur = bookingsJoinsByCampaign.get(r.campaign) || { bookings: 0, joins: 0 };
          cur.bookings += r.bookings || 0;
          cur.joins += r.joins || 0;
          bookingsJoinsByCampaign.set(r.campaign, cur);
        }
      }

      for (const asset of assetRowsForAttribution) {
        const campaignTotals = bookingsJoinsByCampaign.get(asset.campaignName);
        const totalCampaignSpend = campaignSpend.get(asset.campaignName);
        if (!campaignTotals || !totalCampaignSpend || totalCampaignSpend <= 0) continue;
        const share = asset.spend / totalCampaignSpend;
        const bookingsShare = campaignTotals.bookings * share;
        const joinsShare = campaignTotals.joins * share;
        for (const target of asset.targets) {
          addBookingsShare(target, bookingsShare, joinsShare);
        }
      }
    }

    const toOutput = (key: string, label: string, r: Row) => {
      const ctr = r.impressions > 0 ? Math.round((r.linkClicks / r.impressions) * 10000) / 100 : 0;
      const cpl = r.results > 0 ? Math.round((r.spend / r.results) * 100) / 100 : null;
      return {
        key, label,
        spend: Math.round(r.spend * 100) / 100,
        // Real per-creative reach, captured going forward from 2026-09-15
        // (see db.ts/metaSync.ts) — null only when NONE of this bucket's
        // rows have been re-synced since then, so the UI can render an
        // honest "—" rather than a misleadingly-confident "0". Summed per
        // day per entity like every other reach figure in this app — a
        // known imprecision (Meta's reach is a deduplicated unique-user
        // count, not additive across days), left as-is rather than invent
        // a second, inconsistent convention just for this table.
        reach: r.hasReach ? r.reach : null,
        impressions: r.impressions,
        linkClicks: r.linkClicks,
        ctr,
        leads: r.results,
        cpl,
        // Estimated via campaign-spend-share attribution — see the comment
        // above GET(). Rounded to whole bookings/joins for display (the
        // underlying share math is fractional, e.g. a creative with 33% of
        // a campaign's spend gets 33% of a 10-booking campaign = 3.3,
        // displayed as 3) — null when no sheet row matched any campaign
        // this bucket's spend came from.
        bookings: r.hasBookingsData ? Math.round(r.bookings) : null,
        cpb: r.hasBookingsData && r.bookings > 0 ? Math.round((r.spend / r.bookings) * 100) / 100 : null,
        joins: r.hasBookingsData ? Math.round(r.joins) : null,
        cpj: r.hasBookingsData && r.joins > 0 ? Math.round((r.spend / r.joins) * 100) / 100 : null,
      };
    };

    const themeOut = THEME_ORDER.map(key => toOutput(key, THEME_LABELS[key], byTheme.get(key)!));
    const ugcOut = [
      toOutput('non-ugc', 'Non-UGC', byUgc.get('non-ugc')!),
      toOutput('ugc', 'UGC', byUgc.get('ugc')!),
    ];
    const typeOut = [
      toOutput('image', 'Image', byType.get('image')!),
      toOutput('video', 'Video', byType.get('video')!),
    ];

    return NextResponse.json({ byTheme: themeOut, byUgc: ugcOut, byType: typeOut }, NO_STORE);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
