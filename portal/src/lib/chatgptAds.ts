// ChatGPT Ads (OpenAI Ads Manager) — read-only sync + reads for the client's
// /dashboard/chatgpt view. API: https://api.ads.openai.com/v1, Bearer key that
// is scoped to ONE ad account (the key alone identifies the account).
//   - Entities: GET /campaigns, /ad_groups, /ads (each ad carries its creative:
//     title, body, link, image file). Images are fetched via GET /ads/{id}
//     (image_url is a signed link that expires within a day) and stored as bytes.
//   - Numbers: GET /ad_account/insights, aggregation_level=ad, daily, in the
//     account's own timezone (the API default). spend is in major currency
//     units (12.50 = $12.50). `conversions` = the account's pixel/conversion
//     events attributed to the ad (shown as Leads).
import sharp from 'sharp';
import { query } from './db';
import { decrypt } from './crypto';

const BASE = 'https://api.ads.openai.com/v1';
const FIRST_SYNC_DAYS = 365;  // non-hourly delivery reporting retention
const RESYNC_OVERLAP_DAYS = 7; // spend/conversions settle late; re-pull the last week every run
const IMAGE_MAX_WIDTH = 900;

export interface ChatgptAdDailyRow {
  date: string;          // YYYY-MM-DD, account timezone
  adId: string;
  adName: string;
  adGroupId: string;
  adGroupName: string;
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
}
export interface ChatgptEntity {
  id: string;
  level: 'campaign' | 'ad_group' | 'ad';
  name: string;
  status: string;
  parentId: string;
  reviewStatus: string;
  creativeType: string;
  title: string;
  body: string;
  targetUrl: string;
  hasImage: boolean;
  imageCrop: { x: number; y: number; width: number; height: number } | null;
}

async function api<T>(key: string, path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise(r => setTimeout(r, 5000 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`ChatGPT Ads API ${res.status}: ${text.split(key).join('<key>').slice(0, 300)}`);
    return JSON.parse(text) as T;
  }
}

interface ListPage<T> { data?: T[]; has_more?: boolean; last_id?: string }
async function listAll<T>(key: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const p = await api<ListPage<T>>(key, path + (after ? `${sep}after=${encodeURIComponent(after)}` : ''));
    out.push(...(p.data || []));
    if (!p.has_more || !p.last_id) break;
    after = p.last_id;
  }
  return out;
}

/** YYYY-MM-DD of `daysAgo` days before today in `timeZone`. */
function dateInTz(timeZone: string, daysAgo: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

interface AccountInfo { id: string; name?: string; account_name?: string; timezone?: string }
interface ApiCampaign { id: string; name?: string; status?: string }
interface ApiAdGroup { id: string; name?: string; status?: string; campaign_id?: string }
interface ApiCreative { type?: string; title?: string; body?: string; target_url?: string; file_id?: string; image_url?: string; image_crop?: unknown }
interface ApiAd { id: string; name?: string; status?: string; ad_group_id?: string; review_status?: string; creative?: ApiCreative }
interface InsightRow {
  ad_id?: string; ad_name?: string; ad_group_id?: string; ad_group_name?: string; campaign_id?: string; campaign_name?: string;
  readable_time?: string; impressions?: number | null; clicks?: number | null; spend?: number | string | null; conversions?: number | null;
}

async function upsertEntity(accountId: string, e: { id: string; level: string; name: string; status: string; parentId: string; reviewStatus?: string; creative?: ApiCreative }) {
  const c = e.creative || {};
  await query(
    `INSERT INTO chatgpt_ads_entities (account_id, id, level, name, status, parent_id, review_status, creative_type, title, body, target_url, file_id, image_crop, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (account_id, id) DO UPDATE SET level = $3, name = $4, status = $5, parent_id = $6, review_status = $7,
       creative_type = $8, title = $9, body = $10, target_url = $11, image_crop = $13, updated_at = now(),
       -- a new image file invalidates the stored bytes
       file_id = $12,
       image_bytes = CASE WHEN chatgpt_ads_entities.file_id = $12 THEN chatgpt_ads_entities.image_bytes ELSE NULL END`,
    [accountId, e.id, e.level, e.name, e.status, e.parentId, e.reviewStatus || '', c.type || '', c.title || '', c.body || '', c.target_url || '', c.file_id || '',
      c.image_crop ? JSON.stringify(c.image_crop) : null]);
}

async function storeAdImage(key: string, accountId: string, adId: string): Promise<boolean> {
  const ad = await api<ApiAd>(key, `/ads/${encodeURIComponent(adId)}`);
  const url = ad.creative?.image_url;
  if (!url) return false;
  const res = await fetch(url);
  if (!res.ok) return false;
  let bytes: Buffer = Buffer.from(await res.arrayBuffer());
  let type = res.headers.get('content-type') || 'image/jpeg';
  const meta = await sharp(bytes).metadata().catch(() => null);
  if (meta?.width && meta.width > IMAGE_MAX_WIDTH) {
    bytes = await sharp(bytes).resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    type = 'image/jpeg';
  }
  await query(`UPDATE chatgpt_ads_entities SET image_bytes = $3, image_content_type = $4 WHERE account_id = $1 AND id = $2`, [accountId, adId, bytes, type]);
  return true;
}

/** Sync one client's ChatGPT ad account through yesterday (account TZ). */
export async function syncChatgptAdsClient(clientId: string): Promise<{ accountId: string; rows: number; ads: number; imagesStored: number; since: string; until: string } | { error: string }> {
  const [c] = await query<{ chatgpt_ads_key_enc: string }>(`SELECT chatgpt_ads_key_enc FROM clients WHERE id = $1`, [clientId]);
  if (!c?.chatgpt_ads_key_enc) return { error: 'no ChatGPT Ads key on client' };
  const key = decrypt(c.chatgpt_ads_key_enc);
  let accountId = '';
  try {
    const acct = await api<AccountInfo>(key, '/ad_account');
    accountId = acct.id;
    const tz = acct.timezone || 'UTC';
    await query(`UPDATE clients SET chatgpt_ads_account_id = $2 WHERE id = $1 AND chatgpt_ads_account_id <> $2`, [clientId, accountId]);
    const [state] = await query<{ last_success_until: string | null }>(
      `SELECT last_success_until::text FROM chatgpt_ads_sync_state WHERE account_id = $1`, [accountId]);
    await query(
      `INSERT INTO chatgpt_ads_sync_state (account_id, account_name, time_zone, status) VALUES ($1, $2, $3, 'running')
       ON CONFLICT (account_id) DO UPDATE SET account_name = $2, time_zone = $3, status = 'running'`,
      [accountId, acct.account_name || acct.name || '', tz]);

    // 1) Entities + creatives
    const [campaigns, adGroups, ads] = await Promise.all([
      listAll<ApiCampaign>(key, '/campaigns'),
      listAll<ApiAdGroup>(key, '/ad_groups'),
      listAll<ApiAd>(key, '/ads'),
    ]);
    for (const x of campaigns) await upsertEntity(accountId, { id: x.id, level: 'campaign', name: x.name || '', status: x.status || '', parentId: '' });
    for (const x of adGroups) await upsertEntity(accountId, { id: x.id, level: 'ad_group', name: x.name || '', status: x.status || '', parentId: x.campaign_id || '' });
    for (const x of ads) await upsertEntity(accountId, { id: x.id, level: 'ad', name: x.name || '', status: x.status || '', parentId: x.ad_group_id || '', reviewStatus: x.review_status, creative: x.creative });

    // 2) Daily ad-level numbers
    const until = dateInTz(tz, 1);
    const floor = dateInTz(tz, FIRST_SYNC_DAYS);
    let since = state?.last_success_until ? addDays(state.last_success_until, -RESYNC_OVERLAP_DAYS) : floor;
    if (since < floor) since = floor;
    if (since > until) since = until;
    const timeRange = JSON.stringify({ type: 'date_range', since, until });
    const fields = ['ad_id', 'ad_name', 'ad_group_id', 'ad_group_name', 'campaign_id', 'campaign_name', 'readable_time', 'impressions', 'clicks', 'spend', 'conversions'];
    const rows = await listAll<InsightRow>(key, `/ad_account/insights?aggregation_level=ad&time_granularity=daily&limit=2000`
      + `&time_ranges[]=${encodeURIComponent(timeRange)}` + fields.map(f => `&fields[]=${f}`).join(''));
    for (const r of rows) {
      if (!r.ad_id || !r.readable_time) continue;
      await query(
        `INSERT INTO chatgpt_ads_ad_daily (account_id, ad_id, date, campaign_id, campaign_name, ad_group_id, ad_group_name, ad_name, impressions, clicks, spend, conversions, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (account_id, ad_id, date) DO UPDATE SET
           campaign_id = EXCLUDED.campaign_id, campaign_name = EXCLUDED.campaign_name, ad_group_id = EXCLUDED.ad_group_id,
           ad_group_name = EXCLUDED.ad_group_name, ad_name = EXCLUDED.ad_name, impressions = EXCLUDED.impressions,
           clicks = EXCLUDED.clicks, spend = EXCLUDED.spend, conversions = EXCLUDED.conversions, synced_at = now()`,
        [accountId, r.ad_id, r.readable_time.slice(0, 10), r.campaign_id || '', r.campaign_name || '', r.ad_group_id || '', r.ad_group_name || '',
          r.ad_name || '', r.impressions || 0, r.clicks || 0, Number(r.spend) || 0, r.conversions || 0]);
    }

    // 3) Creative images not stored yet (new ads, or the image file changed)
    let imagesStored = 0;
    const missing = await query<{ id: string }>(
      `SELECT id FROM chatgpt_ads_entities WHERE account_id = $1 AND level = 'ad' AND file_id <> '' AND image_bytes IS NULL`, [accountId]);
    for (const m of missing) {
      try { if (await storeAdImage(key, accountId, m.id)) imagesStored++; } catch { /* retried next run */ }
    }

    await query(
      `UPDATE chatgpt_ads_sync_state SET status = 'idle', last_success_until = $2, last_synced_at = now(), last_error = NULL WHERE account_id = $1`,
      [accountId, until]);
    return { accountId, rows: rows.length, ads: ads.length, imagesStored, since, until };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (accountId) await query(`UPDATE chatgpt_ads_sync_state SET status = 'error', last_error = $2 WHERE account_id = $1`, [accountId, message]).catch(() => {});
    return { error: message };
  }
}

/** Every client with a ChatGPT Ads key (daily scheduler). */
export async function getChatgptAdsClientIds(): Promise<string[]> {
  return (await query<{ id: string }>(`SELECT id FROM clients WHERE chatgpt_ads_key_enc <> ''`)).map(r => r.id);
}

/** All cached ad-level daily rows + entities for one account, and how far the cache reaches. */
export async function getChatgptDashboardData(accountId: string): Promise<{ rows: ChatgptAdDailyRow[]; entities: ChatgptEntity[]; syncedThrough: string | null; timeZone: string | null }> {
  const rows = await query<{ date: string; ad_id: string; ad_name: string; ad_group_id: string; ad_group_name: string; campaign_id: string; campaign_name: string; impressions: string; clicks: string; spend: string; conversions: string }>(
    `SELECT date::text, ad_id, ad_name, ad_group_id, ad_group_name, campaign_id, campaign_name,
            impressions::text, clicks::text, spend::text, conversions::text
     FROM chatgpt_ads_ad_daily WHERE account_id = $1 ORDER BY date`, [accountId]);
  const ents = await query<{ id: string; level: ChatgptEntity['level']; name: string; status: string; parent_id: string; review_status: string; creative_type: string; title: string; body: string; target_url: string; has_image: boolean; image_crop: ChatgptEntity['imageCrop'] }>(
    `SELECT id, level, name, status, parent_id, review_status, creative_type, title, body, target_url,
            (image_bytes IS NOT NULL) AS has_image, image_crop
     FROM chatgpt_ads_entities WHERE account_id = $1`, [accountId]);
  const [s] = await query<{ last_success_until: string | null; time_zone: string | null }>(
    `SELECT last_success_until::text, time_zone FROM chatgpt_ads_sync_state WHERE account_id = $1`, [accountId]);
  return {
    rows: rows.map(r => ({
      date: r.date, adId: r.ad_id, adName: r.ad_name, adGroupId: r.ad_group_id, adGroupName: r.ad_group_name,
      campaignId: r.campaign_id, campaignName: r.campaign_name,
      impressions: Number(r.impressions), clicks: Number(r.clicks), spend: Number(r.spend), conversions: Number(r.conversions),
    })),
    entities: ents.map(e => ({
      id: e.id, level: e.level, name: e.name, status: e.status, parentId: e.parent_id, reviewStatus: e.review_status,
      creativeType: e.creative_type, title: e.title, body: e.body, targetUrl: e.target_url, hasImage: e.has_image, imageCrop: e.image_crop,
    })),
    syncedThrough: s?.last_success_until ?? null,
    timeZone: s?.time_zone ?? null,
  };
}

/** Stored creative image of one ad (scoped by account). */
export async function getChatgptAdImage(accountId: string, adId: string): Promise<{ bytes: Buffer; type: string } | null> {
  const [r] = await query<{ image_bytes: Buffer | null; image_content_type: string }>(
    `SELECT image_bytes, image_content_type FROM chatgpt_ads_entities WHERE account_id = $1 AND id = $2 AND level = 'ad'`, [accountId, adId]);
  return r?.image_bytes ? { bytes: r.image_bytes, type: r.image_content_type || 'image/jpeg' } : null;
}
