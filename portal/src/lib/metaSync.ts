import { query } from './db';
import { decrypt } from './crypto';
import { resolveResultsFromActions } from './meta';

// Session-free Meta → Postgres sync for the DB-backed dashboard cache.
// Mirrors getClientConnection()'s token resolution but without a session —
// this runs as a background admin action (see /api/admin/clients/[id]/sync),
// not a request bound to a logged-in client. See migration
// 011_meta_cache.sql for the schema this writes into and the plan doc for
// the full design rationale (storage is per ad-account, not per-client;
// campaign_filter is applied at read time, not sync time).

const GRAPH = 'https://graph.facebook.com/v22.0';
const ALL_STATUSES = ['ACTIVE','PAUSED','DELETED','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO','CAMPAIGN_PAUSED','ARCHIVED','ADSET_PAUSED','IN_PROCESS','WITH_ISSUES'];
const ATTRIBUTION_WINDOWS = '["7d_click","1d_view","1d_ev"]';
const BACKFILL_MONTHS = 37; // matches the dashboard's own "Maximum" preset cap
const CHUNK_DAYS = 3; // smallest chunk size already proven safe against Omega's row-cap failures
const SYNC_CONCURRENCY = 2; // lower than the client's 4 — one sync run issues far more total requests than a single page load
// Insights' month-by-month backfill loop used to have no time limit of its
// own — on a huge account (Omega: ~8,000 campaigns) each month can take
// several minutes, so insights alone could consume an entire "Sync now"
// request and creatives (separate assets/thumbnails/DCO metrics) never got
// a turn, even after the fix that lets each step fail independently — a
// long-running loop that never throws isn't caught by that fix. Capping
// insights' own wall-clock budget guarantees creatives runs every "Sync
// now" click, at the cost of insights sometimes doing less backfill work
// per click on the very largest accounts (it resumes exactly where it left
// off next time, same as any other interrupted month).
const INSIGHTS_BACKFILL_BUDGET_MS = 3 * 60_000;

export interface SyncAccountResult {
  accountId: string;
  entitiesUpserted: number;
  daysSynced: number;
  newEarliestDate: string | null;
  error: string | null;
}

interface BmConnectionRow {
  token_enc: string;
  account_ids: string[];
}

async function tokenForAccountId(accountId: string): Promise<string> {
  const rows = await query<BmConnectionRow>(
    `SELECT token_enc, account_ids FROM agency_bm_connections WHERE $1 = ANY(account_ids) LIMIT 1`,
    [accountId]
  );
  if (rows.length === 0) throw new Error(`No Meta connection found for ad account ${accountId}`);
  return decrypt(rows[0].token_enc);
}

// Meta's "too many rows" row-cap error (error_subcode 1487534) and its
// "request timed out" error (error_subcode 1504018, error_user_msg "Please
// try a smaller date range, fetch less data, or use async jobs") are both
// NOT transient (Meta marks is_transient: false) — retrying with backoff
// never helps, the only fix is a narrower request. Both surface the same
// underlying problem (one request asking for too much at once) and share
// the same fix (halve the campaign batch), so both are classified together
// here. Callers that can retry with a smaller batch (see
// fetchInsightsChunkWithRowCapFallback) catch this specifically; everything
// else just fails the sync run same as any other hard error.
const TOO_MUCH_DATA_SUBCODES = new Set([1487534, 1504018]);
class RowCapError extends Error {
  constructor(message: string) { super(message); this.name = 'RowCapError'; }
}

// ── Retry/paging helper — base policy matches fetchAll() in creatives/route.ts
// and the inline loop in asset-breakdown/route.ts (3 attempts, transient-code
// detection, 800ms×attempt backoff). Additionally, since this is a patient
// background job (not a request a user is staring at), rate-limit errors
// (code 17 — "Ad Account Has Too Many API Calls"/"User request limit
// reached") get a longer, more patient retry: Meta's own guidance is "wait a
// bit and try again," and the live dashboard's humanizeMetaError() already
// documents code 17 as "recoverable, retryable" — this sync module can
// afford to actually wait instead of surfacing it to a user immediately.
async function fetchMetaWithRetry<T>(url: URL | string, followPaging = true): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = url.toString();
  let safety = 50;
  let isFirstPage = true;
  while (next && safety-- > 0) {
    let json: { data?: T[]; error?: { message?: string; code?: number; error_subcode?: number; error_user_title?: string }; paging?: { next?: string } } | undefined;
    let networkErr: unknown;
    const MAX_ATTEMPTS = 6;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      networkErr = undefined;
      try {
        const res = await fetch(next);
        json = await res.json();
      } catch (e) {
        // Network failure or a non-JSON/truncated body (e.g. a dropped
        // connection on a very large response) — not a Meta-shaped error, so
        // it wouldn't otherwise hit the retry logic below. Treat as transient.
        networkErr = e;
        json = undefined;
        if (attempt < MAX_ATTEMPTS - 1) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
        break;
      }
      const err = json?.error;
      if (!err) break;
      const title = (err.error_user_title || '').toLowerCase();
      const rateLimited = err.code === 17;
      const transient = err.code === 1 || err.code === 2 || rateLimited || title.includes('unknown error') || title.includes('temporarily');
      if (!transient || attempt === MAX_ATTEMPTS - 1) break;
      await new Promise(r => setTimeout(r, rateLimited ? 20_000 * (attempt + 1) : 800 * (attempt + 1)));
    }
    if (networkErr && !json) {
      const scrubbed = String(next).replace(/access_token=[^&]+/, 'access_token=REDACTED');
      const msg = networkErr instanceof Error ? networkErr.message : 'Network error';
      console.error('[META-SYNC-ERR]', JSON.stringify({ url: scrubbed, error: { message: msg }, page: isFirstPage ? 'first' : 'mid' }));
      if (isFirstPage) throw new Error(msg);
      return out; // mid-pagination failure: keep what we have
    }
    if (json?.error) {
      const scrubbed = String(next).replace(/access_token=[^&]+/, 'access_token=REDACTED');
      console.error('[META-SYNC-ERR]', JSON.stringify({ url: scrubbed, error: json.error, page: isFirstPage ? 'first' : 'mid' }));
      if (isFirstPage) {
        if (json.error.error_subcode !== undefined && TOO_MUCH_DATA_SUBCODES.has(json.error.error_subcode)) {
          throw new RowCapError(json.error.message || 'Too many rows');
        }
        throw new Error(json.error.message || 'Meta API error');
      }
      return out; // mid-pagination failure: keep what we have, same posture as the live routes
    }
    if (Array.isArray(json?.data)) out.push(...json!.data!);
    next = followPaging ? (json?.paging?.next || null) : null;
    isFirstPage = false;
  }
  return out;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return fmtDate(dt);
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Yesterday in the account's own timezone — same "floor at yesterday"
// convention used everywhere else in this codebase.
async function yesterdayForAccount(accountId: string, token: string): Promise<string> {
  let timezone = 'UTC';
  try {
    const u = new URL(`${GRAPH}/act_${accountId}`);
    u.searchParams.set('fields', 'timezone_name');
    u.searchParams.set('access_token', token);
    const res = await fetch(u.toString());
    const json = await res.json() as { timezone_name?: string };
    if (json.timezone_name) timezone = json.timezone_name;
  } catch { /* fall back to UTC */ }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const m = Number(parts.find(p => p.type === 'month')?.value);
  const d = Number(parts.find(p => p.type === 'day')?.value);
  const today = new Date(y, m - 1, d);
  today.setDate(today.getDate() - 1);
  return fmtDate(today);
}

function floorDateFrom(yesterday: string): string {
  const [y, m, d] = yesterday.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  // Uses the same setMonth() call as the live dashboard's "Maximum" preset
  // (DashboardClient.tsx, _dpPresetRange('maximum')) so cached mode's oldest
  // available day is meant to match what "Maximum" already shows live today.
  dt.setMonth(dt.getMonth() - BACKFILL_MONTHS);
  // Meta rejects an insights time_range whose `since` sits exactly 37 months
  // back with "(#3018) start date ... cannot be beyond 37 months" — Meta
  // measures the 37-month boundary from *today*, not from yesterday, so a
  // request built from yesterday - 37mo lands exactly on (or past) the edge.
  // Pad one extra day inside the boundary; negligible versus 37 months of
  // history, and far simpler than trying to replicate Meta's exact boundary
  // arithmetic (which the live route also implicitly avoids by only ever
  // chunking a narrower window per request, never hitting this edge).
  dt.setDate(dt.getDate() + 1);
  return fmtDate(dt);
}

function monthStart(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// Total whole-plus-partial calendar months spanned by [floorDate, yesterday]
// — the fixed denominator for "N of M months backfilled" progress display.
// Pure date math, no query: recomputed the same way on every read, so it
// can never drift from what the backfill loop below is actually walking.
function monthsInRange(floorDate: string, yesterday: string): number {
  const [fy, fm] = floorDate.split('-').map(Number);
  const [yy, ym] = yesterday.split('-').map(Number);
  return (yy - fy) * 12 + (ym - fm) + 1;
}

function chunkRange(since: string, until: string, chunkDays: number): { since: string; until: string }[] {
  const chunks: { since: string; until: string }[] = [];
  let cursor = since;
  while (daysBetween(cursor, until) >= 0) {
    const chunkEndCandidate = addDays(cursor, chunkDays - 1);
    // Use the candidate end unless it would overshoot past `until`.
    const chunkEnd = daysBetween(chunkEndCandidate, until) < 0 ? until : chunkEndCandidate;
    chunks.push({ since: cursor, until: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }
  return chunks;
}

// Bounded-concurrency runner — same shape as runPooled() in DashboardClient.tsx.
async function runPooled<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const my = idx++;
      await worker(items[my]);
      await new Promise(r => setTimeout(r, 250));
    }
  });
  await Promise.all(runners);
}

// ── Concurrency guard ────────────────────────────────────────────────────
async function claimSync(accountId: string): Promise<boolean> {
  const rows = await query<{ account_id: string }>(
    `INSERT INTO agency_meta_sync_state (account_id, status, last_run_started_at)
     VALUES ($1, 'running', now())
     ON CONFLICT (account_id) DO UPDATE
       SET status = 'running', last_run_started_at = now()
       WHERE agency_meta_sync_state.status != 'running'
          OR agency_meta_sync_state.last_run_started_at < now() - interval '30 minutes'
     RETURNING account_id`,
    [accountId]
  );
  return rows.length > 0;
}

async function finishSync(accountId: string, opts: { success: boolean; error?: string }): Promise<void> {
  if (opts.success) {
    await query(
      `UPDATE agency_meta_sync_state SET status = 'idle', last_synced_at = now(), last_error = NULL, updated_at = now() WHERE account_id = $1`,
      [accountId]
    );
  } else {
    await query(
      `UPDATE agency_meta_sync_state SET status = 'error', last_error = $2, updated_at = now() WHERE account_id = $1`,
      [accountId, opts.error || 'Unknown error']
    );
  }
}

// ── Step 1: entity refresh (campaigns/adsets/ads) ───────────────────────
interface EntityRow { id: string; name?: string; effective_status?: string; campaign?: { id?: string; name?: string }; adset?: { id?: string; name?: string } }

// Batch size for unnest()-array upserts. Large enough to collapse thousands
// of rows into a handful of round-trips, small enough to keep each query's
// parameter arrays and payload reasonable. Postgres has no hard row-count
// limit here (unlike Meta's API), this is purely about keeping individual
// statements a sane size.
const DB_BATCH_SIZE = 500;

function chunkArrayGeneric<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function syncEntities(accountId: string, token: string): Promise<number> {
  let upserted = 0;
  const levels: { level: 'campaign' | 'adset' | 'ad'; path: string; fields: string }[] = [
    { level: 'campaign', path: 'campaigns', fields: 'id,name,effective_status' },
    { level: 'adset', path: 'adsets', fields: 'id,name,effective_status,campaign{id,name}' },
    { level: 'ad', path: 'ads', fields: 'id,name,effective_status,campaign{id,name},adset{id,name}' },
  ];
  for (const lvl of levels) {
    const u = new URL(`${GRAPH}/act_${accountId}/${lvl.path}`);
    u.searchParams.set('fields', lvl.fields);
    u.searchParams.set('limit', '500');
    u.searchParams.set('filtering', JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ALL_STATUSES }]));
    u.searchParams.set('access_token', token);
    const rows = await fetchMetaWithRetry<EntityRow>(u);
    const valid = rows.filter(r => !!r.id);

    // Batched upsert via unnest() — one round-trip per DB_BATCH_SIZE rows
    // instead of one per row. On large accounts (Omega alone has ~58k
    // entities) row-by-row upserts generate enough Postgres log/checkpoint
    // activity to trip Railway's per-second log-rate cap; batching collapses
    // that by 2-3 orders of magnitude.
    for (const batch of chunkArrayGeneric(valid, DB_BATCH_SIZE)) {
      const entityIds = batch.map(r => r.id);
      const names = batch.map(r => r.name || '');
      const campaignIds = batch.map(r => lvl.level === 'campaign' ? r.id : (r.campaign?.id || null));
      const campaignNames = batch.map(r => lvl.level === 'campaign' ? (r.name || '') : (r.campaign?.name || null));
      const adsetIds = batch.map(r => lvl.level === 'ad' ? (r.adset?.id || null) : (lvl.level === 'adset' ? r.id : null));
      const adsetNames = batch.map(r => lvl.level === 'ad' ? (r.adset?.name || null) : (lvl.level === 'adset' ? (r.name || '') : null));
      const statuses = batch.map(r => r.effective_status || 'UNKNOWN');

      await query(
        `INSERT INTO meta_entities (account_id, level, entity_id, name, campaign_id, campaign_name, adset_id, adset_name, effective_status, updated_at)
         SELECT $1, $2, entity_id, name, campaign_id, campaign_name, adset_id, adset_name, effective_status, now()
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
           AS t(entity_id, name, campaign_id, campaign_name, adset_id, adset_name, effective_status)
         ON CONFLICT (account_id, level, entity_id) DO UPDATE SET
           name = EXCLUDED.name, campaign_id = EXCLUDED.campaign_id, campaign_name = EXCLUDED.campaign_name,
           adset_id = EXCLUDED.adset_id, adset_name = EXCLUDED.adset_name,
           effective_status = EXCLUDED.effective_status, updated_at = now()`,
        [accountId, lvl.level, entityIds, names, campaignIds, campaignNames, adsetIds, adsetNames, statuses]
      );
      upserted += batch.length;
    }
  }
  return upserted;
}

// ── Step 2: daily insights backfill + top-up ────────────────────────────
interface InsightRow {
  campaign_id?: string; campaign_name?: string;
  adset_id?: string; adset_name?: string;
  ad_id?: string; ad_name?: string;
  reach?: string; impressions?: string; spend?: string; inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
  date_start?: string;
}

// Campaign IDs for this account, read from meta_entities (populated by
// syncEntities earlier in the same run). Insights requests are batched per
// campaign group (see CAMPAIGN_BATCH_SIZE) rather than fetched account-wide,
// since very large accounts (thousands of campaigns/adsets/ads — the actual
// case that motivated this) can trip Meta's row cap even at a 3-day window
// when every campaign's adsets/ads are requested in one call. Batching by
// campaign directly targets the thing driving the row count, unlike
// splitting by date (which doesn't help when the cap is really "too many
// entities per request", not "too many days").
async function campaignIdsForAccount(accountId: string): Promise<string[]> {
  const rows = await query<{ entity_id: string }>(
    `SELECT entity_id FROM meta_entities WHERE account_id = $1 AND level = 'campaign'`,
    [accountId]
  );
  return rows.map(r => r.entity_id);
}

// Batches Omega-sized accounts (~159 campaigns) into ~8 requests per chunk
// instead of one unfiltered account-wide call — small enough that the
// campaign.id IN [...] filter's URL stays well under any GET length limit
// even at level=ad (200 campaigns' worth of IDs measured empirically over
// 4KB, which triggered malformed/truncated responses). The halving fallback
// in fetchInsightsChunkWithRowCapFallback shrinks further, per-batch, only
// for accounts that still trip the row cap at this size.
const CAMPAIGN_BATCH_SIZE = 20;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchInsightsChunk(accountId: string, token: string, level: 'campaign' | 'adset' | 'ad', since: string, until: string, campaignIds: string[] | null): Promise<InsightRow[]> {
  const fieldsByLevel = {
    campaign: 'campaign_id,campaign_name,reach,impressions,spend,inline_link_clicks,actions',
    adset: 'adset_id,adset_name,campaign_id,campaign_name,reach,impressions,spend,inline_link_clicks,actions',
    ad: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,reach,impressions,spend,inline_link_clicks,actions',
  };
  const statusField = { campaign: 'campaign.effective_status', adset: 'adset.effective_status', ad: 'ad.effective_status' }[level];

  const filtering: { field: string; operator: string; value: string | string[] }[] = [
    { field: statusField, operator: 'IN', value: ALL_STATUSES },
  ];
  if (campaignIds) filtering.push({ field: 'campaign.id', operator: 'IN', value: campaignIds });

  const u = new URL(`${GRAPH}/act_${accountId}/insights`);
  u.searchParams.set('fields', fieldsByLevel[level]);
  u.searchParams.set('level', level);
  u.searchParams.set('time_range', JSON.stringify({ since, until }));
  u.searchParams.set('time_increment', '1');
  u.searchParams.set('limit', '500');
  u.searchParams.set('action_attribution_windows', ATTRIBUTION_WINDOWS);
  u.searchParams.set('filtering', JSON.stringify(filtering));
  u.searchParams.set('access_token', token);

  return fetchMetaWithRetry<InsightRow>(u);
}

// Batches by campaign group first (CAMPAIGN_BATCH_SIZE at a time); if a
// batch still trips the row cap (error_subcode 1487534 — NOT transient,
// retrying never helps), halve the batch down to single campaigns before
// giving up on that one campaign's data for this chunk. campaignIds is null
// for accounts too small to have any campaigns yet (defensive — shouldn't
// happen since syncEntities always runs first) or when batching is skipped
// entirely for small campaign counts.
interface RowCapFallbackResult {
  rows: InsightRow[];
  /** True if any campaign's data was skipped because the row cap persisted
   * even at single-campaign granularity. Callers must NOT treat the range
   * this chunk belongs to as fully backfilled when this is true. */
  hadGaps: boolean;
}

async function fetchInsightsChunkWithRowCapFallback(accountId: string, token: string, level: 'campaign' | 'adset' | 'ad', since: string, until: string, campaignIds: string[]): Promise<RowCapFallbackResult> {
  const out: InsightRow[] = [];
  let hadGaps = false;
  const batches = chunkArray(campaignIds, CAMPAIGN_BATCH_SIZE);
  for (const batch of batches) {
    try {
      out.push(...await fetchInsightsChunk(accountId, token, level, since, until, batch));
    } catch (err) {
      if (err instanceof RowCapError && batch.length > 1) {
        // Halve the batch and retry each half individually.
        const mid = Math.ceil(batch.length / 2);
        const halves = [batch.slice(0, mid), batch.slice(mid)];
        for (const half of halves) {
          const sub = await fetchInsightsChunkWithRowCapFallback(accountId, token, level, since, until, half);
          out.push(...sub.rows);
          if (sub.hadGaps) hadGaps = true;
        }
        continue;
      }
      // Any other hard failure for this one campaign-batch (row cap that
      // persists down to a single campaign, or a rate-limit/network error
      // that exhausted fetchMetaWithRetry's own retries) — treat as a gap
      // and move on to the next batch, rather than letting it propagate
      // and crash the whole chunk. A single stubborn batch out of hundreds
      // (a huge account like Omega can have 7,900+ campaigns, ~400
      // batches per chunk at CAMPAIGN_BATCH_SIZE=20) used to take down the
      // entire month's watermark-persist progress with it — real data from
      // every other batch in the chunk still landed in the DB via
      // syncInsightsChunk's writes, but the watermark could never advance
      // past a chunk that threw, since the exception killed the runPooled
      // Promise.all before that chunk's persistUpTo ever ran.
      const reason = err instanceof RowCapError ? 'row cap persists at single-campaign granularity' : (err instanceof Error ? err.message : 'unknown error');
      console.error('[META-SYNC-ERR]', JSON.stringify({ accountId, level, since, until, campaignId: batch[0], batchSize: batch.length, error: `skipping batch after failure: ${reason}` }));
      hadGaps = true;
    }
  }
  return { rows: out, hadGaps };
}

async function syncInsightsChunk(accountId: string, token: string, level: 'campaign' | 'adset' | 'ad', since: string, until: string, campaignIds: string[]): Promise<{ written: number; hadGaps: boolean }> {
  const { rows, hadGaps } = await fetchInsightsChunkWithRowCapFallback(accountId, token, level, since, until, campaignIds);

  interface Prepared {
    entityId: string; date: string; campaignId: string; campaignName: string;
    adsetId: string; adsetName: string; adName: string;
    reach: number; impressions: number; spend: number; linkClicks: number; results: number;
  }
  // Keyed by `${entityId}|${date}` and summed on collision — the row-cap
  // fallback can halve a campaign batch and re-fetch, and campaign batches
  // are not guaranteed disjoint across retries, so the same (entity, day)
  // can plausibly appear twice within one chunk's rows. A batched multi-row
  // upsert can't touch the same conflict target twice in one statement, so
  // any duplicate must be collapsed before building the batch (unlike the
  // old row-by-row loop, where each write was its own statement).
  const preparedByKey = new Map<string, Prepared>();
  for (const r of rows) {
    const entityId = level === 'campaign' ? r.campaign_id : level === 'adset' ? r.adset_id : r.ad_id;
    if (!entityId || !r.date_start) continue;
    const key = `${entityId}|${r.date_start}`;
    const reach = parseInt(r.reach || '0', 10) || 0;
    const impressions = parseInt(r.impressions || '0', 10) || 0;
    const spend = parseFloat(r.spend || '0') || 0;
    const linkClicks = parseInt(r.inline_link_clicks || '0', 10) || 0;
    const results = resolveResultsFromActions(r.actions);
    const existing = preparedByKey.get(key);
    if (existing) {
      existing.reach += reach;
      existing.impressions += impressions;
      existing.spend += spend;
      existing.linkClicks += linkClicks;
      existing.results += results;
    } else {
      preparedByKey.set(key, {
        entityId, date: r.date_start,
        campaignId: r.campaign_id || '', campaignName: r.campaign_name || '',
        adsetId: r.adset_id || '', adsetName: r.adset_name || '',
        adName: r.ad_name || '',
        reach, impressions, spend, linkClicks, results,
      });
    }
  }
  const prepared = Array.from(preparedByKey.values());

  // Batched upsert via unnest() — same rationale as syncEntities: row-by-row
  // writes on a wide account (thousands of rows per chunk × hundreds of
  // chunks) generate enough Postgres activity to trip Railway's log-rate cap.
  for (const batch of chunkArrayGeneric(prepared, DB_BATCH_SIZE)) {
    await query(
      `INSERT INTO meta_daily_insights (account_id, level, entity_id, date, campaign_id, campaign_name, adset_id, adset_name, ad_name, reach, impressions, spend, link_clicks, results, synced_at)
       SELECT $1, $2, entity_id, date::date, campaign_id, campaign_name, adset_id, adset_name, ad_name, reach, impressions, spend, link_clicks, results, now()
       FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::bigint[], $11::bigint[], $12::numeric[], $13::bigint[], $14::bigint[])
         AS t(entity_id, date, campaign_id, campaign_name, adset_id, adset_name, ad_name, reach, impressions, spend, link_clicks, results)
       ON CONFLICT (account_id, level, entity_id, date) DO UPDATE SET
         campaign_id = EXCLUDED.campaign_id, campaign_name = EXCLUDED.campaign_name,
         adset_id = EXCLUDED.adset_id, adset_name = EXCLUDED.adset_name, ad_name = EXCLUDED.ad_name,
         reach = EXCLUDED.reach, impressions = EXCLUDED.impressions, spend = EXCLUDED.spend,
         link_clicks = EXCLUDED.link_clicks, results = EXCLUDED.results, synced_at = now()`,
      [
        accountId, level,
        batch.map(p => p.entityId), batch.map(p => p.date),
        batch.map(p => p.campaignId), batch.map(p => p.campaignName),
        batch.map(p => p.adsetId), batch.map(p => p.adsetName), batch.map(p => p.adName),
        batch.map(p => p.reach), batch.map(p => p.impressions),
        batch.map(p => p.spend), batch.map(p => p.linkClicks), batch.map(p => p.results),
      ]
    );
  }

  return { written: prepared.length, hadGaps };
}

interface SyncState {
  earliest_synced: string | null;
  last_success_until: string | null;
  backfill_complete: boolean;
  newest_synced: string | null;
  creatives_earliest_synced: string | null;
  creatives_backfill_complete: boolean;
  creatives_newest_synced: string | null;
}

// Builds the top-up (recent days, every run) / backfill range split
// syncInsights uses, generalized so syncCreatives's independent creatives_*
// watermark can reuse it.
//
// Backfill walks BACKWARD from `newestSynced` (defaulting to `yesterday` on
// a fresh account) down toward `floorDate`, one calendar month at a time —
// recent history becomes usable almost immediately instead of a 37-month
// account sitting for hours with only ancient history synced and nothing
// current (the actual failure mode this replaced: an account interrupted
// repeatedly by rate limits/timeouts had ~9 months of 2023-2024 data and
// nothing from the last two years, because the old oldest-first walk from
// floorDate never got far before crashing again).
//
// Only ONE month is returned per call — the caller persists newestSynced
// after each month completes and calls this again for the next one, so a
// crash mid-account loses at most the current month's progress. `earliest_synced`/
// `backfillComplete` keep their existing meaning (oldest point reached; whether
// floorDate was reached) since the walk still eventually covers the same
// [floorDate, yesterday] span — only the arrival order changes.
function buildSyncRanges(
  floorDate: string, yesterday: string,
  lastSuccessUntil: string | null, newestSynced: string | null, earliestSynced: string | null, backfillComplete: boolean
): { since: string; until: string; kind: 'topup' | 'backfill' }[] {
  const ranges: { since: string; until: string; kind: 'topup' | 'backfill' }[] = [];
  const topUpSince = lastSuccessUntil
    ? (daysBetween(floorDate, addDays(lastSuccessUntil, -7)) > 0 ? addDays(lastSuccessUntil, -7) : floorDate)
    : floorDate;
  if (daysBetween(topUpSince, yesterday) >= 0) ranges.push({ since: topUpSince, until: yesterday, kind: 'topup' });

  if (!backfillComplete) {
    // Frontier: the newest day not yet confirmed backfilled.
    //   - Fresh account (both null): start at yesterday itself (whole
    //     current partial month first).
    //   - Legacy account transitioning from the old oldest-first model
    //     (newestSynced null, earliestSynced set): the old model's chunk
    //     loop already walks its remaining range newest-first internally
    //     (see the `.reverse()` in runRangeToCompletion), so
    //     [earliestSynced, yesterday] is already synced — resume the new
    //     cursor from there rather than restarting and re-fetching it.
    //   - Steady state (newestSynced set): resume one day older than it.
    const effectiveNewest = newestSynced ?? earliestSynced;
    const frontier = effectiveNewest ? addDays(effectiveNewest, -1) : yesterday;
    if (daysBetween(floorDate, frontier) >= 0) {
      const monthSince = monthStart(frontier);
      // Clamp the month's start to floorDate for the oldest bucket, which
      // is a partial month (floorDateFrom pads a day inside the 37-month
      // boundary, so it rarely lands on the 1st).
      const since = daysBetween(floorDate, monthSince) > 0 ? monthSince : floorDate;
      ranges.push({ since, until: frontier, kind: 'backfill' });
    }
  }
  return ranges;
}

// Runs one "range" (a top-up span, or a single backfill month) through the
// existing chunk/persist machinery: chunks it at CHUNK_DAYS, fetches each
// chunk × level with bounded concurrency, and advances the persisted
// watermark past the longest completed, gap-free PREFIX only — a mid-run
// crash loses at most a few chunks, never the whole range (previously the
// watermark was only written after every chunk in the whole 37-month range
// had completed). Returns the new watermark value reached (or null if
// nothing persisted) and whether the range's oldest chunk was reached
// without any gap — i.e. whether this range can be considered fully done.
async function runRangeToCompletion(
  accountId: string, token: string, range: { since: string; until: string; kind: 'topup' | 'backfill' },
  levels: ('campaign' | 'adset' | 'ad')[], campaignIds: string[],
  onDaysSynced: (n: number) => void
): Promise<{ persisted: string | null; reachedSince: boolean }> {
  // Chunks are processed oldest-to-newest for backfill (walking the
  // watermark backward within this one month) and in natural order for
  // top-up; either way the chunk list must be sorted so "contiguous prefix
  // completed" has a well-defined meaning under concurrent (out-of-order-
  // finishing) execution.
  const chunksAscending = chunkRange(range.since, range.until, CHUNK_DAYS);
  const chunks = range.kind === 'backfill' ? [...chunksAscending].reverse() : chunksAscending;

  // gapped[i] marks a chunk that completed but had a campaign silently
  // skipped due to a persistent row cap (see
  // fetchInsightsChunkWithRowCapFallback). The persisted prefix must stop AT
  // (not past) the first gapped chunk, so the next sync's range restarts
  // from there and retries it.
  const completed = new Array(chunks.length).fill(false);
  const gapped = new Array(chunks.length).fill(false);
  let persistedIdx = -1;
  let persistedValue: string | null = null;
  let stoppedAtGap = false;

  const persistUpTo = async (idx: number) => {
    if (idx <= persistedIdx) return;
    persistedIdx = idx;
    const frontier = chunks[idx]; // the oldest (backfill) or newest (top-up) fully-completed chunk so far
    persistedValue = range.kind === 'topup' ? frontier.until : frontier.since;
    const column = range.kind === 'topup' ? 'last_success_until' : 'earliest_synced';
    await query(`UPDATE agency_meta_sync_state SET ${column} = $2, updated_at = now() WHERE account_id = $1`, [accountId, persistedValue]);
  };

  const units: { level: 'campaign' | 'adset' | 'ad'; chunkIdx: number; chunk: { since: string; until: string } }[] = [];
  for (let i = 0; i < chunks.length; i++) for (const level of levels) units.push({ level, chunkIdx: i, chunk: chunks[i] });
  const levelsRemaining = new Array(chunks.length).fill(levels.length);

  await runPooled(units, SYNC_CONCURRENCY, async ({ level, chunkIdx, chunk }) => {
    const { hadGaps } = await syncInsightsChunk(accountId, token, level, chunk.since, chunk.until, campaignIds);
    if (hadGaps) gapped[chunkIdx] = true;
    if (level === 'campaign') onDaysSynced(daysBetween(chunk.since, chunk.until) + 1);
    levelsRemaining[chunkIdx]--;
    if (levelsRemaining[chunkIdx] === 0) {
      completed[chunkIdx] = true;
      let cursor = persistedIdx + 1;
      while (cursor < completed.length && completed[cursor] && !gapped[cursor]) cursor++;
      if (cursor > persistedIdx + 1) await persistUpTo(cursor - 1);
      if (cursor < completed.length && completed[cursor] && gapped[cursor]) stoppedAtGap = true;
    }
  });

  if (!stoppedAtGap && chunks.length > 0) {
    let cursor = persistedIdx + 1;
    while (cursor < completed.length && completed[cursor] && !gapped[cursor]) cursor++;
    if (cursor > persistedIdx + 1) await persistUpTo(cursor - 1);
  }

  return { persisted: persistedValue, reachedSince: chunks.length > 0 && !stoppedAtGap && completed.every(c => c) };
}

async function syncInsights(accountId: string, token: string): Promise<{ daysSynced: number; newEarliestDate: string | null }> {
  const [state] = await query<SyncState>(
    `SELECT earliest_synced, last_success_until, backfill_complete, newest_synced, creatives_earliest_synced, creatives_backfill_complete, creatives_newest_synced FROM agency_meta_sync_state WHERE account_id = $1`,
    [accountId]
  );

  const yesterday = await yesterdayForAccount(accountId, token);
  const floorDate = floorDateFrom(yesterday);
  const levels: ('campaign' | 'adset' | 'ad')[] = ['campaign', 'adset', 'ad'];
  const campaignIds = await campaignIdsForAccount(accountId);

  let daysSynced = 0;
  let newEarliest = state?.earliest_synced || null;
  let newestSynced = state?.newest_synced || null;
  let backfillComplete = state?.backfill_complete ?? false;
  let topUpDone = false;

  // Forward top-up: re-pull the last 7 days (or from floorDate on first run)
  // through yesterday, ONCE per sync run — Meta's attribution windows
  // mutate recent days for up to 7 days after the fact, so cached numbers
  // must not freeze before that window closes.
  //
  // Backward backfill walks ONE calendar month at a time, newest month
  // first (see buildSyncRanges), looping here until the whole remaining
  // history is covered (or a gap stops it) — still a single "Sync now"
  // click's worth of work, just checkpointed at month boundaries instead of
  // only ever at the very end, so admin-panel progress and a mid-run crash
  // both resolve to "N of M months" instead of an opaque multi-hour black box.
  let guard = BACKFILL_MONTHS + 2; // safety cap: at most this many month-iterations per call
  const startedAt = Date.now();
  while (guard-- > 0) {
    const ranges = buildSyncRanges(floorDate, yesterday, state?.last_success_until ?? null, newestSynced, newEarliest, backfillComplete);
    const topUp = !topUpDone ? ranges.find(r => r.kind === 'topup') : undefined;
    const backfill = ranges.find(r => r.kind === 'backfill');
    if (!topUp && !backfill) break;

    if (topUp) {
      topUpDone = true;
      await runRangeToCompletion(accountId, token, topUp, levels, campaignIds, n => { daysSynced += n; });
    }
    if (!backfill) continue; // nothing left to backfill this run
    // Stop backfilling (after top-up, which always gets to run first) once
    // the time budget is spent — leaves creatives room to run in the same
    // "Sync now" click instead of insights alone eating the whole request.
    if (Date.now() - startedAt > INSIGHTS_BACKFILL_BUDGET_MS) break;
    const result = await runRangeToCompletion(accountId, token, backfill, levels, campaignIds, n => { daysSynced += n; });
    if (result.persisted) newEarliest = result.persisted;

    // A month only counts as backfilled (newest_synced advances past it) if
    // it completed with NO gaps — otherwise the next sync must retry this
    // same month from its own gap point, not silently skip past it.
    if (result.reachedSince) {
      newestSynced = backfill.since === floorDate ? floorDate : addDays(backfill.since, -1);
      await query(`UPDATE agency_meta_sync_state SET newest_synced = $2, updated_at = now() WHERE account_id = $1`, [accountId, newestSynced]);
      if (backfill.since === floorDate) {
        backfillComplete = true;
        newEarliest = floorDate;
        await query(`UPDATE agency_meta_sync_state SET backfill_complete = true, earliest_synced = $2, updated_at = now() WHERE account_id = $1`, [accountId, floorDate]);
      }
    } else {
      break; // gap encountered — stop here, retry this month on the next sync
    }
  }

  return { daysSynced, newEarliestDate: newEarliest };
}

// ── Step 3: creative sync (static assets + DCO breakdown) ───────────────
interface AdCreativeResp {
  id?: string;
  effective_status?: string;
  creative?: {
    id?: string;
    image_url?: string; image_hash?: string; thumbnail_url?: string; video_id?: string;
    body?: string; title?: string;
    object_story_spec?: {
      link_data?: { picture?: string; message?: string; name?: string; child_attachments?: { image_hash?: string; picture?: string; name?: string; description?: string }[] };
      video_data?: { image_url?: string; video_id?: string; title?: string; message?: string };
    };
  };
}

interface AssetDerived {
  assetKey: string;
  type: 'image' | 'video' | 'carousel-slide' | 'unknown';
  thumbnail: string | null;
  videoId: string | null;
  body: string | null;
  title: string | null;
  adId: string;
  weight: number;
}

// Same CASE 1-5 derivation as /api/meta/creatives — ported (not shared) since
// it operates on a differently-shaped context here (no per-request insight
// row, just the ad's creative payload). See lib/meta.ts comment on
// resolveResultsFromActions for why this one isn't merged too.
function deriveAssets(adId: string, creative: AdCreativeResp['creative']): AssetDerived[] {
  const linkData = creative?.object_story_spec?.link_data;
  const videoData = creative?.object_story_spec?.video_data;
  const carouselSlides = linkData?.child_attachments;
  const adBody = videoData?.message || linkData?.message || creative?.body || null;
  const adTitle = videoData?.title || linkData?.name || creative?.title || null;

  if (carouselSlides && carouselSlides.length > 0) {
    const weight = 1 / carouselSlides.length;
    return carouselSlides.map((slide, i) => ({
      // Matches the live route's key exactly (bare image_hash, no "image:"
      // prefix) — see creatives/route.ts CASE 1 — so a carousel slide's
      // asset identity is identical between live and cached mode.
      assetKey: slide.image_hash || `${creative?.id || adId}#slide${i}`,
      type: 'carousel-slide' as const,
      thumbnail: slide.picture || null,
      videoId: null,
      body: slide.description || adBody,
      title: slide.name || adTitle,
      adId, weight,
    }));
  }

  const sourceVideoId = videoData?.video_id || creative?.video_id;
  if (sourceVideoId) {
    return [{
      assetKey: `video:${sourceVideoId}`,
      type: 'video' as const,
      thumbnail: videoData?.image_url || creative?.thumbnail_url || creative?.image_url || null,
      videoId: sourceVideoId,
      body: adBody, title: adTitle, adId, weight: 1,
    }];
  }

  if (creative?.image_hash || creative?.image_url || linkData?.picture) {
    const hash = creative?.image_hash;
    return [{
      assetKey: hash ? `image:${hash}` : `creative:${creative?.id || adId}`,
      type: 'image' as const,
      thumbnail: linkData?.picture || creative?.image_url || creative?.thumbnail_url || null,
      videoId: null, body: adBody, title: adTitle, adId, weight: 1,
    }];
  }

  if (creative?.thumbnail_url) {
    let key = creative.thumbnail_url;
    try { const u = new URL(creative.thumbnail_url); key = `thumb:${u.pathname}`; } catch { /* keep raw */ }
    return [{
      assetKey: key, type: 'image' as const, thumbnail: creative.thumbnail_url,
      videoId: null, body: adBody, title: adTitle, adId, weight: 1,
    }];
  }

  return [{
    assetKey: `creative:${creative?.id || adId}`, type: 'unknown' as const, thumbnail: null,
    videoId: null, body: adBody, title: adTitle, adId, weight: 1,
  }];
}

interface BreakdownRow {
  ad_id?: string; date_start?: string; spend?: string; impressions?: string; inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
  image_asset?: { hash?: string }; video_asset?: { video_id?: string };
}

async function syncCreatives(accountId: string, token: string, floorDate: string, yesterday: string): Promise<void> {
  // 1) Ads + their creative metadata — derive asset identity per ad.
  const adsUrl = new URL(`${GRAPH}/act_${accountId}/ads`);
  adsUrl.searchParams.set('fields', 'id,effective_status,creative{id,image_url,image_hash,thumbnail_url,video_id,body,title,object_story_spec}');
  adsUrl.searchParams.set('limit', '50');
  adsUrl.searchParams.set('filtering', JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE','PAUSED','CAMPAIGN_PAUSED','ADSET_PAUSED'] }]));
  adsUrl.searchParams.set('access_token', token);
  const ads = await fetchMetaWithRetry<AdCreativeResp>(adsUrl);

  const assetsByKey = new Map<string, AssetDerived & { thumbnail: string | null }>();
  // Keyed by `${assetKey} ${adId}` — sums weight when the same ad
  // references the same asset more than once (e.g. two carousel slides
  // sharing one image hash within a single ad), rather than the later
  // write silently overwriting the earlier one's weight.
  const adMapByPair = new Map<string, { assetKey: string; adId: string; weight: number }>();
  for (const ad of ads) {
    if (!ad.id) continue;
    for (const derived of deriveAssets(ad.id, ad.creative)) {
      const existing = assetsByKey.get(derived.assetKey);
      if (!existing) assetsByKey.set(derived.assetKey, derived);
      else if (!existing.thumbnail && derived.thumbnail) existing.thumbnail = derived.thumbnail;
      const pairKey = `${derived.assetKey} ${derived.adId}`;
      const existingPair = adMapByPair.get(pairKey);
      if (existingPair) existingPair.weight += derived.weight;
      else adMapByPair.set(pairKey, { assetKey: derived.assetKey, adId: derived.adId, weight: derived.weight });
    }
  }
  const adMap = Array.from(adMapByPair.values());

  // Batched upserts — same rationale as syncEntities/syncInsightsChunk. A
  // large account can have thousands of distinct assets and tens of
  // thousands of asset-to-ad mappings; one round-trip per row was enough to
  // trip Railway's Postgres log-rate cap.
  const assetList = Array.from(assetsByKey.values());
  for (const batch of chunkArrayGeneric(assetList, DB_BATCH_SIZE)) {
    await query(
      `INSERT INTO meta_creative_assets (account_id, asset_key, type, thumbnail, thumbnail_fetched_at, video_id, body, title, updated_at)
       SELECT $1, asset_key, type, thumbnail,
              CASE WHEN thumbnail IS NOT NULL THEN now() ELSE NULL END,
              video_id, body, title, now()
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
         AS t(asset_key, type, thumbnail, video_id, body, title)
       ON CONFLICT (account_id, asset_key) DO UPDATE SET
         type = EXCLUDED.type,
         thumbnail = COALESCE(EXCLUDED.thumbnail, meta_creative_assets.thumbnail),
         thumbnail_fetched_at = CASE WHEN EXCLUDED.thumbnail IS NOT NULL THEN now() ELSE meta_creative_assets.thumbnail_fetched_at END,
         video_id = EXCLUDED.video_id, body = EXCLUDED.body, title = EXCLUDED.title, updated_at = now()`,
      [
        accountId,
        batch.map(a => a.assetKey), batch.map(a => a.type), batch.map(a => a.thumbnail),
        batch.map(a => a.videoId), batch.map(a => a.body), batch.map(a => a.title),
      ]
    );
  }
  for (const batch of chunkArrayGeneric(adMap, DB_BATCH_SIZE)) {
    await query(
      `INSERT INTO meta_creative_asset_ad_map (account_id, asset_key, ad_id, weight)
       SELECT $1, asset_key, ad_id, weight
       FROM unnest($2::text[], $3::text[], $4::numeric[]) AS t(asset_key, ad_id, weight)
       ON CONFLICT (account_id, asset_key, ad_id) DO UPDATE SET weight = EXCLUDED.weight`,
      [accountId, batch.map(m => m.assetKey), batch.map(m => m.adId), batch.map(m => m.weight)]
    );
  }

  // 2) Image/video full-res enrichment — same batching as the live routes.
  // Two key shapes carry a real Meta image hash: "image:<hash>" (CASE 3,
  // single-image ads) and a bare "<hash>" (carousel slides — deriveAssets
  // uses slide.image_hash directly, unprefixed, to match the live route's
  // asset identity exactly). Both are eligible for the /adimages full-res
  // lookup; without the bare-hash branch, carousel slides were permanently
  // stuck on Meta's blurry ~64x64 slide.picture preview.
  const hashToAssetKey = new Map<string, string>();
  for (const key of Array.from(assetsByKey.keys())) {
    if (key.startsWith('image:')) {
      const hash = key.slice('image:'.length);
      if (/^[a-f0-9]{20,}$/i.test(hash)) hashToAssetKey.set(hash, key);
    } else if (/^[a-f0-9]{20,}$/i.test(key)) {
      hashToAssetKey.set(key, key);
    }
  }
  const imageHashes = Array.from(hashToAssetKey.keys());
  if (imageHashes.length > 0) {
    try {
      const u = new URL(`${GRAPH}/act_${accountId}/adimages`);
      u.searchParams.set('hashes', JSON.stringify(imageHashes));
      u.searchParams.set('fields', 'hash,url,permalink_url');
      u.searchParams.set('access_token', token);
      const res = await fetch(u.toString());
      const json = await res.json() as { data?: { hash?: string; url?: string; permalink_url?: string }[] };
      for (const img of json.data || []) {
        const better = img.url || img.permalink_url;
        const assetKey = img.hash ? hashToAssetKey.get(img.hash) : undefined;
        if (assetKey && better) {
          await query(
            `UPDATE meta_creative_assets SET thumbnail = $3, thumbnail_fetched_at = now(), updated_at = now() WHERE account_id = $1 AND asset_key = $2`,
            [accountId, assetKey, better]
          );
        }
      }
    } catch { /* leave stored thumbnail as-is */ }
  }

  const videoIds = Array.from(new Set(Array.from(assetsByKey.values()).filter(a => a.type === 'video' && a.videoId).map(a => a.videoId as string)));
  const VIDEO_CHUNK = 50;
  for (let i = 0; i < videoIds.length; i += VIDEO_CHUNK) {
    const chunk = videoIds.slice(i, i + VIDEO_CHUNK);
    try {
      const u = new URL(`${GRAPH}/`);
      u.searchParams.set('ids', chunk.join(','));
      u.searchParams.set('fields', 'source,picture');
      u.searchParams.set('access_token', token);
      const res = await fetch(u.toString());
      const json = await res.json() as Record<string, { source?: string; picture?: string; error?: { code?: number; error_subcode?: number } }>;
      for (const vid of chunk) {
        let entry = json[vid];
        const failedAuth = entry?.error?.code === 100 && entry?.error?.error_subcode === 33;
        if ((!entry?.source || failedAuth) ) {
          try {
            const u2 = `${GRAPH}/act_${accountId}/advideos/${vid}?fields=source,picture&access_token=${token}`;
            const res2 = await fetch(u2);
            const json2 = await res2.json() as { source?: string; picture?: string };
            entry = { source: entry?.source || json2.source, picture: entry?.picture || json2.picture };
          } catch { /* keep whatever we had */ }
        }
        if (entry?.source) {
          await query(
            `UPDATE meta_creative_assets SET video_source = $3, video_source_fetched_at = now(), updated_at = now() WHERE account_id = $1 AND asset_key = $2`,
            [accountId, `video:${vid}`, entry.source]
          );
        }
        if (entry?.picture) {
          await query(
            `UPDATE meta_creative_assets SET thumbnail = COALESCE(thumbnail, $3), thumbnail_fetched_at = now(), updated_at = now() WHERE account_id = $1 AND asset_key = $2`,
            [accountId, `video:${vid}`, entry.picture]
          );
        }
      }
    } catch { /* leave stored video source as-is */ }
  }

  // 3) DCO per-asset-per-day breakdown (image_asset / video_asset). Walks
  // the same top-up (recent days, every run) / month-chunked recent-first
  // backfill split as syncInsights (see buildSyncRanges / runRangeToCompletion) —
  // repeat "Sync now" clicks used to always re-walk the full 37-month range
  // here, which is both slow and needlessly overwrote already-final days.
  const breakdownTypes: ('image_asset' | 'video_asset')[] = ['image_asset', 'video_asset'];

  const runBreakdownRange = async (range: { since: string; until: string; kind: 'topup' | 'backfill' }): Promise<{ persisted: string | null; reachedSince: boolean }> => {
    const chunksAscending = chunkRange(range.since, range.until, CHUNK_DAYS);
    const chunks = range.kind === 'backfill' ? [...chunksAscending].reverse() : chunksAscending;
    if (chunks.length === 0) return { persisted: null, reachedSince: false };

    // completed[i] flips true once BOTH breakdown types finish for chunk i;
    // the persisted watermark only advances past a gap-free completed
    // prefix, same rationale as syncInsights (a mid-run crash loses at most
    // a few chunks, not the whole range).
    const completed = new Array(chunks.length).fill(false);
    const typesRemaining = new Array(chunks.length).fill(breakdownTypes.length);
    let persistedIdx = -1;
    let persistedValue: string | null = null;

    const persistUpTo = async (idx: number) => {
      if (idx <= persistedIdx) return;
      persistedIdx = idx;
      if (range.kind === 'backfill') {
        persistedValue = chunks[idx].since;
        await query(`UPDATE agency_meta_sync_state SET creatives_earliest_synced = $2, updated_at = now() WHERE account_id = $1`, [accountId, persistedValue]);
      }
    };

    const units: { breakdown: 'image_asset' | 'video_asset'; chunkIdx: number; chunk: { since: string; until: string } }[] = [];
    for (let i = 0; i < chunks.length; i++) for (const b of breakdownTypes) units.push({ breakdown: b, chunkIdx: i, chunk: chunks[i] });

    await runPooled(units, SYNC_CONCURRENCY, async ({ breakdown, chunkIdx, chunk }) => {
      const u = new URL(`${GRAPH}/act_${accountId}/insights`);
      u.searchParams.set('level', 'ad');
      u.searchParams.set('breakdowns', breakdown);
      u.searchParams.set('fields', 'ad_id,spend,impressions,inline_link_clicks,actions');
      u.searchParams.set('time_range', JSON.stringify(chunk));
      u.searchParams.set('time_increment', '1');
      u.searchParams.set('limit', '500');
      u.searchParams.set('action_attribution_windows', ATTRIBUTION_WINDOWS);
      u.searchParams.set('access_token', token);
      let rows: BreakdownRow[] = [];
      try { rows = await fetchMetaWithRetry<BreakdownRow>(u); } catch { /* leave chunk incomplete, retried on the next sync */ }

      interface PreparedBreakdown { assetKey: string; adId: string; date: string; spend: number; impressions: number; linkClicks: number; results: number }
      // Keyed by `${assetKey}|${adId}|${date}` and summed on collision — Meta
      // can return the same (asset, ad, day) combination more than once within
      // a single breakdown fetch (e.g. across attribution-window buckets), and
      // a batched multi-row upsert can't touch the same conflict target twice
      // in one statement ("ON CONFLICT DO UPDATE command cannot affect row a
      // second time"), unlike the old row-by-row loop where each write was its
      // own statement and simply overwrote the previous one.
      const preparedByKey = new Map<string, PreparedBreakdown>();
      for (const r of rows) {
        const assetHash = breakdown === 'image_asset' ? r.image_asset?.hash : r.video_asset?.video_id;
        const assetKey = breakdown === 'image_asset' ? (assetHash ? `image:${assetHash}` : null) : (assetHash ? `video:${assetHash}` : null);
        if (!assetKey || !r.ad_id || !r.date_start) continue;
        const key = `${assetKey}|${r.ad_id}|${r.date_start}`;
        const spend = parseFloat(r.spend || '0') || 0;
        const impressions = parseInt(r.impressions || '0', 10) || 0;
        const linkClicks = parseInt(r.inline_link_clicks || '0', 10) || 0;
        const results = resolveResultsFromActions(r.actions);
        const existing = preparedByKey.get(key);
        if (existing) {
          existing.spend += spend;
          existing.impressions += impressions;
          existing.linkClicks += linkClicks;
          existing.results += results;
        } else {
          preparedByKey.set(key, { assetKey, adId: r.ad_id, date: r.date_start, spend, impressions, linkClicks, results });
        }
      }
      const prepared = Array.from(preparedByKey.values());

      // Batched upsert — this is the highest-volume write in the whole sync
      // (per asset × per ad × per day), the main source of the row-by-row
      // Postgres log flood this batching pass fixes.
      for (const batch of chunkArrayGeneric(prepared, DB_BATCH_SIZE)) {
        await query(
          `INSERT INTO meta_asset_breakdown_daily (account_id, asset_key, ad_id, date, spend, impressions, link_clicks, results)
           SELECT $1, asset_key, ad_id, date::date, spend, impressions, link_clicks, results
           FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::bigint[], $7::bigint[], $8::bigint[])
             AS t(asset_key, ad_id, date, spend, impressions, link_clicks, results)
           ON CONFLICT (account_id, asset_key, ad_id, date) DO UPDATE SET
             spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, link_clicks = EXCLUDED.link_clicks, results = EXCLUDED.results`,
          [
            accountId,
            batch.map(p => p.assetKey), batch.map(p => p.adId), batch.map(p => p.date),
            batch.map(p => p.spend), batch.map(p => p.impressions), batch.map(p => p.linkClicks), batch.map(p => p.results),
          ]
        );
      }

      typesRemaining[chunkIdx]--;
      if (typesRemaining[chunkIdx] === 0) {
        completed[chunkIdx] = true;
        let cursor = persistedIdx + 1;
        while (cursor < completed.length && completed[cursor]) cursor++;
        if (cursor > persistedIdx + 1) await persistUpTo(cursor - 1);
      }
    });

    return { persisted: persistedValue, reachedSince: chunks.length > 0 && completed.every(c => c) };
  };

  const [creativesState] = await query<{ creatives_earliest_synced: string | null; creatives_backfill_complete: boolean; creatives_newest_synced: string | null; last_success_until: string | null }>(
    `SELECT creatives_earliest_synced, creatives_backfill_complete, creatives_newest_synced, last_success_until FROM agency_meta_sync_state WHERE account_id = $1`,
    [accountId]
  );
  let creativesEarliest = creativesState?.creatives_earliest_synced ?? null;
  let creativesNewest = creativesState?.creatives_newest_synced ?? null;
  let creativesBackfillComplete = creativesState?.creatives_backfill_complete ?? false;
  let topUpDone = false;

  // Same month-at-a-time, recent-first loop as syncInsights (see there for
  // full rationale, including the time-budget cap) — own watermark
  // (creatives_*), since creatives hit a different Meta endpoint and can
  // finish backfilling at a different pace.
  let guard = BACKFILL_MONTHS + 2;
  const startedAt = Date.now();
  while (guard-- > 0) {
    const ranges = buildSyncRanges(floorDate, yesterday, creativesState?.last_success_until ?? null, creativesNewest, creativesEarliest, creativesBackfillComplete);
    const topUp = !topUpDone ? ranges.find(r => r.kind === 'topup') : undefined;
    const backfill = ranges.find(r => r.kind === 'backfill');
    if (!topUp && !backfill) break;

    if (topUp) {
      topUpDone = true;
      await runBreakdownRange(topUp);
    }
    if (!backfill) continue;
    if (Date.now() - startedAt > INSIGHTS_BACKFILL_BUDGET_MS) break;
    const result = await runBreakdownRange(backfill);
    if (result.persisted) creativesEarliest = result.persisted;

    if (result.reachedSince) {
      creativesNewest = backfill.since === floorDate ? floorDate : addDays(backfill.since, -1);
      await query(`UPDATE agency_meta_sync_state SET creatives_newest_synced = $2, updated_at = now() WHERE account_id = $1`, [accountId, creativesNewest]);
      if (backfill.since === floorDate) {
        creativesBackfillComplete = true;
        creativesEarliest = floorDate;
        await query(`UPDATE agency_meta_sync_state SET creatives_backfill_complete = true, creatives_earliest_synced = $2, updated_at = now() WHERE account_id = $1`, [accountId, floorDate]);
      }
    } else {
      break; // gap encountered — stop here, retry this month on the next sync
    }
  }
}

// ── Public entry points ──────────────────────────────────────────────────
export async function syncAccount(accountId: string): Promise<SyncAccountResult> {
  const claimed = await claimSync(accountId);
  if (!claimed) {
    return { accountId, entitiesUpserted: 0, daysSynced: 0, newEarliestDate: null, error: 'Sync already in progress' };
  }

  let entitiesUpserted = 0;
  let daysSynced = 0;
  let newEarliestDate: string | null = null;
  let firstError: string | null = null;

  try {
    const token = await tokenForAccountId(accountId);

    // Each step runs independently — a huge account (Omega: ~58k entities,
    // ~8k campaigns) can exhaust its rate-limit budget partway through
    // insights alone, and insights previously ran to full exhaustion (or a
    // thrown error) before creatives ever got a turn. That left creatives
    // — separate assets/thumbnails/DCO metrics, not derivable from insights
    // — completely unsynced (0 rows) after dozens of "Sync now" clicks, even
    // though insights was making real progress each time. Now every step
    // gets a chance on every run, so a slow account's Creatives tab starts
    // filling in instead of waiting behind an insights backfill that may
    // never fully finish in one sitting.
    try {
      entitiesUpserted = await syncEntities(accountId, token);
    } catch (err: unknown) {
      firstError = firstError ?? (err instanceof Error ? err.message : 'Entity sync failed');
      console.error('[META-SYNC-ERR]', JSON.stringify({ accountId, step: 'entities', error: firstError }));
    }

    try {
      const result = await syncInsights(accountId, token);
      daysSynced = result.daysSynced;
      newEarliestDate = result.newEarliestDate;
    } catch (err: unknown) {
      firstError = firstError ?? (err instanceof Error ? err.message : 'Insights sync failed');
      console.error('[META-SYNC-ERR]', JSON.stringify({ accountId, step: 'insights', error: firstError }));
    }

    try {
      const yesterday = await yesterdayForAccount(accountId, token);
      // Reuse floorDateFrom() rather than a separate `BACKFILL_MONTHS * 30.4
      // days back` calculation — that duplicate arithmetic landed on a date
      // Meta rejects with "(#3018) start date ... cannot be beyond 37 months",
      // the same boundary floorDateFrom() already pads a day inside of.
      const floorDate = floorDateFrom(yesterday);
      await syncCreatives(accountId, token, floorDate, yesterday);
    } catch (err: unknown) {
      firstError = firstError ?? (err instanceof Error ? err.message : 'Creatives sync failed');
      console.error('[META-SYNC-ERR]', JSON.stringify({ accountId, step: 'creatives', error: firstError }));
    }

    await finishSync(accountId, { success: !firstError, error: firstError ?? undefined });
    return { accountId, entitiesUpserted, daysSynced, newEarliestDate, error: firstError };
  } catch (err: unknown) {
    // Only token resolution reaches here now — the three sync steps above
    // catch their own failures so partial progress from earlier steps is
    // never lost, but without a token none of them can run at all.
    const message = err instanceof Error ? err.message : 'Sync failed';
    await finishSync(accountId, { success: false, error: message });
    return { accountId, entitiesUpserted: 0, daysSynced: 0, newEarliestDate: null, error: message };
  }
}

export interface BackfillProgress {
  monthsTotal: number;
  monthsDone: number;
  complete: boolean;
}

// Admin-panel progress display, combining insights + creatives into one
// number (the slower of the two) so an admin sees a single "N of M months"
// figure rather than two that can disagree — per-type detail isn't needed
// at this altitude, just "how much usable history exists yet." Computed
// from the persisted watermark columns only (no live Meta call), using the
// server's own clock for `yesterday` — a day or two of timezone slop
// doesn't matter for a month-granularity progress bar, unlike the sync
// engine itself which needs the account's exact timezone for date_range
// correctness.
export function computeBackfillProgress(state: {
  newest_synced: string | null; earliest_synced: string | null; backfill_complete: boolean;
  creatives_newest_synced: string | null; creatives_earliest_synced: string | null; creatives_backfill_complete: boolean;
}): BackfillProgress {
  const yesterday = fmtDate(new Date(Date.now() - 86400000));
  const floorDate = floorDateFrom(yesterday);
  const monthsTotal = monthsInRange(floorDate, yesterday);

  const monthsDoneFor = (newestSynced: string | null, earliestSynced: string | null, backfillComplete: boolean): number => {
    if (backfillComplete) return monthsTotal;
    // Steady state (new model): newest_synced walks from yesterday down to
    // floorDate — months strictly newer than its frontier are done.
    if (newestSynced) return Math.min(monthsTotal, monthsInRange(newestSynced, yesterday));
    // Legacy accounts mid-transition: newest_synced hasn't been set yet by
    // a sync run under the new code, but earliest_synced may already
    // reflect real progress from the old oldest-first model. That range
    // ([earliest_synced, yesterday]) is exactly what the old model's chunk
    // loop actually walks newest-first within its remaining span (see the
    // `.reverse()` in runRangeToCompletion) — so it's already the newest N
    // months, safe to count as done until the next sync run initializes
    // newest_synced for real.
    return earliestSynced ? Math.min(monthsTotal, monthsInRange(earliestSynced, yesterday)) : 0;
  };

  const insightsDone = monthsDoneFor(state.newest_synced, state.earliest_synced, state.backfill_complete);
  const creativesDone = monthsDoneFor(state.creatives_newest_synced, state.creatives_earliest_synced, state.creatives_backfill_complete);
  const monthsDone = Math.min(insightsDone, creativesDone);

  return { monthsTotal, monthsDone, complete: state.backfill_complete && state.creatives_backfill_complete };
}

export interface MonthCoverage {
  month: string; // "YYYY-MM"
  since: string; // this month's actual date range within [floorDate, yesterday]
  until: string;
  insightsRows: number;
  creativesRows: number;
}

// Ground-truth coverage, read directly from the fact tables rather than the
// watermark — the watermark only advances past a GAP-FREE month, but a
// gapped month can still have partial real data (see the exception-
// swallows-persist-progress fix), and an admin auditing "what do we
// actually have" should see that partial data, not just "not done yet".
// Used by the admin panel's coverage timeline; not used by the sync engine
// itself (which still relies on the cheaper watermark columns to decide
// where to resume, per computeBackfillProgress's own comment on why).
export async function getMonthlyCoverage(accountId: string): Promise<MonthCoverage[]> {
  const yesterday = fmtDate(new Date(Date.now() - 86400000));
  const floorDate = floorDateFrom(yesterday);
  const months = monthsBackFrom(floorDate, yesterday); // oldest-first for a natural left-to-right timeline

  const [insightsRows, creativesRows] = await Promise.all([
    query<{ month: string; n: string }>(
      `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month, count(DISTINCT date)::text AS n
       FROM meta_daily_insights WHERE account_id = $1 AND level = 'campaign' AND date BETWEEN $2 AND $3
       GROUP BY 1`,
      [accountId, floorDate, yesterday]
    ),
    query<{ month: string; n: string }>(
      `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month, count(DISTINCT date)::text AS n
       FROM meta_asset_breakdown_daily WHERE account_id = $1 AND date BETWEEN $2 AND $3
       GROUP BY 1`,
      [accountId, floorDate, yesterday]
    ),
  ]);
  const insightsByMonth = new Map(insightsRows.map(r => [r.month, parseInt(r.n, 10)]));
  const creativesByMonth = new Map(creativesRows.map(r => [r.month, parseInt(r.n, 10)]));

  return months.map(({ since, until }) => {
    const month = since.slice(0, 7);
    return { month, since, until, insightsRows: insightsByMonth.get(month) ?? 0, creativesRows: creativesByMonth.get(month) ?? 0 };
  });
}

// Same calendar-month bucketing buildSyncRanges uses internally, exposed
// oldest-first (buildSyncRanges itself only ever needs the single next
// month, newest-first, so this full ordered list lives here instead).
function monthsBackFrom(floorDate: string, yesterday: string): { since: string; until: string }[] {
  const out: { since: string; until: string }[] = [];
  let cursor = yesterday;
  while (daysBetween(floorDate, cursor) >= 0) {
    const rawStart = monthStart(cursor);
    const since = daysBetween(floorDate, rawStart) > 0 ? rawStart : floorDate;
    out.push({ since, until: cursor });
    if (since === floorDate) break;
    cursor = addDays(since, -1);
  }
  return out.reverse();
}

// On-demand sync for an admin-specified date range, independent of the
// watermark-driven sequential walk — lets an admin fill a specific known
// gap (visible in the coverage timeline) without waiting for the normal
// backfill to reach it. Does NOT read or write newest_synced/
// earliest_synced/backfill_complete — those stay owned by the sequential
// walk in syncInsights/syncCreatives, so a targeted gap-fill can't
// interfere with (or be confused for) normal backfill progress.
export async function syncAccountRange(accountId: string, since: string, until: string): Promise<{ daysSynced: number; error: string | null }> {
  const claimed = await claimSync(accountId);
  if (!claimed) return { daysSynced: 0, error: 'Sync already in progress' };
  try {
    const token = await tokenForAccountId(accountId);
    const levels: ('campaign' | 'adset' | 'ad')[] = ['campaign', 'adset', 'ad'];
    const campaignIds = await campaignIdsForAccount(accountId);
    let daysSynced = 0;
    for (const chunk of chunkRange(since, until, CHUNK_DAYS)) {
      for (const level of levels) {
        const { written } = await syncInsightsChunk(accountId, token, level, chunk.since, chunk.until, campaignIds);
        if (level === 'campaign') daysSynced += written > 0 ? daysBetween(chunk.since, chunk.until) + 1 : 0;
      }
    }
    await finishSync(accountId, { success: true });
    return { daysSynced, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Range sync failed';
    await finishSync(accountId, { success: false, error: message });
    return { daysSynced: 0, error: message };
  }
}

export async function syncClientAccounts(clientId: string): Promise<SyncAccountResult[]> {
  const [client] = await query<{ ad_account_ids: string[] | null }>(
    `SELECT ad_account_ids FROM clients WHERE id = $1`,
    [clientId]
  );
  let accountIds = client?.ad_account_ids || [];
  if (accountIds.length === 0) {
    const rows = await query<{ account_ids: string[] }>(`SELECT account_ids FROM agency_bm_connections`);
    accountIds = Array.from(new Set(rows.flatMap(r => r.account_ids || [])));
  }
  const results: SyncAccountResult[] = [];
  for (const accountId of accountIds) {
    results.push(await syncAccount(accountId));
  }
  return results;
}
