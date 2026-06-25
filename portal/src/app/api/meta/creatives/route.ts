import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection } from '@/lib/meta';

// One row per ad's insights (raw from Meta).
interface AdInsight {
  ad_id: string;
  ad_name?: string;
  campaign_name?: string;
  adset_name?: string;
  effective_status?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  reach?: string;
  actions?: { action_type: string; value: string }[];
}

// Creative metadata from /ads?fields=creative{...}
interface AdCreative {
  id?: string;                       // ad ID
  effective_status?: string;
  creative?: {
    id?: string;
    image_url?: string;
    image_hash?: string;
    thumbnail_url?: string;
    video_id?: string;
    body?: string;
    title?: string;
    object_story_spec?: {
      page_id?: string;
      link_data?: {
        picture?: string;
        message?: string;
        name?: string;
        child_attachments?: {
          image_hash?: string;
          picture?: string;
          link?: string;
          name?: string;
          description?: string;
        }[];
      };
      video_data?: {
        image_url?: string;
        video_id?: string;
        title?: string;
        message?: string;
      };
    };
  };
}

interface CreativeRow {
  assetKey: string;            // hash, video_id, or fallback creative_id
  type: 'image' | 'video' | 'carousel-slide' | 'unknown';
  thumbnail: string | null;
  videoSource: string | null;  // playable video URL when type === 'video'
  videoId: string | null;      // underlying video asset ID (for Open in Ads Manager links)
  body: string | null;         // ad copy
  title: string | null;        // headline
  sampleAdName: string;
  sampleAdId: string;
  // Aggregate metrics
  spend: number;
  results: number;
  impressions: number;
  linkClicks: number;
  reach: number;
  // Derived for client (also reproducible there, but cheap to compute once)
  ctr: number;
  cpl: number;
  // Per-ad breakdown (drawer)
  ads: { id: string; name: string; status: string; spend: number; results: number; impressions: number; linkClicks: number }[];
}

function extractLeads(actions?: AdInsight['actions']): number {
  if (!actions) return 0;
  const m: Record<string, number> = {};
  for (const a of actions) m[a.action_type] = parseInt(a.value || '0', 10);
  const pixel = m['offsite_conversion.fb_pixel_lead'] || 0;
  const onsite = m['onsite_conversion.lead_grouped'] || 0;
  if (pixel > 0) return pixel;
  if (onsite > 0) return onsite;
  return m['lead'] || 0;
}

/**
 * Pass-through. We tried to enlarge Meta's 64x64 stp-encoded thumbnails
 * by modifying the `stp` param (delete or bump pNxN), but the CDN's
 * `_nc_tpa` signature validation rejects any change, so the modified
 * URL 403s. Left as a no-op until we find a Meta endpoint that returns
 * a higher-res URL natively.
 */
function unscaleMetaImage(url: string | null | undefined): string | null {
  return url ?? null;
}

async function fetchAll<T>(url: URL, token: string): Promise<T[]> {
  const out: T[] = [];
  const initial = url.toString();
  let next: string | null = initial.includes('access_token=') ? initial : `${initial}&access_token=${token}`;
  let safety = 25;
  while (next && safety-- > 0) {
    const res: Response = await fetch(next);
    const json: { data?: T[]; error?: { message?: string }; paging?: { next?: string } } = await res.json();
    if (json.error) throw new Error(json.error.message || 'Meta API error');
    if (Array.isArray(json.data)) out.push(...json.data);
    next = json.paging?.next || null;
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { tokenForAccount, accountIds, campaignFilter } = await getClientConnection();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });
    const token = tokenForAccount(accountId);

    const timeRange = sp.get('time_range') || '{}';
    const attribution = sp.get('action_attribution_windows') || '["7d_click","1d_view","1d_ev"]';

    // Include DELETED/ARCHIVED so per-ad totals reconcile with KPI cards.
    const ALL_AD_STATUSES = ['ACTIVE','PAUSED','DELETED','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO','CAMPAIGN_PAUSED','ARCHIVED','ADSET_PAUSED','IN_PROCESS','WITH_ISSUES'];

    // 1) Insights at ad level — the metrics we need.
    const insightsUrl = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/insights`);
    insightsUrl.searchParams.set('fields', 'ad_id,ad_name,campaign_name,adset_name,spend,impressions,inline_link_clicks,reach,actions');
    insightsUrl.searchParams.set('level', 'ad');
    insightsUrl.searchParams.set('time_range', timeRange);
    insightsUrl.searchParams.set('limit', '500');
    insightsUrl.searchParams.set('action_attribution_windows', attribution);
    insightsUrl.searchParams.set('filtering', JSON.stringify([
      { field: 'ad.effective_status', operator: 'IN', value: ALL_AD_STATUSES },
      ...(campaignFilter ? [{ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter }] : []),
    ]));

    // 2) Ads + their creative metadata (one call thanks to field expansion).
    const adsUrl = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/ads`);
    adsUrl.searchParams.set(
      'fields',
      'id,effective_status,creative{id,image_url,image_hash,thumbnail_url,video_id,body,title,object_story_spec}'
    );
    adsUrl.searchParams.set('limit', '200');
    adsUrl.searchParams.set('filtering', JSON.stringify([
      { field: 'effective_status', operator: 'IN', value: ALL_AD_STATUSES },
      ...(campaignFilter ? [{ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter }] : []),
    ]));

    const [insights, ads] = await Promise.all([
      fetchAll<AdInsight>(insightsUrl, token),
      fetchAll<AdCreative>(adsUrl, token),
    ]);

    // Index creative metadata by ad ID.
    const creativeByAdId = new Map<string, AdCreative>();
    for (const ad of ads) {
      if (ad.id) creativeByAdId.set(ad.id, ad);
    }

    // For each insight row, derive the asset identity (or identities, if a carousel).
    // Per the agreed scope: one row per slide for carousels.
    interface PerSlide {
      assetKey: string;
      type: CreativeRow['type'];
      thumbnail: string | null;
      videoId: string | null;
      body: string | null;
      title: string | null;
      adId: string;
      adName: string;
      campaignName: string;
      status: string;
      spend: number;
      results: number;
      impressions: number;
      linkClicks: number;
      reach: number;
      // Weight when splitting metrics across N carousel slides (1 for non-carousels).
      // 1 / slideCount so summed metrics stay consistent with the ad's true totals.
      weight: number;
    }
    const perSlide: PerSlide[] = [];

    for (const ins of insights) {
      if (!ins.ad_id) continue;
      const ad = creativeByAdId.get(ins.ad_id);
      const creative = ad?.creative;
      const spend = parseFloat(ins.spend || '0') || 0;
      const impressions = parseInt(ins.impressions || '0', 10) || 0;
      const linkClicks = parseInt(ins.inline_link_clicks || '0', 10) || 0;
      const reach = parseInt(ins.reach || '0', 10) || 0;
      const results = extractLeads(ins.actions);

      const linkData = creative?.object_story_spec?.link_data;
      const videoData = creative?.object_story_spec?.video_data;
      const carouselSlides = linkData?.child_attachments;
      // Common copy fields used by every CASE below — first non-empty wins.
      const adBody = videoData?.message || linkData?.message || creative?.body || null;
      const adTitle = videoData?.title || linkData?.name || creative?.title || null;

      // CASE 1: carousel — emit one slide per child_attachment, splitting metrics evenly.
      if (carouselSlides && carouselSlides.length > 0) {
        const weight = 1 / carouselSlides.length;
        for (let i = 0; i < carouselSlides.length; i++) {
          const slide = carouselSlides[i];
          const key = slide.image_hash || `${creative?.id || ins.ad_id}#slide${i}`;
          perSlide.push({
            assetKey: key,
            type: 'carousel-slide',
            thumbnail: unscaleMetaImage(slide.picture),
            videoId: null,
            body: slide.description || adBody,
            title: slide.name || adTitle,
            adId: ins.ad_id,
            adName: ins.ad_name || ad?.id || '(unnamed)',
            campaignName: ins.campaign_name || '',
            status: ad?.effective_status || ins.effective_status || 'UNKNOWN',
            spend: spend * weight,
            results: results * weight,
            impressions: impressions * weight,
            linkClicks: linkClicks * weight,
            reach: Math.round(reach * weight),
            weight,
          });
        }
        continue;
      }

      // CASE 2: video. Prefer the SOURCE asset id from object_story_spec.video_data — that's
      // the underlying uploaded video. The top-level creative.video_id is a per-ad derivative,
      // so using it splits ads that actually share the same source video into separate cards.
      const sourceVideoId = videoData?.video_id || creative?.video_id;
      if (sourceVideoId) {
        const thumb = unscaleMetaImage(videoData?.image_url || creative?.thumbnail_url || creative?.image_url);
        perSlide.push({
          assetKey: `video:${sourceVideoId}`,
          type: 'video',
          thumbnail: thumb,
          videoId: sourceVideoId,
          body: adBody,
          title: adTitle,
          adId: ins.ad_id,
          adName: ins.ad_name || '(unnamed)',
          campaignName: ins.campaign_name || '',
          status: ad?.effective_status || ins.effective_status || 'UNKNOWN',
          spend, results, impressions, linkClicks, reach,
          weight: 1,
        });
        continue;
      }

      // CASE 3: single image.
      if (creative?.image_hash || creative?.image_url || linkData?.picture) {
        const hash = creative?.image_hash;
        const thumb = unscaleMetaImage(linkData?.picture || creative?.image_url || creative?.thumbnail_url);
        const key = hash ? `image:${hash}` : `creative:${creative?.id || ins.ad_id}`;
        perSlide.push({
          assetKey: key,
          type: 'image',
          thumbnail: thumb,
          videoId: null,
          body: adBody,
          title: adTitle,
          adId: ins.ad_id,
          adName: ins.ad_name || '(unnamed)',
          campaignName: ins.campaign_name || '',
          status: ad?.effective_status || ins.effective_status || 'UNKNOWN',
          spend, results, impressions, linkClicks, reach,
          weight: 1,
        });
        continue;
      }

      // CASE 4: thumbnail-only image (DCO output, or older creatives with neither image_hash
      // nor video_id set). The thumbnail URL is signed and ephemeral, so strip the query
      // string and use the path as the asset key — same image = same path.
      if (creative?.thumbnail_url) {
        let key = creative.thumbnail_url;
        try { const u = new URL(creative.thumbnail_url); key = `thumb:${u.pathname}`; } catch { /* keep raw */ }
        perSlide.push({
          assetKey: key,
          type: 'image',
          thumbnail: unscaleMetaImage(creative.thumbnail_url),
          videoId: null,
          body: adBody,
          title: adTitle,
          adId: ins.ad_id,
          adName: ins.ad_name || '(unnamed)',
          campaignName: ins.campaign_name || '',
          status: ad?.effective_status || ins.effective_status || 'UNKNOWN',
          spend, results, impressions, linkClicks, reach,
          weight: 1,
        });
        continue;
      }

      // CASE 5: truly unknown / DCO with nothing to render — group by creative_id last.
      perSlide.push({
        assetKey: `creative:${creative?.id || ins.ad_id}`,
        type: 'unknown',
        thumbnail: null,
        videoId: null,
        body: adBody,
        title: adTitle,
        adId: ins.ad_id,
        adName: ins.ad_name || '(unnamed)',
        campaignName: ins.campaign_name || '',
        status: ad?.effective_status || ins.effective_status || 'UNKNOWN',
        spend, results, impressions, linkClicks, reach,
        weight: 1,
      });
    }

    // Aggregate slides into CreativeRow.
    const grouped = new Map<string, CreativeRow>();
    for (const s of perSlide) {
      let row = grouped.get(s.assetKey);
      if (!row) {
        row = {
          assetKey: s.assetKey,
          type: s.type,
          thumbnail: s.thumbnail,
          videoSource: null,
          videoId: s.videoId,
          body: s.body,
          title: s.title,
          sampleAdName: s.adName,
          sampleAdId: s.adId,
          spend: 0, results: 0, impressions: 0, linkClicks: 0, reach: 0,
          ctr: 0, cpl: 0,
          ads: [],
        };
        grouped.set(s.assetKey, row);
      }
      // Backfill thumbnail and copy if a later slide has them and the earlier didn't.
      if (!row.thumbnail && s.thumbnail) row.thumbnail = s.thumbnail;
      if (!row.videoId && s.videoId) row.videoId = s.videoId;
      if (!row.body && s.body) row.body = s.body;
      if (!row.title && s.title) row.title = s.title;
      row.spend += s.spend;
      row.results += s.results;
      row.impressions += s.impressions;
      row.linkClicks += s.linkClicks;
      row.reach += s.reach;
      // Avoid double-counting the same ad in `ads` when a carousel splits multiple slides:
      // each slide is its own row, but its `ads` should still surface the parent ad once.
      if (!row.ads.find(a => a.id === s.adId)) {
        row.ads.push({
          id: s.adId,
          name: s.adName,
          status: s.status,
          spend: s.spend / (s.weight || 1),
          results: s.results / (s.weight || 1),
          impressions: s.impressions / (s.weight || 1),
          linkClicks: s.linkClicks / (s.weight || 1),
        });
      }
    }

    // Derived metrics + rounding.
    const rows = Array.from(grouped.values()).map(r => {
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

    // Fetch sharper image URLs for any asset grouped by image_hash. Meta's /adimages
    // endpoint returns `url` (full-res, permanent) for each hash in one batched call per
    // account. This replaces the blurry 64x64 thumbnail we get from /ads?fields=creative.
    const imageHashes = Array.from(new Set(
      rows
        .filter(r => r.assetKey.startsWith('image:'))
        .map(r => r.assetKey.slice('image:'.length))
        .filter(h => /^[a-f0-9]{20,}$/i.test(h)) // sanity: Meta hashes are long hex
    ));
    // For creatives where Meta didn't return image_hash (DCO/Advantage+ ads use asset_feed_spec
    // instead of a single image_hash on the parent creative), fetch the spec to extract the
    // actual hashes. We then assign those rows an `image:<hash>` key so the batch adimages
    // lookup below can fetch full-resolution URLs for them.
    const thumbOnlyRows = rows.filter(r => r.assetKey.startsWith('thumb:'));
    if (thumbOnlyRows.length > 0) {
      // Find the originating creative_id for each thumb-only row by walking the ads list.
      // Multiple ads can share a row, but they all point at the same thumbnail/creative family.
      const creativeIdsByRowKey = new Map<string, string>();
      for (const r of thumbOnlyRows) {
        const adId = r.sampleAdId;
        const ad = creativeByAdId.get(adId);
        if (ad?.creative?.id) creativeIdsByRowKey.set(r.assetKey, ad.creative.id);
      }
      const uniqueCreativeIds = Array.from(new Set(creativeIdsByRowKey.values()));
      await Promise.all(uniqueCreativeIds.map(async cid => {
        try {
          const u = `https://graph.facebook.com/v22.0/${cid}?fields=asset_feed_spec&access_token=${token}`;
          const res = await fetch(u);
          const json = await res.json() as { asset_feed_spec?: { images?: { hash?: string }[] } };
          const firstHash = json.asset_feed_spec?.images?.[0]?.hash;
          if (firstHash && /^[a-f0-9]{20,}$/i.test(firstHash)) {
            // Promote every row pointing at this creative to use the hash key.
            creativeIdsByRowKey.forEach((mappedCid, rowKey) => {
              if (mappedCid !== cid) return;
              const row = rows.find(r => r.assetKey === rowKey);
              if (row) {
                row.assetKey = `image:${firstHash}`;
                imageHashes.push(firstHash);
              }
            });
          }
        } catch { /* leave row as thumb: */ }
      }));
    }

    if (imageHashes.length > 0) {
      try {
        const u = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/adimages`);
        u.searchParams.set('hashes', JSON.stringify(Array.from(new Set(imageHashes))));
        u.searchParams.set('fields', 'hash,url,permalink_url');
        u.searchParams.set('access_token', token);
        const res = await fetch(u.toString());
        const json = await res.json() as { data?: { hash?: string; url?: string; permalink_url?: string }[] };
        const hashToUrl = new Map<string, string>();
        for (const img of json.data || []) {
          if (img.hash && (img.url || img.permalink_url)) {
            hashToUrl.set(img.hash, (img.url || img.permalink_url) as string);
          }
        }
        for (const r of rows) {
          if (r.assetKey.startsWith('image:')) {
            const hash = r.assetKey.slice('image:'.length);
            const better = hashToUrl.get(hash);
            if (better) r.thumbnail = better;
          }
        }
      } catch { /* ignore — thumbnails stay at the blurry version */ }
    }

    // Fetch playable video source URLs in parallel for each unique videoId.
    // Meta returns a signed mp4 in `source`. The bare /<vid> endpoint fails
    // with GraphMethodException (code 100, subcode 33) when the video lives in
    // a different ad account than our token — fall back to the account-scoped
    // advideos endpoint, which resolves cross-account references in many cases.
    type VideoFields = {
      source?: string;
      picture?: string;
      error?: { code?: number; error_subcode?: number };
    };
    const fetchVideoFields = async (path: string): Promise<VideoFields> => {
      try {
        const u = `https://graph.facebook.com/v22.0/${path}?fields=source,picture&access_token=${token}`;
        const res = await fetch(u);
        return await res.json() as VideoFields;
      } catch { return {}; }
    };
    const videoIds = Array.from(new Set(
      rows.filter(r => r.type === 'video' && r.videoId).map(r => r.videoId as string)
    ));
    const videoSources = new Map<string, string>();
    const videoPosters = new Map<string, string>();
    // Batch the per-video lookups via ?ids= to keep request count low for
    // accounts with many videos. ceil(N/50) calls instead of N.
    const VIDEO_IDS_CHUNK = 50;
    const firstResults = new Map<string, VideoFields>();
    for (let i = 0; i < videoIds.length; i += VIDEO_IDS_CHUNK) {
      const chunk = videoIds.slice(i, i + VIDEO_IDS_CHUNK);
      try {
        const u = new URL('https://graph.facebook.com/v22.0/');
        u.searchParams.set('ids', chunk.join(','));
        u.searchParams.set('fields', 'source,picture');
        u.searchParams.set('access_token', token);
        const res = await fetch(u.toString());
        const json = await res.json() as Record<string, VideoFields> & { error?: { code?: number; error_subcode?: number } };
        if (json.error) {
          for (const vid of chunk) firstResults.set(vid, { error: json.error });
          continue;
        }
        for (const vid of chunk) {
          if (json[vid]) firstResults.set(vid, json[vid]);
        }
      } catch {
        for (const vid of chunk) firstResults.set(vid, {});
      }
    }
    await Promise.all(videoIds.map(async vid => {
      const first = firstResults.get(vid) || {};
      if (first.source) videoSources.set(vid, first.source);
      if (first.picture) videoPosters.set(vid, first.picture);
      // If the bare lookup failed auth or returned no source, try the
      // account-scoped advideos endpoint (can't be batched the same way).
      const failedAuth = first.error?.code === 100 && first.error?.error_subcode === 33;
      if (!first.source && (failedAuth || !first.picture)) {
        const second = await fetchVideoFields(`act_${accountId}/advideos/${vid}`);
        if (!videoSources.has(vid) && second.source) videoSources.set(vid, second.source);
        if (!videoPosters.has(vid) && second.picture) videoPosters.set(vid, second.picture);
      }
    }));
    for (const r of rows) {
      if (r.type !== 'video' || !r.videoId) continue;
      if (videoSources.has(r.videoId)) r.videoSource = videoSources.get(r.videoId) as string;
      if (!r.thumbnail && videoPosters.has(r.videoId)) r.thumbnail = videoPosters.get(r.videoId) as string;
    }

    return NextResponse.json({ data: rows });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
