import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection } from '@/lib/meta';

interface AssetFeedSpec {
  images?: { hash?: string; url?: string }[];
  videos?: { video_id?: string; thumbnail_url?: string; url_tags?: string }[];
  bodies?: { text?: string }[];
  titles?: { text?: string }[];
}

interface AdCreativeResp {
  creative?: {
    id?: string;
    asset_feed_spec?: AssetFeedSpec;
    thumbnail_url?: string;
    image_url?: string;
    object_story_spec?: {
      video_data?: { image_url?: string; video_id?: string };
      link_data?: { picture?: string };
    };
  };
}

interface BreakdownRow {
  ad_id: string;
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
  image_asset?: { id?: string; hash?: string; name?: string };
  video_asset?: { id?: string; video_id?: string; name?: string };
}

interface AssetSummary {
  assetKey: string;            // 'image:<hash>' or 'video:<videoId>'
  type: 'image' | 'video';
  thumbnail: string | null;
  videoSource: string | null;  // playable mp4 for videos (null until enriched below)
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
  adCount: number;             // how many of the input ads use this asset
  adIds: string[];             // distinct ad ids contributing — used by client-side search filter
  ads: { id: string; name: string; status: string; spend: number; results: number; impressions: number; linkClicks: number }[];
  hidden: boolean;             // true when no thumbnail AND under $1 spend — client decides whether to show
}

interface AdMeta {
  id?: string;
  name?: string;
  effective_status?: string;
}

function extractLeads(actions?: BreakdownRow['actions']): number {
  if (!actions) return 0;
  const m: Record<string, number> = {};
  for (const a of actions) m[a.action_type] = parseInt(a.value || '0', 10);
  const pixel = m['offsite_conversion.fb_pixel_lead'] || 0;
  const onsite = m['onsite_conversion.lead_grouped'] || 0;
  if (pixel > 0) return pixel;
  if (onsite > 0) return onsite;
  return m['lead'] || 0;
}

// In-memory cache keyed by (account_id, time_range, sorted ad_ids).
// Asset feed specs barely change; insights for a closed window are immutable.
// Bumped to 2h to reduce Meta API call volume — we burned through the per-user
// rate limit (code 17) with the old 30min cache + per-ad creative fetches.
const CACHE_TTL_MS = 2 * 60 * 60_000;
interface CacheEntry { expires: number; payload: unknown }
const _cache = new Map<string, CacheEntry>();

export async function GET(req: NextRequest) {
  try {
    const { token, accountIds, campaignFilter } = await getClientConnection();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    const adIdsParam = sp.get('ad_ids');
    // When ad_ids is omitted, the route aggregates across ALL ads in the account
    // that have spend in the time range. This is the mode the Creatives tab uses
    // to show account-wide DCO asset performance.
    const accountWide = !adIdsParam;
    let adIds: string[] = [];
    if (!accountWide) {
      adIds = adIdsParam.split(',').map(s => s.trim()).filter(Boolean);
      if (adIds.length === 0) return NextResponse.json({ error: { message: 'ad_ids must contain at least one id' } }, { status: 400 });
      if (adIds.length > 100) return NextResponse.json({ error: { message: 'ad_ids capped at 100' } }, { status: 400 });
    }

    const timeRange = sp.get('time_range') || '{}';
    const attribution = sp.get('action_attribution_windows') || '["7d_click","1d_view","1d_ev"]';

    // v5: investigate-videos diagnostic round.
    const cacheKey = `v5|${accountId}|${timeRange}|${campaignFilter}|${accountWide ? 'all' : [...adIds].sort().join(',')}`;
    const hit = _cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return NextResponse.json(hit.payload);
    }

    // 1) Insights with breakdowns. In account-wide mode we apply the same
    //    campaign-name filter that the rest of the dashboard uses (so the
    //    breakdown only sees ads for this client, not all account ads). In
    //    per-ad mode we additionally filter by ad.id IN [...] for the
    //    explicit list passed by the modal.
    //
    // NOTE: we intentionally do NOT add an effective_status filter here even
    // though we do at the regular insights route. Meta's breakdowns endpoint
    // appears to silently return zero rows for `breakdowns=video_asset` when
    // an ad.effective_status filter is present — verified empirically against
    // Middleton, where BM shows running videos but the filtered call returned
    // dcoVideos: 0. Leaving Meta's default status behavior intact preserves
    // video asset visibility.
    const filtering: { field: string; operator: string; value: string | string[] }[] = [];
    if (campaignFilter) filtering.push({ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter });
    if (!accountWide) filtering.push({ field: 'ad.id', operator: 'IN', value: adIds });
    const filteringJson = filtering.length > 0 ? JSON.stringify(filtering) : null;
    const fetchBreakdown = async (breakdown: 'image_asset' | 'video_asset'): Promise<BreakdownRow[]> => {
      const url = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/insights`);
      url.searchParams.set('level', 'ad');
      url.searchParams.set('breakdowns', breakdown);
      url.searchParams.set('fields', 'ad_id,spend,impressions,inline_link_clicks,actions');
      url.searchParams.set('time_range', timeRange);
      url.searchParams.set('limit', '500');
      url.searchParams.set('action_attribution_windows', attribution);
      if (filteringJson) url.searchParams.set('filtering', filteringJson);
      url.searchParams.set('access_token', token);
      const out: BreakdownRow[] = [];
      let next: string | null = url.toString();
      let safety = 25;
      while (next && safety-- > 0) {
        const res = await fetch(next);
        const json = await res.json() as { data?: BreakdownRow[]; error?: { message?: string }; paging?: { next?: string } };
        if (json.error) throw new Error(json.error.message || 'Meta breakdown error');
        if (Array.isArray(json.data)) out.push(...json.data);
        next = json.paging?.next || null;
      }
      return out;
    };

    const [imageRows, videoRows] = await Promise.all([
      fetchBreakdown('image_asset').catch(() => [] as BreakdownRow[]),
      fetchBreakdown('video_asset').catch(() => [] as BreakdownRow[]),
    ]);

    if (imageRows.length === 0 && videoRows.length === 0) {
      // Account-wide mode: no DCO assets had spend in this period.
      // Per-ad mode: the input ads aren't DCO.
      const payload = { images: [], videos: [], reason: 'no_asset_feed_spec' as const, adsWithSpec: 0, adsTotal: adIds.length };
      _cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, payload });
      return NextResponse.json(payload);
    }

    // 2) Discover the distinct ad_ids that actually had per-asset metrics in this
    //    window, then fetch each of their asset_feed_specs so we can map hash → url.
    const discoveredAdIds = Array.from(new Set([
      ...imageRows.map(r => r.ad_id).filter((id): id is string => !!id),
      ...videoRows.map(r => r.ad_id).filter((id): id is string => !!id),
    ]));
    // Fetch the creative (asset_feed_spec + name + status + ad-level thumb fallbacks)
    // for every discovered ad. Use Meta's `?ids=<comma>` batch syntax so N ads
    // resolve in ceil(N/50) requests instead of N — critical for rate limits
    // when the dashboard is viewed in "All accounts" mode across 20+ accounts.
    interface AdCreativeFallback { thumbnail_url?: string; image_url?: string; videoDataImageUrl?: string; linkDataPicture?: string }
    interface SpecEntry { adId: string; spec: AssetFeedSpec; meta: AdMeta; fallback: AdCreativeFallback }
    const IDS_CHUNK = 50;
    const specs: SpecEntry[] = [];
    for (let i = 0; i < discoveredAdIds.length; i += IDS_CHUNK) {
      const chunk = discoveredAdIds.slice(i, i + IDS_CHUNK);
      try {
        const u = new URL('https://graph.facebook.com/v22.0/');
        u.searchParams.set('ids', chunk.join(','));
        u.searchParams.set('fields', 'id,name,effective_status,creative{id,asset_feed_spec,thumbnail_url,image_url,object_story_spec}');
        u.searchParams.set('access_token', token);
        const res = await fetch(u.toString());
        const json = await res.json() as Record<string, AdCreativeResp & AdMeta> & { error?: unknown };
        if (json.error) {
          // Whole batch failed — fall back to empty entries so the dashboard
          // still renders breakdown rows without ad-level enrichments.
          for (const adId of chunk) specs.push({ adId, spec: {}, meta: {}, fallback: {} });
          continue;
        }
        for (const adId of chunk) {
          const entry = json[adId];
          const c = entry?.creative || {};
          const fallback: AdCreativeFallback = {
            thumbnail_url: c.thumbnail_url,
            image_url: c.image_url,
            videoDataImageUrl: c.object_story_spec?.video_data?.image_url,
            linkDataPicture: c.object_story_spec?.link_data?.picture,
          };
          specs.push({
            adId,
            spec: c.asset_feed_spec || {},
            meta: { id: entry?.id, name: entry?.name, effective_status: entry?.effective_status },
            fallback,
          });
        }
      } catch {
        for (const adId of chunk) specs.push({ adId, spec: {}, meta: {}, fallback: {} });
      }
    }
    const imageMeta = new Map<string, { url?: string; name?: string }>();
    const videoMeta = new Map<string, { thumbnail_url?: string; name?: string }>();
    const adMetaMap = new Map<string, AdMeta>();
    const adFallbackMap = new Map<string, AdCreativeFallback>();
    // Pick the first non-empty body/title we see in any spec — used as the asset's copy.
    let firstBody: string | null = null;
    let firstTitle: string | null = null;
    const hasFeedSpec = new Set<string>();
    for (const { adId, spec, meta, fallback } of specs) {
      adMetaMap.set(adId, meta);
      adFallbackMap.set(adId, fallback);
      if ((spec.images?.length || 0) + (spec.videos?.length || 0) > 0) hasFeedSpec.add(adId);
      for (const img of spec.images || []) {
        if (img.hash && !imageMeta.has(img.hash)) imageMeta.set(img.hash, { url: img.url });
      }
      for (const vid of spec.videos || []) {
        if (vid.video_id && !videoMeta.has(vid.video_id)) videoMeta.set(vid.video_id, { thumbnail_url: vid.thumbnail_url });
      }
      if (!firstBody && spec.bodies?.[0]?.text) firstBody = spec.bodies[0].text;
      if (!firstTitle && spec.titles?.[0]?.text) firstTitle = spec.titles[0].text;
    }

    // 3) Aggregate. The same hash/video can appear across multiple ads;
    //    we sum metrics and count distinct ad_ids per asset.
    // AggBucket omits `hidden` — it's computed in finalize() from the final
    // spend total, not maintained incrementally during aggregation.
    interface AggBucket extends Omit<AssetSummary, 'hidden'> { _adIdSet: Set<string>; _perAd: Map<string, { spend: number; results: number; impressions: number; linkClicks: number }> }
    const accAd = (row: AggBucket, adId: string, r: BreakdownRow) => {
      const sp = parseFloat(r.spend || '0') || 0;
      const im = parseInt(r.impressions || '0', 10) || 0;
      const lc = parseInt(r.inline_link_clicks || '0', 10) || 0;
      const ld = extractLeads(r.actions);
      row.spend += sp; row.impressions += im; row.linkClicks += lc; row.results += ld;
      row._adIdSet.add(adId);
      const cur = row._perAd.get(adId) || { spend: 0, results: 0, impressions: 0, linkClicks: 0 };
      cur.spend += sp; cur.impressions += im; cur.linkClicks += lc; cur.results += ld;
      row._perAd.set(adId, cur);
    };

    const imageAgg = new Map<string, AggBucket>();
    for (const r of imageRows) {
      const hash = r.image_asset?.hash;
      if (!hash || !r.ad_id) continue;
      let row = imageAgg.get(hash);
      if (!row) {
        const meta = imageMeta.get(hash);
        row = {
          assetKey: `image:${hash}`,
          type: 'image',
          thumbnail: meta?.url || null,
          videoSource: null,
          videoId: null,
          body: firstBody,
          title: firstTitle,
          name: meta?.name || r.image_asset?.name || null,
          spend: 0, results: 0, impressions: 0, linkClicks: 0,
          ctr: 0, cpl: 0,
          adCount: 0,
          adIds: [],
          ads: [],
          _adIdSet: new Set<string>(),
          _perAd: new Map(),
        };
        imageAgg.set(hash, row);
      }
      accAd(row, r.ad_id, r);
    }
    const videoAgg = new Map<string, AggBucket>();
    for (const r of videoRows) {
      const vid = r.video_asset?.video_id;
      if (!vid || !r.ad_id) continue;
      let row = videoAgg.get(vid);
      if (!row) {
        const meta = videoMeta.get(vid);
        row = {
          assetKey: `video:${vid}`,
          type: 'video',
          thumbnail: meta?.thumbnail_url || null,
          videoSource: null,
          videoId: vid,
          body: firstBody,
          title: firstTitle,
          name: meta?.name || r.video_asset?.name || null,
          spend: 0, results: 0, impressions: 0, linkClicks: 0,
          ctr: 0, cpl: 0,
          adCount: 0,
          adIds: [],
          ads: [],
          _adIdSet: new Set<string>(),
          _perAd: new Map(),
        };
        videoAgg.set(vid, row);
      }
      accAd(row, r.ad_id, r);
    }

    // 4) For images, upgrade thumbnails to full-res via the same adimages batch
    //    trick used in /api/meta/creatives. The asset_feed_spec sometimes
    //    returns a usable url already; this is the fallback / sharpener.
    const imageHashes = Array.from(imageAgg.keys()).filter(h => /^[a-f0-9]{20,}$/i.test(h));
    if (imageHashes.length > 0) {
      try {
        // Meta limits hashes per call; chunk in batches of 50 to be safe.
        const CHUNK = 50;
        for (let i = 0; i < imageHashes.length; i += CHUNK) {
          const batch = imageHashes.slice(i, i + CHUNK);
          const uu = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/adimages`);
          uu.searchParams.set('hashes', JSON.stringify(batch));
          uu.searchParams.set('fields', 'hash,url,permalink_url');
          uu.searchParams.set('access_token', token);
          const res = await fetch(uu.toString());
          const json = await res.json() as { data?: { hash?: string; url?: string; permalink_url?: string }[] };
          for (const img of json.data || []) {
            if (!img.hash) continue;
            const sharpUrl = img.url || img.permalink_url;
            if (!sharpUrl) continue;
            const row = imageAgg.get(img.hash);
            if (row) row.thumbnail = sharpUrl;
          }
        }
      } catch { /* thumbnails stay as whatever spec gave us */ }
    }

    // Final fallback for any image row still without a thumbnail: walk the ads
    // that reference it and pick the first usable creative-level image url.
    for (const row of Array.from(imageAgg.values())) {
      if (row.thumbnail) continue;
      for (const adId of Array.from(row._adIdSet)) {
        const fb = adFallbackMap.get(adId);
        if (!fb) continue;
        const candidate = fb.image_url || fb.linkDataPicture || fb.thumbnail_url;
        if (candidate) { row.thumbnail = candidate; break; }
      }
    }



    // 5) Fetch video source URLs in parallel for every unique video asset so the
    //    modal can play them. Ignore failures silently — videoSource stays null.
    //    Some videos return GraphMethodException (code 100, subcode 33) on the
    //    bare /<video_id> endpoint because they were uploaded to a different
    //    ad account / Page than the one our token is scoped for. The
    //    account-scoped advideos endpoint sometimes resolves them.
    type VideoFields = {
      source?: string;
      picture?: string;
      thumbnails?: { data?: { uri?: string; is_preferred?: boolean }[] };
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    const fetchVideoFields = async (path: string): Promise<VideoFields> => {
      try {
        const u = `https://graph.facebook.com/v22.0/${path}?fields=source,picture,thumbnails{uri,is_preferred}&access_token=${token}`;
        const res = await fetch(u);
        return await res.json() as VideoFields;
      } catch {
        return {};
      }
    };
    const applyToRow = (row: AggBucket, json: VideoFields): boolean => {
      let got = false;
      if (!row.videoSource && json.source) { row.videoSource = json.source; got = true; }
      if (!row.thumbnail && json.picture) { row.thumbnail = json.picture; got = true; }
      if (!row.thumbnail) {
        const thumbs = json.thumbnails?.data || [];
        const preferred = thumbs.find(t => t.is_preferred && t.uri)?.uri;
        const any = thumbs.find(t => t.uri)?.uri;
        if (preferred || any) { row.thumbnail = preferred || any || null; got = true; }
      }
      return got;
    };
    // Batch video lookups via ?ids= — same rate-limit benefit as the ad batch above.
    const videoIds = Array.from(videoAgg.keys());
    const videoResults = new Map<string, VideoFields>();
    for (let i = 0; i < videoIds.length; i += IDS_CHUNK) {
      const chunk = videoIds.slice(i, i + IDS_CHUNK);
      try {
        const u = new URL('https://graph.facebook.com/v22.0/');
        u.searchParams.set('ids', chunk.join(','));
        u.searchParams.set('fields', 'source,picture,thumbnails{uri,is_preferred}');
        u.searchParams.set('access_token', token);
        const res = await fetch(u.toString());
        const json = await res.json() as Record<string, VideoFields> & { error?: { code?: number; error_subcode?: number } };
        if (json.error) {
          // If the WHOLE batch fails auth (e.g. one bad id poisoned it), Meta's
          // batch endpoint typically returns 200 with per-id errors instead, so
          // this top-level error path is rare. Synthesize the same shape so the
          // single-id retry loop below kicks in for every video in this chunk.
          for (const vid of chunk) videoResults.set(vid, { error: json.error });
          continue;
        }
        for (const vid of chunk) {
          if (json[vid]) videoResults.set(vid, json[vid]);
        }
      } catch {
        for (const vid of chunk) videoResults.set(vid, {});
      }
    }

    // Apply batch results + walk per-video fallback chain (advideos endpoint
    // for cross-account, then ad-level creative thumbnails).
    await Promise.all(videoIds.map(async vid => {
      const row = videoAgg.get(vid);
      if (!row) return;
      const first = videoResults.get(vid) || {};
      applyToRow(row, first);
      const failedAuth = first.error?.code === 100 && first.error?.error_subcode === 33;
      if (!row.thumbnail && (failedAuth || !first.source)) {
        // advideos is account-scoped so it can't be batched the same way.
        // Only invoked when the first lookup actually failed auth — rare path.
        const second = await fetchVideoFields(`act_${accountId}/advideos/${vid}`);
        applyToRow(row, second);
      }
      if (!row.thumbnail) {
        for (const adId of Array.from(row._adIdSet)) {
          const fb = adFallbackMap.get(adId);
          if (!fb) continue;
          const candidate = fb.videoDataImageUrl || fb.thumbnail_url || fb.linkDataPicture || fb.image_url;
          if (candidate) { row.thumbnail = candidate; break; }
        }
      }
    }));

    // 6) Materialize, round, derive CTR/CPL, drop the internal Set/Map, materialize per-ad rows.
    const finalize = (rows: Iterable<AggBucket>): AssetSummary[] => {
      const out: AssetSummary[] = [];
      for (const r of Array.from(rows)) {
        const ctr = r.impressions > 0 ? (r.linkClicks / r.impressions) * 100 : 0;
        const cpl = r.results > 0 ? r.spend / r.results : 0;
        const ads: AssetSummary['ads'] = [];
        r._perAd.forEach((m, adId) => {
          const meta = adMetaMap.get(adId) || {};
          ads.push({
            id: adId,
            name: meta.name || adId,
            status: meta.effective_status || 'UNKNOWN',
            spend: Math.round(m.spend * 100) / 100,
            results: m.results,
            impressions: m.impressions,
            linkClicks: m.linkClicks,
          });
        });
        ads.sort((a, b) => b.spend - a.spend);
        const roundedSpend = Math.round(r.spend * 100) / 100;
        out.push({
          assetKey: r.assetKey,
          type: r.type,
          thumbnail: r.thumbnail,
          videoSource: r.videoSource,
          videoId: r.videoId,
          body: r.body,
          title: r.title,
          name: r.name,
          spend: roundedSpend,
          results: r.results,
          impressions: r.impressions,
          linkClicks: r.linkClicks,
          ctr: Math.round(ctr * 100) / 100,
          cpl: Math.round(cpl * 100) / 100,
          adCount: r._adIdSet.size,
          adIds: Array.from(r._adIdSet),
          ads,
          // Marked hidden when there's no thumbnail at all. Assets with a
          // preview stay visible regardless of status (DELETED/ARCHIVED ads
          // keep their thumbnail). The client's "Show hidden assets" toggle
          // reveals these no-preview rows when the owner wants to inspect them.
          hidden: r.thumbnail === null,
        });
      }
      out.sort((a, b) => b.spend - a.spend);
      return out;
    };

    const payload = {
      images: finalize(imageAgg.values()),
      videos: finalize(videoAgg.values()),
      adsWithSpec: hasFeedSpec.size,
      adsTotal: accountWide ? discoveredAdIds.length : adIds.length,
      // Ad IDs whose spend is ALREADY being reported per-asset in this
      // response. The client subtracts these from /api/meta/creatives so
      // static ads don't double-count. We use discoveredAdIds (ads that
      // produced breakdown rows) rather than hasFeedSpec (ads whose creative
      // lookup returned asset_feed_spec) — Meta's per-ad creative fetch can
      // miss asset_feed_spec for plenty of ads that nonetheless return
      // per-asset breakdown rows, so hasFeedSpec systematically under-counts.
      dcoAdIds: discoveredAdIds,
    };

    _cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, payload });
    return NextResponse.json(payload);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
