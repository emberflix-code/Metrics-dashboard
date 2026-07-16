import { NextRequest, NextResponse } from 'next/server';
import { getClientDbScope, matchesCampaignFilter } from '@/lib/meta';
import { query } from '@/lib/db';

interface AssetSummary {
  assetKey: string;
  type: 'image' | 'video';
  thumbnail: string | null;
  videoSource: string | null;
  videoId: string | null;
  body: string | null;
  title: string | null;
  name: string | null;
  spend: number;
  results: number;
  impressions: number;
  linkClicks: number;
  ctr: number;
  cpl: number;
  adCount: number;
  adIds: string[];
  ads: { id: string; name: string; status: string; spend: number; results: number; impressions: number; linkClicks: number }[];
  hidden: boolean;
}

// DB-backed mirror of /api/meta/asset-breakdown. Aggregates
// meta_asset_breakdown_daily for the requested range, joins asset metadata
// from meta_creative_assets, and returns the same {images, videos,
// adsWithSpec, adsTotal, dcoAdIds} shape. Only the account-wide mode
// (ad_ids omitted) is actually called by DashboardClient.tsx today, but
// ad_ids is still honored for parity with the live route's contract.
export async function GET(req: NextRequest) {
  try {
    const { accountIds, campaignFilter } = await getClientDbScope();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    const adIdsParam = sp.get('ad_ids');
    const accountWide = !adIdsParam;
    const explicitAdIds = accountWide ? [] : adIdsParam.split(',').map(s => s.trim()).filter(Boolean);

    let since = '', until = '';
    try {
      const range = JSON.parse(sp.get('time_range') || '{}');
      since = range.since || '';
      until = range.until || '';
    } catch { /* empty range below returns nothing */ }
    if (!since || !until) {
      return NextResponse.json({ images: [], videos: [], adsWithSpec: 0, adsTotal: 0, dcoAdIds: [] });
    }

    // Restrict to ads whose campaign matches this client's filter — same
    // scoping the live route applies via the insights call's campaign.name filter.
    const scopedAdRows = await query<{ entity_id: string; campaign_name: string }>(
      `SELECT entity_id, campaign_name FROM meta_entities WHERE account_id = $1 AND level = 'ad'`,
      [accountId]
    );
    let allowedAdIds = new Set(
      scopedAdRows.filter(r => matchesCampaignFilter(r.campaign_name || '', campaignFilter)).map(r => r.entity_id)
    );
    if (!accountWide) {
      const explicit = new Set(explicitAdIds);
      allowedAdIds = new Set(Array.from(allowedAdIds).filter(id => explicit.has(id)));
    }

    if (allowedAdIds.size === 0) {
      return NextResponse.json({ images: [], videos: [], reason: 'no_asset_feed_spec', adsWithSpec: 0, adsTotal: 0, dcoAdIds: [] });
    }

    const breakdownRows = await query<{ asset_key: string; ad_id: string; spend: string; impressions: string; link_clicks: string; results: string }>(
      `SELECT asset_key, ad_id, SUM(spend)::text AS spend, SUM(impressions)::text AS impressions,
              SUM(link_clicks)::text AS link_clicks, SUM(results)::text AS results
       FROM meta_asset_breakdown_daily
       WHERE account_id = $1 AND date BETWEEN $2 AND $3 AND ad_id = ANY($4)
       GROUP BY asset_key, ad_id`,
      [accountId, since, until, Array.from(allowedAdIds)]
    );

    if (breakdownRows.length === 0) {
      return NextResponse.json({ images: [], videos: [], reason: 'no_asset_feed_spec', adsWithSpec: 0, adsTotal: 0, dcoAdIds: [] });
    }

    const assetKeys = Array.from(new Set(breakdownRows.map(r => r.asset_key)));
    const assetRows = await query<{ asset_key: string; type: string; thumbnail: string | null; video_source: string | null; video_id: string | null; body: string | null; title: string | null }>(
      `SELECT asset_key, type, thumbnail, video_source, video_id, body, title FROM meta_creative_assets WHERE account_id = $1 AND asset_key = ANY($2)`,
      [accountId, assetKeys]
    );
    const assetByKey = new Map(assetRows.map(a => [a.asset_key, a] as const));

    const adMetaRows = await query<{ entity_id: string; name: string; effective_status: string }>(
      `SELECT entity_id, name, effective_status FROM meta_entities WHERE account_id = $1 AND level = 'ad' AND entity_id = ANY($2)`,
      [accountId, Array.from(new Set(breakdownRows.map(r => r.ad_id)))]
    );
    const adMetaById = new Map(adMetaRows.map(a => [a.entity_id, a] as const));

    const images = new Map<string, AssetSummary & { _adIdSet: Set<string> }>();
    const videos = new Map<string, AssetSummary & { _adIdSet: Set<string> }>();

    for (const r of breakdownRows) {
      // meta_creative_assets is only populated for ads captured by
      // syncCreatives's ACTIVE/PAUSED/CAMPAIGN_PAUSED/ADSET_PAUSED-filtered
      // /ads fetch, but meta_asset_breakdown_daily is fed by a status-
      // unfiltered breakdown-insights call — so a long-running account can
      // have real spend/results here for an asset whose metadata was never
      // captured (its only ads are since DELETED/ARCHIVED). The live route
      // (asset-breakdown/route.ts) never drops these — it discovers ad_ids
      // straight from the breakdown call and always renders a row, just
      // with thumbnail: null (surfaced via the existing `hidden` flag
      // below, same as any other no-preview asset). Previously this silently
      // skipped the row entirely, undercounting spend/leads on the
      // Creatives tab for any account old enough to have archived ads.
      const asset = assetByKey.get(r.asset_key);
      const isVideo = r.asset_key.startsWith('video:');
      const bucket = isVideo ? videos : images;
      let row = bucket.get(r.asset_key);
      if (!row) {
        row = {
          assetKey: r.asset_key,
          type: isVideo ? 'video' : 'image',
          thumbnail: asset?.thumbnail ?? null,
          videoSource: asset?.video_source ?? null,
          videoId: asset?.video_id ?? null,
          body: asset?.body ?? null,
          title: asset?.title ?? null,
          name: asset?.title ?? null,
          spend: 0, results: 0, impressions: 0, linkClicks: 0,
          ctr: 0, cpl: 0,
          adCount: 0, adIds: [], ads: [], hidden: false,
          _adIdSet: new Set<string>(),
        };
        bucket.set(r.asset_key, row);
      }
      const spend = parseFloat(r.spend) || 0;
      const impressions = parseInt(r.impressions, 10) || 0;
      const linkClicks = parseInt(r.link_clicks, 10) || 0;
      const results = parseInt(r.results, 10) || 0;
      row.spend += spend;
      row.impressions += impressions;
      row.linkClicks += linkClicks;
      row.results += results;
      row._adIdSet.add(r.ad_id);
      const meta = adMetaById.get(r.ad_id);
      row.ads.push({
        id: r.ad_id,
        name: meta?.name || r.ad_id,
        status: meta?.effective_status || 'UNKNOWN',
        spend: Math.round(spend * 100) / 100,
        results,
        impressions,
        linkClicks,
      });
    }

    const finalize = (bucket: Map<string, AssetSummary & { _adIdSet: Set<string> }>): AssetSummary[] => {
      const out: AssetSummary[] = [];
      for (const row of Array.from(bucket.values())) {
        const ctr = row.impressions > 0 ? (row.linkClicks / row.impressions) * 100 : 0;
        const cpl = row.results > 0 ? row.spend / row.results : 0;
        row.ads.sort((a, b) => b.spend - a.spend);
        out.push({
          ...row,
          spend: Math.round(row.spend * 100) / 100,
          ctr: Math.round(ctr * 100) / 100,
          cpl: Math.round(cpl * 100) / 100,
          adCount: row._adIdSet.size,
          adIds: Array.from(row._adIdSet),
          hidden: row.thumbnail === null,
        });
      }
      out.sort((a, b) => b.spend - a.spend);
      return out;
    };

    // adsTotal matches the live route's semantics: ads that actually
    // produced a breakdown row (i.e. had DCO delivery) within the requested
    // date range — NOT every ad in meta_entities matching the campaign
    // filter regardless of whether it ran in this window. Using
    // allowedAdIds.size here would inflate the denominator with every
    // historically-synced ad, showing a different "adsWithSpec / adsTotal"
    // coverage ratio than live mode for the same account+range.
    const discoveredAdIds = Array.from(new Set(breakdownRows.map(r => r.ad_id)));
    return NextResponse.json({
      images: finalize(images),
      videos: finalize(videos),
      adsWithSpec: assetKeys.length,
      adsTotal: discoveredAdIds.length,
      dcoAdIds: discoveredAdIds,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
