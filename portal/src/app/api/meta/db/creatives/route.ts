import { NextRequest, NextResponse } from 'next/server';
import { getClientDbScope, matchesCampaignFilter } from '@/lib/meta';
import { query } from '@/lib/db';

interface CreativeRow {
  assetKey: string;
  type: 'image' | 'video' | 'carousel-slide' | 'unknown';
  thumbnail: string | null;
  videoSource: string | null;
  videoId: string | null;
  body: string | null;
  title: string | null;
  sampleAdName: string;
  sampleAdId: string;
  spend: number;
  results: number;
  impressions: number;
  linkClicks: number;
  reach: number;
  ctr: number;
  cpl: number;
  ads: { id: string; name: string; status: string; spend: number; results: number; impressions: number; linkClicks: number }[];
}

// DB-backed mirror of /api/meta/creatives. Joins meta_creative_assets +
// meta_creative_asset_ad_map + meta_daily_insights(level='ad') for the
// requested range and reconstructs the exact CreativeRow[] shape the live
// route returns, with the same rounding, so DashboardClient.tsx's rendering
// code needs zero changes.
export async function GET(req: NextRequest) {
  try {
    const { accountIds, campaignFilter } = await getClientDbScope();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    let since = '', until = '';
    try {
      const range = JSON.parse(sp.get('time_range') || '{}');
      since = range.since || '';
      until = range.until || '';
    } catch { /* empty range below returns nothing */ }
    if (!since || !until) return NextResponse.json({ data: [] });

    // Per-ad metrics for the range, restricted to campaigns matching this
    // client's filter (mirrors the live route filtering insights by
    // campaign.name before grouping into assets).
    const insightRows = await query<{ entity_id: string; campaign_name: string; ad_name: string; reach: string; impressions: string; spend: string; link_clicks: string; results: string }>(
      `SELECT entity_id, campaign_name, ad_name, reach::text AS reach, impressions::text AS impressions,
              spend::text AS spend, link_clicks::text AS link_clicks, results::text AS results
       FROM meta_daily_insights
       WHERE account_id = $1 AND level = 'ad' AND date BETWEEN $2 AND $3`,
      [accountId, since, until]
    );

    const metricsByAdId = new Map<string, { spend: number; impressions: number; linkClicks: number; reach: number; results: number; adName: string }>();
    for (const r of insightRows) {
      if (!matchesCampaignFilter(r.campaign_name || '', campaignFilter)) continue;
      const existing = metricsByAdId.get(r.entity_id);
      const spend = parseFloat(r.spend) || 0;
      const impressions = parseInt(r.impressions, 10) || 0;
      const linkClicks = parseInt(r.link_clicks, 10) || 0;
      const reach = parseInt(r.reach, 10) || 0;
      const results = parseInt(r.results, 10) || 0;
      if (!existing) {
        metricsByAdId.set(r.entity_id, { spend, impressions, linkClicks, reach, results, adName: r.ad_name || '' });
      } else {
        existing.spend += spend;
        existing.impressions += impressions;
        existing.linkClicks += linkClicks;
        existing.reach += reach;
        existing.results += results;
      }
    }
    if (metricsByAdId.size === 0) return NextResponse.json({ data: [] });

    const adIds = Array.from(metricsByAdId.keys());
    const mapRows = await query<{ asset_key: string; ad_id: string; weight: string }>(
      `SELECT asset_key, ad_id, weight::text AS weight FROM meta_creative_asset_ad_map WHERE account_id = $1 AND ad_id = ANY($2)`,
      [accountId, adIds]
    );

    const assetKeys = Array.from(new Set(mapRows.map(r => r.asset_key)));
    if (assetKeys.length === 0) return NextResponse.json({ data: [] });

    const assetRows = await query<{ asset_key: string; type: string; thumbnail: string | null; video_source: string | null; video_id: string | null; body: string | null; title: string | null }>(
      `SELECT asset_key, type, thumbnail, video_source, video_id, body, title FROM meta_creative_assets WHERE account_id = $1 AND asset_key = ANY($2)`,
      [accountId, assetKeys]
    );
    const assetByKey = new Map(assetRows.map(a => [a.asset_key, a] as const));

    const rows = new Map<string, CreativeRow>();
    for (const m of mapRows) {
      const metrics = metricsByAdId.get(m.ad_id);
      const asset = assetByKey.get(m.asset_key);
      if (!metrics || !asset) continue;
      const weight = parseFloat(m.weight) || 1;

      let row = rows.get(m.asset_key);
      if (!row) {
        row = {
          assetKey: m.asset_key,
          type: (asset.type as CreativeRow['type']) || 'unknown',
          thumbnail: asset.thumbnail,
          videoSource: asset.video_source,
          videoId: asset.video_id,
          body: asset.body,
          title: asset.title,
          sampleAdName: metrics.adName || '(unnamed)',
          sampleAdId: m.ad_id,
          spend: 0, results: 0, impressions: 0, linkClicks: 0, reach: 0,
          ctr: 0, cpl: 0,
          ads: [],
        };
        rows.set(m.asset_key, row);
      }
      row.spend += metrics.spend * weight;
      row.results += metrics.results * weight;
      row.impressions += metrics.impressions * weight;
      row.linkClicks += metrics.linkClicks * weight;
      row.reach += Math.round(metrics.reach * weight);
      if (!row.ads.find(a => a.id === m.ad_id)) {
        row.ads.push({
          id: m.ad_id,
          name: metrics.adName || '(unnamed)',
          status: 'UNKNOWN',
          spend: metrics.spend,
          results: metrics.results,
          impressions: metrics.impressions,
          linkClicks: metrics.linkClicks,
        });
      }
    }

    // Backfill ad status from meta_entities (live route reads it off /ads,
    // this reads it off the last-synced entity snapshot).
    const statusRows = await query<{ entity_id: string; effective_status: string }>(
      `SELECT entity_id, effective_status FROM meta_entities WHERE account_id = $1 AND level = 'ad' AND entity_id = ANY($2)`,
      [accountId, adIds]
    );
    const statusByAdId = new Map(statusRows.map(s => [s.entity_id, s.effective_status] as const));
    for (const row of Array.from(rows.values())) {
      for (const ad of row.ads) ad.status = statusByAdId.get(ad.id) || 'UNKNOWN';
    }

    const data = Array.from(rows.values()).map(r => {
      const ctr = r.impressions > 0 ? (r.linkClicks / r.impressions) * 100 : 0;
      const cpl = r.results > 0 ? r.spend / r.results : 0;
      return {
        ...r,
        spend: Math.round(r.spend * 100) / 100,
        results: Math.round(r.results * 100) / 100,
        impressions: Math.round(r.impressions),
        linkClicks: Math.round(r.linkClicks),
        reach: Math.round(r.reach),
        ctr: Math.round(ctr * 100) / 100,
        cpl: Math.round(cpl * 100) / 100,
        ads: r.ads.map(a => ({
          ...a,
          spend: Math.round(a.spend * 100) / 100,
          results: Math.round(a.results * 100) / 100,
          impressions: Math.round(a.impressions),
          linkClicks: Math.round(a.linkClicks),
        })),
      };
    });

    return NextResponse.json({ data });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
