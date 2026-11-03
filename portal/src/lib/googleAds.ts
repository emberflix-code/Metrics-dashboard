// Google Ads API (read-only) — daily campaign metrics cached in Postgres.
//
// Mirrors the Meta cache design: the daily scheduler pulls every campaign x
// day for each Google Ads account a client uses (clients.google_ads_customer_ids)
// into google_ads_daily, and the client's Google dashboard reads from there
// (/api/google-ads/daily) instead of a Google Sheet tab. Selected per client
// with clients.google_data_source = 'api'; 'sheet' keeps the old tab path.
//
// Access model (verified 2026-10-31, see project memory): Cloud-console OAuth
// app at Basic access, NO developer-token header (an empty one fails with
// DEVELOPER_TOKEN_PARAMETER_MISSING), and account 989-891-4148 is queried
// directly without login-customer-id. API use is declared read-only in the
// access application — this module only ever calls googleAds:search.
//
// Conversions: Leads / Joins / Bookings come from metrics.all_conversions
// segmented by conversion_action_category (SUBMIT_LEAD_FORM / PURCHASE /
// BOOK_APPOINTMENT). all_conversions rather than conversions because Join
// Online and Book a Tour are secondary actions in this account — primary-
// only `conversions` would always report 0 for them. Lead-form actions are
// primary, so Leads equals the Google Ads UI "Conversions" column. Values
// are fractional (data-driven attribution), dated by interaction date like
// the UI, and keep changing for weeks after the click — hence the trailing
// RESYNC_DAYS window re-pulled on every run.
import { query, pool } from './db';
import { matchesCampaignFilter } from './meta';

const API_VERSION = 'v23'; // v22 returns UNSUPPORTED_VERSION; v23-v26 verified
const BACKFILL_FLOOR = '2026-01-01';
const RESYNC_DAYS = 30;

export class GoogleAdsError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}

export function normalizeCustomerId(id: string): string {
  return String(id).replace(/\D/g, '');
}

let _token: { value: string; expires: number } | null = null;

async function accessToken(): Promise<string> {
  if (_token && _token.expires > Date.now() + 60_000) return _token.value;
  const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN) {
    throw new GoogleAdsError('Google Ads API credentials are not configured.', 500);
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_ADS_CLIENT_ID,
      client_secret: GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // invalid_grant = refresh token revoked/expired (e.g. OAuth app left in
    // "Testing" publishing status, which expires refresh tokens after 7 days).
    throw new GoogleAdsError(`Google OAuth token refresh failed: ${json.error || res.status}`, 502);
  }
  _token = { value: json.access_token, expires: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
  return _token.value;
}

// GAQL search results, camelCased by the REST API. Only the fields the
// queries below select; int64 metrics arrive as strings.
interface GaqlRow {
  customer?: { timeZone?: string };
  campaign?: { id?: string; name?: string; status?: string };
  adGroup?: { id?: string };
  adGroupCriterion?: { criterionId?: string; keyword?: { text?: string; matchType?: string } };
  adGroupAdAssetView?: { fieldType?: string };
  adGroupAd?: { ad?: { finalUrls?: string[] } };
  asset?: { id?: string; textAsset?: { text?: string } };
  conversionAction?: { id?: string; category?: string };
  segments?: { date?: string; conversionActionCategory?: string; conversionAction?: string };
  metrics?: { costMicros?: string; impressions?: string; clicks?: string; allConversions?: number };
}

// GAQL search with pagination (page size is fixed server-side at 10,000).
async function search<T = GaqlRow>(customerId: string, gaql: string): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(pageToken ? { query: gaql, pageToken } : { query: gaql }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = json?.error?.details?.[0]?.errors?.[0]?.message || json?.error?.message || String(res.status);
      throw new GoogleAdsError(`Google Ads API error for ${customerId}: ${detail}`, res.status >= 500 ? 502 : res.status);
    }
    out.push(...(json.results || []));
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

function ymdInTimezone(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const CONVERSION_COLUMN: Record<string, 'leads' | 'joins' | 'bookings'> = {
  SUBMIT_LEAD_FORM: 'leads',
  PURCHASE: 'joins',
  BOOK_APPOINTMENT: 'bookings',
};

// Daily metric accumulator shared by the campaign, keyword and asset passes.
interface Metrics { cost: number; impressions: number; clicks: number; leads: number; joins: number; bookings: number }
function emptyMetrics(): Metrics { return { cost: 0, impressions: 0, clicks: 0, leads: 0, joins: 0, bookings: 0 }; }
function addBase(m: Metrics, r: GaqlRow) {
  m.cost += Number(r.metrics?.costMicros || 0) / 1e6;
  m.impressions += Number(r.metrics?.impressions || 0);
  m.clicks += Number(r.metrics?.clicks || 0);
}
function hasData(m: Metrics) { return !!(m.cost || m.impressions || m.clicks || m.leads || m.joins || m.bookings); }
function metricArrays(rows: Metrics[]) {
  return [rows.map(r => r.cost.toFixed(6)), rows.map(r => r.impressions), rows.map(r => r.clicks),
    rows.map(r => r.leads.toFixed(6)), rows.map(r => r.joins.toFixed(6)), rows.map(r => r.bookings.toFixed(6))];
}
const INSERT_CHUNK = 5000;

export interface GoogleSyncResult {
  customerId: string;
  since?: string;
  until?: string;
  rows?: number;
  keywordRows?: number;
  assetRows?: number;
  campaigns?: number;
  skipped?: string;
  error?: string;
}

// Syncs one Google Ads account through yesterday in the account's own
// timezone. First run backfills from BACKFILL_FLOOR; later runs re-pull the
// trailing RESYNC_DAYS so late-arriving conversions land.
export async function syncGoogleAdsCustomer(rawCustomerId: string): Promise<GoogleSyncResult> {
  const customerId = normalizeCustomerId(rawCustomerId);
  const claimed = await query<{ customer_id: string }>(
    `INSERT INTO google_ads_sync_state (customer_id, status, last_run_started_at)
     VALUES ($1, 'running', now())
     ON CONFLICT (customer_id) DO UPDATE SET status = 'running', last_run_started_at = now()
       WHERE google_ads_sync_state.status <> 'running' OR google_ads_sync_state.last_run_started_at < now() - interval '1 hour'
     RETURNING customer_id`,
    [customerId]
  );
  if (claimed.length === 0) return { customerId, skipped: 'already running' };

  try {
    const [cust] = await search(customerId, 'SELECT customer.time_zone FROM customer');
    const timeZone = cust?.customer?.timeZone || 'America/New_York';
    const until = addDays(ymdInTimezone(new Date(), timeZone), -1);
    const [state] = await query<{ last_success_until: string | null }>(
      `SELECT to_char(last_success_until, 'YYYY-MM-DD') AS last_success_until FROM google_ads_sync_state WHERE customer_id = $1`,
      [customerId]
    );
    const resyncFrom = addDays(until, -(RESYNC_DAYS - 1));
    const since = state?.last_success_until ? (resyncFrom > BACKFILL_FLOOR ? resyncFrom : BACKFILL_FLOOR) : BACKFILL_FLOOR;
    const range = `segments.date BETWEEN '${since}' AND '${until}'`;

    const campaigns = (await search(customerId, 'SELECT campaign.id, campaign.name, campaign.status FROM campaign'))
      .map(r => ({ id: String(r.campaign?.id ?? ''), name: r.campaign?.name ?? '', status: r.campaign?.status ?? '' }))
      .filter(c => c.id);
    // Offer landing page per campaign (most common across its ads) — the Promo
    // breakdown's fallback when the campaign name carries no offer code.
    const offerVotes = new Map<string, Map<string, number>>();
    for (const r of await search(customerId, "SELECT campaign.id, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.status != 'REMOVED'")) {
      const campaignId = String(r.campaign?.id ?? '');
      for (const url of r.adGroupAd?.ad?.finalUrls || []) {
        const offer = landingOfferOf(url);
        if (!campaignId || !offer) continue;
        const votes = offerVotes.get(campaignId) ?? new Map<string, number>();
        votes.set(offer, (votes.get(offer) || 0) + 1);
        offerVotes.set(campaignId, votes);
      }
    }
    const landingOffer = (campaignId: string) => {
      const votes = offerVotes.get(campaignId);
      return votes ? Array.from(votes.entries()).sort((a, b) => b[1] - a[1])[0][0] : '';
    };

    // Asset views can't be segmented by conversion category, only by action —
    // map each action resource name to its category.
    const actionCategory = new Map<string, string>();
    for (const r of await search(customerId, 'SELECT conversion_action.id, conversion_action.category FROM conversion_action')) {
      if (r.conversionAction?.id) actionCategory.set(`customers/${customerId}/conversionActions/${r.conversionAction.id}`, r.conversionAction.category || '');
    }

    // Campaign x day.
    const days = new Map<string, Metrics & { campaignId: string; date: string }>();
    const dayFor = (campaignId: string, date: string) => {
      const key = `${campaignId}|${date}`;
      let d = days.get(key);
      if (!d) { d = { campaignId, date, ...emptyMetrics() }; days.set(key, d); }
      return d;
    };
    for (const r of await search(customerId,
      `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks
       FROM campaign WHERE ${range}`)) {
      if (r.campaign?.id && r.segments?.date) addBase(dayFor(String(r.campaign.id), r.segments.date), r);
    }
    for (const r of await search(customerId,
      `SELECT campaign.id, segments.date, segments.conversion_action_category, metrics.all_conversions
       FROM campaign WHERE ${range} AND metrics.all_conversions > 0`)) {
      const col = CONVERSION_COLUMN[r.segments?.conversionActionCategory || ''];
      if (col && r.campaign?.id && r.segments?.date) dayFor(String(r.campaign.id), r.segments.date)[col] += Number(r.metrics?.allConversions || 0);
    }
    const rows = Array.from(days.values()).filter(hasData);

    // Keyword x day (per ad group — the same keyword can sit in several).
    const kwDays = new Map<string, Metrics & { campaignId: string; adGroupId: string; criterionId: string; text: string; matchType: string; date: string }>();
    const kwFor = (r: GaqlRow) => {
      const campaignId = String(r.campaign?.id ?? ''), adGroupId = String(r.adGroup?.id ?? ''), criterionId = String(r.adGroupCriterion?.criterionId ?? ''), date = r.segments?.date ?? '';
      if (!campaignId || !adGroupId || !criterionId || !date) return null;
      const key = `${campaignId}|${adGroupId}|${criterionId}|${date}`;
      let d = kwDays.get(key);
      if (!d) { d = { campaignId, adGroupId, criterionId, text: '', matchType: '', date, ...emptyMetrics() }; kwDays.set(key, d); }
      return d;
    };
    for (const r of await search(customerId,
      `SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
              segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks
       FROM keyword_view WHERE ${range}`)) {
      const d = kwFor(r);
      if (!d) continue;
      d.text = r.adGroupCriterion?.keyword?.text ?? '';
      d.matchType = r.adGroupCriterion?.keyword?.matchType ?? '';
      addBase(d, r);
    }
    for (const r of await search(customerId,
      `SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, segments.date, segments.conversion_action_category, metrics.all_conversions
       FROM keyword_view WHERE ${range} AND metrics.all_conversions > 0`)) {
      const col = CONVERSION_COLUMN[r.segments?.conversionActionCategory || ''];
      const d = col ? kwFor(r) : null;
      if (d && col) d[col] += Number(r.metrics?.allConversions || 0);
    }
    const kwRows = Array.from(kwDays.values()).filter(d => d.text && hasData(d));

    // Responsive search ad headline / description x day, summed across the
    // ads and ad groups of a campaign.
    const assetDays = new Map<string, Metrics & { campaignId: string; fieldType: string; assetId: string; text: string; date: string }>();
    const assetFor = (r: GaqlRow) => {
      const campaignId = String(r.campaign?.id ?? ''), fieldType = r.adGroupAdAssetView?.fieldType ?? '', assetId = String(r.asset?.id ?? ''), date = r.segments?.date ?? '';
      if (!campaignId || !fieldType || !assetId || !date) return null;
      const key = `${campaignId}|${fieldType}|${assetId}|${date}`;
      let d = assetDays.get(key);
      if (!d) { d = { campaignId, fieldType, assetId, text: '', date, ...emptyMetrics() }; assetDays.set(key, d); }
      return d;
    };
    const assetWhere = `${range} AND ad_group_ad_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')`;
    for (const r of await search(customerId,
      `SELECT campaign.id, ad_group_ad_asset_view.field_type, asset.id, asset.text_asset.text, segments.date,
              metrics.cost_micros, metrics.impressions, metrics.clicks
       FROM ad_group_ad_asset_view WHERE ${assetWhere}`)) {
      const d = assetFor(r);
      if (!d) continue;
      d.text = r.asset?.textAsset?.text ?? '';
      addBase(d, r);
    }
    for (const r of await search(customerId,
      `SELECT campaign.id, ad_group_ad_asset_view.field_type, asset.id, segments.date, segments.conversion_action, metrics.all_conversions
       FROM ad_group_ad_asset_view WHERE ${assetWhere} AND metrics.all_conversions > 0`)) {
      const col = CONVERSION_COLUMN[actionCategory.get(r.segments?.conversionAction ?? '') || ''];
      const d = col ? assetFor(r) : null;
      if (d && col) d[col] += Number(r.metrics?.allConversions || 0);
    }
    const assetRows = Array.from(assetDays.values()).filter(d => d.text && hasData(d));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO google_ads_campaigns (customer_id, campaign_id, campaign_name, status, landing_offer, updated_at)
         SELECT $1::text, t.*, now() FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t
         ON CONFLICT (customer_id, campaign_id) DO UPDATE SET campaign_name = EXCLUDED.campaign_name, status = EXCLUDED.status,
           landing_offer = EXCLUDED.landing_offer, updated_at = now()`,
        [customerId, campaigns.map(c => c.id), campaigns.map(c => c.name), campaigns.map(c => c.status), campaigns.map(c => landingOffer(c.id))]
      );
      // Full precision (micros / fractional conversions) — rounding per day
      // drifts multi-day totals off the Google Ads UI by a few cents.
      // Replace the whole window so a day whose numbers dropped to zero (or
      // a campaign that was removed) doesn't leave a stale row behind.
      for (const table of ['google_ads_daily', 'google_ads_keyword_daily', 'google_ads_asset_daily']) {
        await client.query(`DELETE FROM ${table} WHERE customer_id = $1 AND date BETWEEN $2 AND $3`, [customerId, since, until]);
      }
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        const chunk = rows.slice(i, i + INSERT_CHUNK);
        await client.query(
          `INSERT INTO google_ads_daily (customer_id, campaign_id, date, cost, impressions, clicks, leads, joins, bookings, synced_at)
           SELECT $1::text, t.*, now() FROM unnest($2::text[], $3::date[], $4::numeric[], $5::bigint[], $6::bigint[], $7::numeric[], $8::numeric[], $9::numeric[]) AS t`,
          [customerId, chunk.map(r => r.campaignId), chunk.map(r => r.date), ...metricArrays(chunk)]
        );
      }
      for (let i = 0; i < kwRows.length; i += INSERT_CHUNK) {
        const chunk = kwRows.slice(i, i + INSERT_CHUNK);
        await client.query(
          `INSERT INTO google_ads_keyword_daily (customer_id, campaign_id, ad_group_id, criterion_id, keyword_text, match_type, date, cost, impressions, clicks, leads, joins, bookings)
           SELECT $1::text, t.* FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::date[], $8::numeric[], $9::bigint[], $10::bigint[], $11::numeric[], $12::numeric[], $13::numeric[]) AS t`,
          [customerId, chunk.map(r => r.campaignId), chunk.map(r => r.adGroupId), chunk.map(r => r.criterionId), chunk.map(r => r.text),
            chunk.map(r => r.matchType), chunk.map(r => r.date), ...metricArrays(chunk)]
        );
      }
      for (let i = 0; i < assetRows.length; i += INSERT_CHUNK) {
        const chunk = assetRows.slice(i, i + INSERT_CHUNK);
        await client.query(
          `INSERT INTO google_ads_asset_daily (customer_id, campaign_id, field_type, asset_id, asset_text, date, cost, impressions, clicks, leads, joins, bookings)
           SELECT $1::text, t.* FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::date[], $7::numeric[], $8::bigint[], $9::bigint[], $10::numeric[], $11::numeric[], $12::numeric[]) AS t`,
          [customerId, chunk.map(r => r.campaignId), chunk.map(r => r.fieldType), chunk.map(r => r.assetId), chunk.map(r => r.text),
            chunk.map(r => r.date), ...metricArrays(chunk)]
        );
      }
      await client.query(
        `UPDATE google_ads_sync_state SET status = 'idle', last_success_until = $2, last_synced_at = now(), time_zone = $3, last_error = NULL
         WHERE customer_id = $1`,
        [customerId, until, timeZone]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { customerId, since, until, rows: rows.length, keywordRows: kwRows.length, assetRows: assetRows.length, campaigns: campaigns.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(`UPDATE google_ads_sync_state SET status = 'error', last_error = $2 WHERE customer_id = $1`, [customerId, message.slice(0, 500)]).catch(() => {});
    return { customerId, error: message };
  }
}

// Every Google Ads account referenced by a client reading from the API.
export async function getAllGoogleCustomerIds(): Promise<string[]> {
  const rows = await query<{ google_ads_customer_ids: string[] | null }>(
    `SELECT google_ads_customer_ids FROM clients
     WHERE google_data_source = 'api' AND cardinality(google_ads_customer_ids) > 0`
  );
  return Array.from(new Set(rows.flatMap(r => (r.google_ads_customer_ids || []).map(normalizeCustomerId)).filter(Boolean)));
}

export interface GoogleDailyRow {
  campaign: string;
  campaignId: string;
  status: string;
  day: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  leads: number;
  joins: number;
  bookings: number;
}

// Rows for one client: its accounts, narrowed by google_campaign_filter
// (same pipe-separated OR-substring rule as the Meta campaign_filter).
export async function getGoogleDailyRows(customerIds: string[], campaignFilter: string): Promise<{ rows: GoogleDailyRow[]; syncedThrough: string | null }> {
  const ids = customerIds.map(normalizeCustomerId).filter(Boolean);
  if (ids.length === 0) return { rows: [], syncedThrough: null };
  const campaigns = await query<{ customer_id: string; campaign_id: string; campaign_name: string; status: string }>(
    `SELECT customer_id, campaign_id, campaign_name, status FROM google_ads_campaigns WHERE customer_id = ANY($1)`,
    [ids]
  );
  const matched = campaigns.filter(c => matchesCampaignFilter(c.campaign_name, campaignFilter, c.customer_id));
  const [state] = await query<{ synced_through: string | null }>(
    `SELECT to_char(MIN(last_success_until), 'YYYY-MM-DD') AS synced_through FROM google_ads_sync_state WHERE customer_id = ANY($1)`,
    [ids]
  );
  if (matched.length === 0) return { rows: [], syncedThrough: state?.synced_through ?? null };

  const byKey = new Map(matched.map(c => [`${c.customer_id}|${c.campaign_id}`, c] as const));
  const daily = await query<{ customer_id: string; campaign_id: string; day: string; cost: string; impressions: string; clicks: string; leads: string; joins: string; bookings: string }>(
    `SELECT customer_id, campaign_id, to_char(date, 'YYYY-MM-DD') AS day, cost, impressions, clicks, leads, joins, bookings
     FROM google_ads_daily
     WHERE customer_id = ANY($1) AND campaign_id = ANY($2)
     ORDER BY date`,
    [ids, matched.map(c => c.campaign_id)]
  );
  const rows: GoogleDailyRow[] = [];
  for (const d of daily) {
    const c = byKey.get(`${d.customer_id}|${d.campaign_id}`);
    if (!c) continue;
    rows.push({
      campaign: c.campaign_name,
      campaignId: c.campaign_id,
      status: c.status,
      day: d.day,
      spend: Number(d.cost),
      impressions: Number(d.impressions),
      linkClicks: Number(d.clicks),
      leads: Number(d.leads),
      joins: Number(d.joins),
      bookings: Number(d.bookings),
    });
  }
  return { rows, syncedThrough: state?.synced_through ?? null };
}

// ── Breakdowns (Keyword / Promo / Headline / Description) ────────────────

// "Campaign Type" column, read off the campaign name (GMN naming: "GMN - <offer>
// - Search - Non-Brand - #<club> - City"). Non-Brand is checked before Brand.
export function campaignTypeOf(name: string): string {
  if (/non[\s-]?brand/i.test(name)) return 'Non-Brand';
  if (/\bbrand\b/i.test(name)) return 'Brand';
  if (/\bmixed\b/i.test(name)) return 'Mixed';
  if (/conquest/i.test(name)) return 'Conquesting';
  return 'Other';
}

// Offer code in the campaign name -> promo label. Codes not listed here are
// shown as-is; without a code, the campaign's landing-page offer is used
// (anytimefitness.com/offer/local/<slug>, or utm_campaign), else "Unspecified".
const PROMO_CODES: [RegExp, string][] = [
  [/\bROTY\b|JoinGetRestYearFree/i, 'Rest of Year Free'],
  [/\bJF1\b|JoinFor1|Join For \$1/i, 'Join For $1'],
  [/\b2MF\b/i, '2 Months Free'],
  [/\b7DP\b|7DaysFree/i, '7-Day Pass'],
  [/\b1DP\b/i, '1-Day Pass'],
  [/\bPreSale\b/i, 'PreSale'],
];
export function promoOf(name: string, landingOffer = ''): string {
  for (const [re, label] of PROMO_CODES) if (re.test(name)) return label;
  const m = /^GMN - ([^-]+?) - Search\b/.exec(name);
  if (m) return m[1].trim();
  if (landingOffer) {
    for (const [re, label] of PROMO_CODES) if (re.test(landingOffer.replace(/-/g, ''))) return label;
    return LANDING_OFFER_LABELS[landingOffer]
      ?? landingOffer.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
  return 'Unspecified';
}

const LANDING_OFFER_LABELS: Record<string, string> = {
  'join-get-rest-year-free': 'Rest of Year Free',
  'joingetrestyearfree': 'Rest of Year Free',
  'joinfor1dollar': 'Join For $1',
  'join-for-1-dollar': 'Join For $1',
  'join-for-one-dollar-offer': 'Join For $1',
  'join-get-2-months-free': '2 Months Free',
  'join-get-summer-free': 'Summer Free',
  '30-days-free': '30 Days Free',
  '7-days-free': '7-Day Pass',
  'free-7-day-pass': '7-Day Pass',
  'free-7-day-pass-offer': '7-Day Pass',
  '1daypass': '1-Day Pass',
  '6-week-challenge': '6 Week Challenge',
};

// Offer slug from an ad's final URL: /offer/(local|group)/<slug>, else the
// utm_campaign parameter (join.anytimefitness.com links carry only that).
export function landingOfferOf(url: string): string {
  try {
    const u = new URL(url);
    const m = /\/offer\/(?:local|group)\/([^/?#]+)/i.exec(u.pathname);
    if (m) return m[1].toLowerCase();
    return (u.searchParams.get('utm_campaign') || '').toLowerCase();
  } catch {
    return '';
  }
}

export interface GoogleBreakdownRow {
  name: string;
  campaignType: string;
  campaign: string; // campaign name — the dashboard filters rows by its campaign search, then sums them
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  joins: number;
  bookings: number;
  // Keywords tab only: the campaign's spend/clicks not attributed to any
  // keyword (Search campaigns with "Include Google Display Network" on).
  displayGap?: boolean;
}

export const DISPLAY_GAP_LABEL = 'Display Network (not keyword-based)';

type AggRow = { campaign_id: string; label: string; cost: string; impressions: string; clicks: string; leads: string; joins: string; bookings: string };

function toRow(r: AggRow, name: string, campaign: string, campaignType: string): GoogleBreakdownRow {
  return {
    name, campaign, campaignType,
    spend: Number(r.cost), impressions: Number(r.impressions), clicks: Number(r.clicks),
    leads: Number(r.leads), joins: Number(r.joins), bookings: Number(r.bookings),
  };
}

// Breakdowns for one client and date range, over the same campaigns as its
// Google dashboard (google_campaign_filter). One row per campaign x item so
// the dashboard can apply its campaign search before summing.
export async function getGoogleBreakdowns(customerIds: string[], campaignFilter: string, since: string, until: string): Promise<{
  keywords: GoogleBreakdownRow[]; promos: GoogleBreakdownRow[]; headlines: GoogleBreakdownRow[]; descriptions: GoogleBreakdownRow[];
}> {
  const empty = { keywords: [], promos: [], headlines: [], descriptions: [] };
  const ids = customerIds.map(normalizeCustomerId).filter(Boolean);
  if (ids.length === 0) return empty;
  const campaigns = await query<{ customer_id: string; campaign_id: string; campaign_name: string; landing_offer: string }>(
    `SELECT customer_id, campaign_id, campaign_name, landing_offer FROM google_ads_campaigns WHERE customer_id = ANY($1)`,
    [ids]
  );
  const matched = campaigns.filter(c => matchesCampaignFilter(c.campaign_name, campaignFilter, c.customer_id));
  if (matched.length === 0) return empty;
  const nameById = new Map(matched.map(c => [c.campaign_id, c.campaign_name] as const));
  const offerById = new Map(matched.map(c => [c.campaign_id, c.landing_offer] as const));
  const params = [ids, matched.map(c => c.campaign_id), since, until];
  const sums = `SUM(cost) AS cost, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(leads) AS leads, SUM(joins) AS joins, SUM(bookings) AS bookings`;
  const scope = `customer_id = ANY($1) AND campaign_id = ANY($2) AND date BETWEEN $3 AND $4`;

  const [daily, keywords, assets] = await Promise.all([
    query<AggRow>(`SELECT campaign_id, '' AS label, ${sums} FROM google_ads_daily WHERE ${scope} GROUP BY campaign_id`, params),
    query<AggRow>(`SELECT campaign_id, keyword_text AS label, ${sums} FROM google_ads_keyword_daily WHERE ${scope} GROUP BY campaign_id, keyword_text`, params),
    query<AggRow & { field_type: string }>(`SELECT campaign_id, field_type, asset_text AS label, ${sums} FROM google_ads_asset_daily WHERE ${scope} GROUP BY campaign_id, field_type, asset_text`, params),
  ]);
  const campaignOf = (r: AggRow) => nameById.get(r.campaign_id) || '';
  const keywordRows = keywords.map(r => toRow(r, r.label, campaignOf(r), campaignTypeOf(campaignOf(r))));

  // Per campaign, whatever the keywords don't account for is Display Network
  // traffic (verified 2026-11-04: each gap equals the campaign's CONTENT-network
  // spend to the cent). Shown as its own row so the Keywords total matches
  // the campaign total.
  const kwByCampaign = new Map<string, GoogleBreakdownRow>();
  for (const k of keywordRows) {
    const t = kwByCampaign.get(k.campaign) ?? { ...k, spend: 0, impressions: 0, clicks: 0, leads: 0, joins: 0, bookings: 0 };
    t.spend += k.spend; t.impressions += k.impressions; t.clicks += k.clicks; t.leads += k.leads; t.joins += k.joins; t.bookings += k.bookings;
    kwByCampaign.set(k.campaign, t);
  }
  for (const r of daily) {
    const c = toRow(r, DISPLAY_GAP_LABEL, campaignOf(r), campaignTypeOf(campaignOf(r)));
    const k = kwByCampaign.get(c.campaign);
    const gap = {
      ...c, displayGap: true,
      spend: c.spend - (k?.spend ?? 0), impressions: c.impressions - (k?.impressions ?? 0), clicks: c.clicks - (k?.clicks ?? 0),
      leads: c.leads - (k?.leads ?? 0), joins: c.joins - (k?.joins ?? 0), bookings: c.bookings - (k?.bookings ?? 0),
    };
    // Ignore float dust; keep only a real leftover.
    if (gap.spend > 0.005 || gap.impressions > 0 || gap.clicks > 0) keywordRows.push(gap);
  }

  return {
    keywords: keywordRows,
    promos: daily.map(r => toRow(r, promoOf(campaignOf(r), offerById.get(r.campaign_id) || ''), campaignOf(r), '')),
    headlines: assets.filter(a => a.field_type === 'HEADLINE').map(r => toRow(r, r.label, campaignOf(r), campaignTypeOf(campaignOf(r)))),
    descriptions: assets.filter(a => a.field_type === 'DESCRIPTION').map(r => toRow(r, r.label, campaignOf(r), campaignTypeOf(campaignOf(r)))),
  };
}
