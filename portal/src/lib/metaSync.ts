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

// Meta's "too many rows" row-cap error (error_subcode 1487534) is NOT
// transient (Meta marks it is_transient: false) — retrying with backoff
// never helps, the only fix is a narrower request. Callers that can retry
// with a smaller date range (see syncInsightsChunk) catch this specifically;
// everything else just fails the sync run same as any other hard error.
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
        if (json.error.error_subcode === 1487534) throw new RowCapError(json.error.message || 'Too many rows');
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
      if (!(err instanceof RowCapError) || batch.length === 1) {
        if (err instanceof RowCapError) {
          console.error('[META-SYNC-ERR]', JSON.stringify({ accountId, level, since, until, campaignId: batch[0], error: 'row cap persists at single-campaign granularity, skipping' }));
          hadGaps = true;
          continue;
        }
        throw err;
      }
      // Halve the batch and retry each half individually.
      const mid = Math.ceil(batch.length / 2);
      const halves = [batch.slice(0, mid), batch.slice(mid)];
      for (const half of halves) {
        const sub = await fetchInsightsChunkWithRowCapFallback(accountId, token, level, since, until, half);
        out.push(...sub.rows);
        if (sub.hadGaps) hadGaps = true;
      }
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
}

async function syncInsights(accountId: string, token: string): Promise<{ daysSynced: number; newEarliestDate: string | null }> {
  const [state] = await query<SyncState>(
    `SELECT earliest_synced, last_success_until, backfill_complete FROM agency_meta_sync_state WHERE account_id = $1`,
    [accountId]
  );

  const yesterday = await yesterdayForAccount(accountId, token);
  const floorDate = floorDateFrom(yesterday);
  const levels: ('campaign' | 'adset' | 'ad')[] = ['campaign', 'adset', 'ad'];
  const campaignIds = await campaignIdsForAccount(accountId);

  const ranges: { since: string; until: string; kind: 'topup' | 'backfill' }[] = [];

  // Forward top-up: re-pull the last 7 days (or from floorDate on first run)
  // through yesterday, every run — Meta's attribution windows mutate recent
  // days for up to 7 days after the fact, so cached numbers must not freeze
  // before that window closes. Clamp to floorDate so this never reaches
  // earlier than the account's configured history floor.
  const topUpSince = state?.last_success_until
    ? (daysBetween(floorDate, addDays(state.last_success_until, -7)) > 0 ? addDays(state.last_success_until, -7) : floorDate)
    : floorDate;
  if (daysBetween(topUpSince, yesterday) >= 0) ranges.push({ since: topUpSince, until: yesterday, kind: 'topup' });

  // Backward backfill: continue from earliest_synced down to floorDate. Kept
  // as its own range (distinct from top-up, even on a first run where both
  // happen to start at floorDate) so a first-ever sync's giant 37-month walk
  // gets its own incremental watermark progress below, instead of being
  // silently folded into the top-up range with no per-chunk persistence.
  if (!state?.backfill_complete) {
    const backfillUntil = state?.earliest_synced ? addDays(state.earliest_synced, -1) : addDays(topUpSince, -1);
    if (daysBetween(floorDate, backfillUntil) >= 0) ranges.push({ since: floorDate, until: backfillUntil, kind: 'backfill' });
  }

  let daysSynced = 0;
  let newEarliest = state?.earliest_synced || null;

  for (const range of ranges) {
    // Chunks are processed oldest-to-newest for backfill (walking the
    // watermark backward) and in natural order for top-up; either way we
    // need the chunk list sorted so "contiguous prefix completed" has a
    // well-defined meaning under concurrent (out-of-order-finishing) execution.
    const chunksAscending = chunkRange(range.since, range.until, CHUNK_DAYS);
    const chunks = range.kind === 'backfill' ? [...chunksAscending].reverse() : chunksAscending;

    // Tracks which chunk indices have finished (all 3 levels) so we can
    // advance the persisted watermark past the longest completed PREFIX
    // only — never past a chunk whose predecessor hasn't finished yet, even
    // if it happens to complete first under concurrency. This is what makes
    // a mid-run crash lose at most a few chunks of progress instead of the
    // entire range (the bug this fixes: previously the watermark was only
    // written after ALL chunks in a range — which could be ~375 chunks on a
    // first-ever 37-month sync — had completed).
    //
    // gapped[i] marks a chunk that completed but had a campaign silently
    // skipped due to a persistent row cap (see
    // fetchInsightsChunkWithRowCapFallback). The persisted prefix must stop
    // AT (not past) the first gapped chunk, so a future sync's backfill
    // range naturally starts from there again instead of the gap being
    // permanently skipped past and never retried.
    const completed = new Array(chunks.length).fill(false);
    const gapped = new Array(chunks.length).fill(false);
    let persistedIdx = -1; // last index (into `chunks`) whose watermark has been persisted
    let stoppedAtGap = false;

    const persistUpTo = async (idx: number) => {
      if (idx <= persistedIdx) return;
      persistedIdx = idx;
      const frontier = chunks[idx]; // the oldest (backfill) or newest (top-up) fully-completed chunk so far
      if (range.kind === 'topup') {
        await query(`UPDATE agency_meta_sync_state SET last_success_until = $2, updated_at = now() WHERE account_id = $1`, [accountId, frontier.until]);
      } else {
        newEarliest = frontier.since;
        await query(`UPDATE agency_meta_sync_state SET earliest_synced = $2, updated_at = now() WHERE account_id = $1`, [accountId, newEarliest]);
      }
    };

    const units: { level: 'campaign' | 'adset' | 'ad'; chunkIdx: number; chunk: { since: string; until: string } }[] = [];
    for (let i = 0; i < chunks.length; i++) for (const level of levels) units.push({ level, chunkIdx: i, chunk: chunks[i] });

    // Count of levels remaining before a chunk counts as "fully done".
    const levelsRemaining = new Array(chunks.length).fill(levels.length);

    await runPooled(units, SYNC_CONCURRENCY, async ({ level, chunkIdx, chunk }) => {
      const { hadGaps } = await syncInsightsChunk(accountId, token, level, chunk.since, chunk.until, campaignIds);
      if (hadGaps) gapped[chunkIdx] = true;
      if (level === 'campaign') {
        daysSynced += daysBetween(chunk.since, chunk.until) + 1;
      }
      levelsRemaining[chunkIdx]--;
      if (levelsRemaining[chunkIdx] === 0) {
        completed[chunkIdx] = true;
        // Advance persistedIdx past the longest contiguous completed,
        // NOT-gapped prefix starting right after what's already persisted.
        // Stop (and don't persist) at the first gapped chunk so the next
        // sync's backfill range restarts from there and retries it.
        let cursor = persistedIdx + 1;
        while (cursor < completed.length && completed[cursor] && !gapped[cursor]) cursor++;
        if (cursor > persistedIdx + 1) await persistUpTo(cursor - 1);
        if (cursor < completed.length && completed[cursor] && gapped[cursor]) stoppedAtGap = true;
      }
    });

    // Range finished (or all reachable chunks did) — persist through the
    // longest gap-free prefix one more time in case the loop above's
    // cursor advancement missed a final contiguous run (e.g. the very last
    // chunk to complete was mid-prefix). Never persists past a gapped chunk.
    if (!stoppedAtGap && chunks.length > 0) {
      let cursor = persistedIdx + 1;
      while (cursor < completed.length && completed[cursor] && !gapped[cursor]) cursor++;
      if (cursor > persistedIdx + 1) await persistUpTo(cursor - 1);
    }
  }

  // Backfill is complete once we've reached floorDate with earliest_synced
  // actually advanced all the way there — which happens only if no chunk
  // along the way was forced to skip a campaign due to a persistent row cap
  // (see the gap-stopping logic above). An account younger than 37 months
  // naturally returns empty (not skipped) chunks near the floor, which is
  // still a legitimate "no more history" signal, unaffected by this gate.
  const reachedFloor = ranges.some(r => r.kind === 'backfill' && r.since === floorDate) && newEarliest === floorDate;
  if (reachedFloor) {
    await query(`UPDATE agency_meta_sync_state SET backfill_complete = true, earliest_synced = $2, updated_at = now() WHERE account_id = $1`, [accountId, floorDate]);
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

async function syncCreatives(accountId: string, token: string, since: string, until: string): Promise<void> {
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
  const imageHashes = Array.from(new Set(
    Array.from(assetsByKey.keys()).filter(k => k.startsWith('image:')).map(k => k.slice('image:'.length)).filter(h => /^[a-f0-9]{20,}$/i.test(h))
  ));
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
        if (img.hash && better) {
          await query(
            `UPDATE meta_creative_assets SET thumbnail = $3, thumbnail_fetched_at = now(), updated_at = now() WHERE account_id = $1 AND asset_key = $2`,
            [accountId, `image:${img.hash}`, better]
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

  // 3) DCO per-asset-per-day breakdown (image_asset / video_asset).
  const chunks = chunkRange(since, until, CHUNK_DAYS);
  const breakdownTypes: ('image_asset' | 'video_asset')[] = ['image_asset', 'video_asset'];
  const units: { breakdown: 'image_asset' | 'video_asset'; chunk: { since: string; until: string } }[] = [];
  for (const b of breakdownTypes) for (const c of chunks) units.push({ breakdown: b, chunk: c });

  await runPooled(units, SYNC_CONCURRENCY, async ({ breakdown, chunk }) => {
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
    try { rows = await fetchMetaWithRetry<BreakdownRow>(u); } catch { return; }

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
  });
}

// ── Public entry points ──────────────────────────────────────────────────
export async function syncAccount(accountId: string): Promise<SyncAccountResult> {
  const claimed = await claimSync(accountId);
  if (!claimed) {
    return { accountId, entitiesUpserted: 0, daysSynced: 0, newEarliestDate: null, error: 'Sync already in progress' };
  }
  try {
    const token = await tokenForAccountId(accountId);
    const entitiesUpserted = await syncEntities(accountId, token);
    const { daysSynced, newEarliestDate } = await syncInsights(accountId, token);

    const yesterday = await yesterdayForAccount(accountId, token);
    // Reuse floorDateFrom() rather than a separate `BACKFILL_MONTHS * 30.4
    // days back` calculation — that duplicate arithmetic landed on a date
    // Meta rejects with "(#3018) start date ... cannot be beyond 37 months",
    // the same boundary floorDateFrom() already pads a day inside of.
    const creativeSince = floorDateFrom(yesterday);
    await syncCreatives(accountId, token, creativeSince, yesterday);

    await finishSync(accountId, { success: true });
    return { accountId, entitiesUpserted, daysSynced, newEarliestDate, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Sync failed';
    await finishSync(accountId, { success: false, error: message });
    return { accountId, entitiesUpserted: 0, daysSynced: 0, newEarliestDate: null, error: message };
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
