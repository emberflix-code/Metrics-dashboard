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
const SCHEDULED_HOUR_ET = 6; // 6:00 AM America/New_York (handles EST/EDT automatically), per 2026-09-12 request
let started = false;

// Finds the UTC instant for a given wall-clock hour in America/New_York by
// searching outward from a UTC guess and checking Intl's own rendering of
// each candidate — sidesteps manually computing the EST/EDT offset (which
// changes twice a year) since Intl already knows the real rule.
function etHourToUtc(y: number, mo: number, d: number, hourEt: number): Date {
  // ET is always UTC-4 or UTC-5, so the true instant lies within a few hours
  // of this guess; nudge until Intl agrees on the resulting ET wall-clock hour.
  let guess = new Date(Date.UTC(y, mo - 1, d, hourEt + 5, 0, 0));
  for (let i = 0; i < 4; i++) {
    const renderedHour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit' })
        .format(guess)
    );
    const renderedDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', day: '2-digit' }).format(guess);
    if (renderedHour === hourEt && Number(renderedDay) === d) break;
    guess = new Date(guess.getTime() + (hourEt - renderedHour) * 60 * 60 * 1000);
  }
  return guess;
}

// Next occurrence of SCHEDULED_HOUR_ET:00 in America/New_York, as a UTC Date.
function nextScheduledRun(from: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(from);
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const mo = Number(parts.find(p => p.type === 'month')?.value);
  const d = Number(parts.find(p => p.type === 'day')?.value);

  let candidate = etHourToUtc(y, mo, d, SCHEDULED_HOUR_ET);
  if (candidate.getTime() <= from.getTime()) {
    const tomorrow = new Date(candidate.getTime() + RUN_INTERVAL_MS);
    const tParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(tomorrow);
    candidate = etHourToUtc(
      Number(tParts.find(p => p.type === 'year')?.value),
      Number(tParts.find(p => p.type === 'month')?.value),
      Number(tParts.find(p => p.type === 'day')?.value),
      SCHEDULED_HOUR_ET
    );
  }
  return candidate;
}

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

// setTimeout's delay param is a 32-bit signed int (~24.8 days max) — a wait
// until tomorrow's 6am ET is always well under that, but this guards against
// any future SCHEDULED_HOUR_ET/interval change that could exceed it, by
// chaining shorter timeouts instead of overflowing into an immediate fire.
const MAX_TIMEOUT_MS = 2_147_000_000;

function scheduleNextRun() {
  const target = nextScheduledRun(new Date());
  const delay = target.getTime() - Date.now();
  console.log('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:scheduled', nextRunAt: target.toISOString(), delayMs: delay }));

  if (delay > MAX_TIMEOUT_MS) {
    setTimeout(scheduleNextRun, MAX_TIMEOUT_MS);
    return;
  }
  setTimeout(() => {
    runDailySync()
      .catch(err => console.error('[SYNC-SCHEDULER]', JSON.stringify({ step: 'run:fatal', error: err instanceof Error ? err.message : String(err) })))
      .finally(scheduleNextRun);
  }, delay);
}

export function startDailySyncScheduler() {
  if (started) return; // instrumentation.ts's register() can fire more than once per process in some Next.js dev-mode reload scenarios
  started = true;

  console.log('[SYNC-SCHEDULER]', JSON.stringify({ step: 'scheduler:armed', scheduledHourEt: SCHEDULED_HOUR_ET }));
  scheduleNextRun();
}
