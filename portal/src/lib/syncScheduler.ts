// In-process daily topup scheduler for the DB-backed Meta cache.
//
// Why in-process rather than a separate Railway cron service: this project
// runs as a single always-on Railway service (not serverless), so a plain
// setInterval started from instrumentation.ts (Next's official "run once at
// server boot" hook) needs no new infrastructure, no separate deploy, and no
// extra cost — it just piggybacks on the same process that's already running
// 24/7. See src/instrumentation.ts for the boot wiring.
//
// Scope (per 2026-09-01 agreement): daily topup only. This does NOT drive
// the historical backfill-to-January effort — that was a one-off manual
// queue (see project memory). syncAccount() itself is naturally topup-only
// once an account's backfill_complete flags are true, so calling the exact
// same function here is safe long-term — it won't re-walk the full history
// every day, it just tops up the last few days plus, if backfill isn't
// finished yet, one more backfill-chunk's worth of progress per run.
import { query } from './db';
import { syncAccount } from './metaSync';

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day
const PAUSE_BETWEEN_ACCOUNTS_MS = 20_000; // same deliberate pacing as the manual backfill queue, to avoid Meta rate limits
let started = false;

async function getAllAccountIds(): Promise<string[]> {
  // IMPORTANT: source this from clients.ad_account_ids, NOT
  // agency_bm_connections.account_ids. The BM connections table holds every
  // account a Business Manager token can reach — confirmed 2026-09-01 this
  // is 30 accounts agency-wide, 18 of which are not attached to any client
  // dashboard at all (unused/legacy/not-yet-assigned). Looping all 30 would
  // burn a third of the daily rate-limit budget on accounts nothing ever
  // reads. Dedup still applies — several clients share the same ad account
  // (e.g. the Gym-Members-Now rollup, the many Alloy locations) — so this
  // mirrors the flattening logic already inline in syncClientAccounts(),
  // just scoped to "every account actually in use" instead of per-client.
  const rows = await query<{ ad_account_ids: string[] | null }>(
    `SELECT ad_account_ids FROM clients WHERE ad_account_ids IS NOT NULL AND array_length(ad_account_ids, 1) > 0`
  );
  return Array.from(new Set(rows.flatMap(r => r.ad_account_ids || [])));
}

async function runDailySync() {
  const startedAt = new Date().toISOString();
  console.log('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:start', startedAt }));

  let accountIds: string[] = [];
  try {
    accountIds = await getAllAccountIds();
  } catch (err) {
    console.error('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:accountListError', error: err instanceof Error ? err.message : String(err) }));
    return;
  }

  console.log('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:accounts', count: accountIds.length, accountIds }));

  for (const accountId of accountIds) {
    try {
      const result = await syncAccount(accountId);
      console.log('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:account:done', accountId, result }));
    } catch (err) {
      // syncAccount() already catches its own internal errors and returns
      // them in `result.error` — this catch is only a last-resort guard so
      // one unexpected throw can never take down the rest of the day's
      // accounts.
      console.error('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:account:threw', accountId, error: err instanceof Error ? err.message : String(err) }));
    }
    await new Promise(r => setTimeout(r, PAUSE_BETWEEN_ACCOUNTS_MS));
  }

  console.log('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:complete', startedAt, finishedAt: new Date().toISOString() }));
}

export function startDailySyncScheduler() {
  if (started) return; // instrumentation.ts's register() can fire more than once per process in some Next.js dev-mode reload scenarios
  started = true;

  console.log('[SYNC-SCHEDULER]', JSON.stringify({ step: 'scheduler:armed', intervalMs: RUN_INTERVAL_MS }));

  // Fire once shortly after boot (covers the case where the process was
  // down across a would-be run, e.g. a redeploy), then on a fixed interval.
  // A short initial delay avoids competing with the rest of the app's own
  // startup work for DB connections.
  setTimeout(() => {
    runDailySync().catch(err => console.error('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:fatal', error: err instanceof Error ? err.message : String(err) })));
    setInterval(() => {
      runDailySync().catch(err => console.error('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:fatal', error: err instanceof Error ? err.message : String(err) })));
    }, RUN_INTERVAL_MS);
  }, 60_000);
}
