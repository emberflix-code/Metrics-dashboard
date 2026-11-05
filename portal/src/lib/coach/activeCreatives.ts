// Active Meta ads of one client, grouped by creative (image / video), for the
// coach board's Ads drawer. Cache only: meta_entities (status), meta_ad_copy
// (texts), meta_creative_asset_ad_map + meta_creative_assets (which image /
// video, stored thumbnail). Same campaign scope as the client's dashboard
// (ad_account_ids + campaign_filter). Never calls Meta.
import { query } from '../db';
import { matchesCampaignFilter } from '../meta';

export interface ActiveCreative {
  key: string;                 // asset_key, or 'ad:<id>' when the ad has no mapped asset
  accountId: string;
  type: 'image' | 'video' | 'unknown';
  hasThumbnail: boolean;       // stored bytes → /api/meta/db/asset-thumbnail/<account>/<asset_key>
  adCount: number;
  campaigns: string[];
  adNames: string[];
  bodies: string[];            // distinct primary texts across its ads
  titles: string[];            // headlines
  descriptions: string[];
  links: string[];
  ctas: string[];
  isDco: boolean;
  /** Spend on this creative in the last 14 days (DCO per-creative breakdown); null when Meta has no per-creative split for it. */
  spend14: number | null;
}

export interface ActiveCreativesResult {
  creatives: ActiveCreative[];
  activeAds: number;
  adsWithoutCopy: number;
  creativesWithoutThumbnail: number;
  copySyncedAt: string | null;
}

type Row = {
  account_id: string; ad_id: string; ad_name: string; campaign_name: string | null;
  bodies: { text: string }[] | null; titles: { text: string }[] | null; descriptions: { text: string }[] | null;
  link_urls: unknown[] | null; cta_types: string[] | null; is_dco: boolean | null; fetched_at: string | null;
  asset_key: string | null; asset_type: string | null; has_bytes: boolean | null;
};

const texts = (a: { text: string }[] | null) => (a || []).map(x => (x?.text || '').trim()).filter(Boolean);
const linkText = (v: unknown) => (typeof v === 'string' ? v : (v as { url?: string; link?: string })?.url || (v as { link?: string })?.link || '');

export async function loadActiveCreatives(accountIds: string[], campaignFilter: string): Promise<ActiveCreativesResult> {
  const empty: ActiveCreativesResult = { creatives: [], activeAds: 0, adsWithoutCopy: 0, creativesWithoutThumbnail: 0, copySyncedAt: null };
  const ids = accountIds.map(a => a.replace(/^act_/i, '')).filter(Boolean);
  if (ids.length === 0) return empty;
  // 1) Campaigns with running ads, narrowed to this client's campaign filter
  //    (shared accounts like Alloy's hold hundreds of other clubs' ads).
  const camps = await query<{ account_id: string; campaign_id: string; campaign_name: string | null }>(
    `SELECT DISTINCT account_id, campaign_id, campaign_name FROM meta_entities
     WHERE account_id = ANY($1) AND level = 'ad' AND effective_status = 'ACTIVE' AND campaign_id IS NOT NULL`,
    [ids]
  );
  const keep = camps.filter(c => matchesCampaignFilter(c.campaign_name || '', campaignFilter, c.account_id));
  if (keep.length === 0) return empty;
  // 2) Only those campaigns' ads, with copy and creative (bytes never selected, just their presence).
  const scoped = await query<Row>(
    `SELECT e.account_id, e.entity_id AS ad_id, e.name AS ad_name, e.campaign_name,
            c.bodies, c.titles, c.descriptions, c.link_urls, c.cta_types, c.is_dco, c.fetched_at,
            m.asset_key, a.type AS asset_type, (a.thumbnail_bytes IS NOT NULL) AS has_bytes
     FROM meta_entities e
     JOIN unnest($1::text[], $2::text[]) AS k(account_id, campaign_id) ON k.account_id = e.account_id AND k.campaign_id = e.campaign_id
     LEFT JOIN meta_ad_copy c ON c.account_id = e.account_id AND c.ad_id = e.entity_id
     LEFT JOIN meta_creative_asset_ad_map m ON m.account_id = e.account_id AND m.ad_id = e.entity_id
     LEFT JOIN meta_creative_assets a ON a.account_id = m.account_id AND a.asset_key = m.asset_key
     WHERE e.level = 'ad' AND e.effective_status = 'ACTIVE'`,
    [keep.map(c => c.account_id), keep.map(c => c.campaign_id)]
  );
  if (scoped.length === 0) return empty;

  // The ad→creative map keeps every creative an ad has EVER delivered (DCO
  // ads rotate many), so it overstates what's running. Where the ad has
  // per-creative delivery in the last 14 days, keep only those creatives
  // (with their 14-day spend); otherwise keep all mapped ones.
  const adIds = Array.from(new Set(scoped.map(r => r.ad_id)));
  const recent = await query<{ account_id: string; ad_id: string; asset_key: string; spend: string; impressions: string }>(
    `SELECT account_id, ad_id, asset_key, SUM(spend)::text AS spend, SUM(impressions)::text AS impressions
     FROM meta_asset_breakdown_daily
     WHERE account_id = ANY($1) AND ad_id = ANY($2) AND date >= CURRENT_DATE - 14
     GROUP BY account_id, ad_id, asset_key HAVING SUM(impressions) > 0`,
    [Array.from(new Set(scoped.map(r => r.account_id))), adIds]
  );
  const recentByAd = new Map<string, Map<string, number>>();
  for (const r of recent) {
    const k = `${r.account_id}|${r.ad_id}`;
    const m = recentByAd.get(k) ?? new Map<string, number>();
    m.set(r.asset_key, Number(r.spend) || 0);
    recentByAd.set(k, m);
  }
  const spend14 = new Map<string, number>();
  const current = scoped.filter(r => {
    const m = recentByAd.get(`${r.account_id}|${r.ad_id}`);
    if (!m || !r.asset_key) return true;
    if (!m.has(r.asset_key)) return false;
    const gk = `${r.account_id}|${r.asset_key}`;
    spend14.set(gk, (spend14.get(gk) || 0) + (m.get(r.asset_key) || 0));
    return true;
  });

  const groups = new Map<string, ActiveCreative & { _ads: Set<string> }>();
  const adsSeen = new Set<string>();
  const adsNoCopy = new Set<string>();
  let copySyncedAt: string | null = null;
  const addUnique = (arr: string[], vals: string[]) => { for (const v of vals) if (v && !arr.includes(v)) arr.push(v); };

  for (const r of scoped) {
    const adKey = `${r.account_id}|${r.ad_id}`;
    adsSeen.add(adKey);
    if (r.bodies === null) adsNoCopy.add(adKey);
    if (r.fetched_at && (!copySyncedAt || r.fetched_at > copySyncedAt)) copySyncedAt = r.fetched_at;
  }
  for (const r of current) {
    const adKey = `${r.account_id}|${r.ad_id}`;
    const key = r.asset_key ? `${r.account_id}|${r.asset_key}` : `${r.account_id}|ad:${r.ad_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key: r.asset_key || `ad:${r.ad_id}`, accountId: r.account_id,
        type: r.asset_type === 'image' || r.asset_type === 'video' ? r.asset_type : 'unknown',
        hasThumbnail: !!r.has_bytes, adCount: 0, campaigns: [], adNames: [], bodies: [], titles: [], descriptions: [], links: [], ctas: [],
        isDco: false, spend14: r.asset_key && spend14.has(`${r.account_id}|${r.asset_key}`) ? Math.round(spend14.get(`${r.account_id}|${r.asset_key}`)! * 100) / 100 : null, _ads: new Set(),
      };
      groups.set(key, g);
    }
    if (!g._ads.has(adKey)) { g._ads.add(adKey); g.adCount++; }
    addUnique(g.campaigns, [r.campaign_name || '']);
    addUnique(g.adNames, [r.ad_name]);
    addUnique(g.bodies, texts(r.bodies));
    addUnique(g.titles, texts(r.titles));
    addUnique(g.descriptions, texts(r.descriptions));
    addUnique(g.links, (r.link_urls || []).map(linkText).filter(Boolean));
    addUnique(g.ctas, (r.cta_types || []).map(c => c.replace(/_/g, ' ').toLowerCase()));
    if (r.is_dco) g.isDco = true;
  }

  const creatives = Array.from(groups.values())
    .map(({ _ads, ...g }) => { void _ads; return g; })
    .sort((a, b) => (b.spend14 ?? -1) - (a.spend14 ?? -1) || b.adCount - a.adCount || a.key.localeCompare(b.key));
  return {
    creatives,
    activeAds: adsSeen.size,
    adsWithoutCopy: adsNoCopy.size,
    creativesWithoutThumbnail: creatives.filter(c => c.type !== 'unknown' && !c.hasThumbnail).length,
    copySyncedAt,
  };
}
