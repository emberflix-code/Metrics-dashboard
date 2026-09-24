// Admin/marketer-triggered backfill runner for the marketer module's data
// (geocode clubs, ad set targeting + recent insights, ad copy + copy
// breakdowns). Runs in the background inside the Next.js process — the
// same way the daily scheduler does — and reports progress through an
// in-memory status object, so the UI button returns immediately instead
// of holding an HTTP request open for minutes. Per-account sync locking
// comes from claimSync() inside the *Only entry points, so this can never
// collide with the daily scheduler or an admin "Sync now".
import { query } from './db';
import { geocodePendingClients } from './geocode';
import { syncAccountTargetingOnly, syncAccountCopyOnly } from './metaSync';
import { refreshCampaignAttribution } from './marketerScope';
import { invalidateTargetingCache } from './marketer/targeting';

export type BackfillStep = 'geocode' | 'targeting' | 'copy' | 'attribution';

export interface BackfillStatus {
  running: boolean;
  step: BackfillStep | null;
  startedAt: string | null;
  finishedAt: string | null;
  accountIds: string[];
  current: string | null;
  done: { accountId: string; ok: boolean; detail: string; ms: number }[];
  error: string | null;
}

const PAUSE_BETWEEN_ACCOUNTS_MS = 20_000; // same pacing as the daily scheduler

const status: BackfillStatus = { running: false, step: null, startedAt: null, finishedAt: null, accountIds: [], current: null, done: [], error: null };

export function getBackfillStatus(): BackfillStatus {
  return { ...status, done: [...status.done], accountIds: [...status.accountIds] };
}

async function scopedAccountIds(): Promise<string[]> {
  // Same source as the daily scheduler: only accounts attached to a client.
  const rows = await query<{ ad_account_ids: string[] | null }>(
    `SELECT ad_account_ids FROM clients WHERE active = true AND ad_account_ids IS NOT NULL AND array_length(ad_account_ids, 1) > 0`
  );
  return Array.from(new Set(rows.flatMap(r => r.ad_account_ids || [])));
}

/** Starts a backfill; returns false when one is already running. */
export async function startMarketerBackfill(step: BackfillStep, accountId?: string): Promise<{ started: boolean; accountIds: string[] }> {
  if (status.running) return { started: false, accountIds: status.accountIds };
  const accountIds = step === 'geocode' ? [] : accountId ? [accountId] : await scopedAccountIds();
  status.running = true;
  status.step = step;
  status.startedAt = new Date().toISOString();
  status.finishedAt = null;
  status.accountIds = accountIds;
  status.current = null;
  status.done = [];
  status.error = null;

  (async () => {
    try {
      if (step === 'geocode') {
        const t = Date.now();
        const r = await geocodePendingClients({ force: false });
        status.done.push({ accountId: '-', ok: r.failed === 0, detail: `geocoded ${r.geocoded}, failed ${r.failed}, no match ${r.skipped}`, ms: Date.now() - t });
        return;
      }
      if (step === 'attribution') {
        const t = Date.now();
        const r = await refreshCampaignAttribution(accountId);
        status.done.push({ accountId: accountId ?? '-', ok: true, detail: `${r.rows} rows across ${r.accounts} accounts`, ms: Date.now() - t });
        return;
      }
      for (let i = 0; i < accountIds.length; i++) {
        const id = accountIds[i];
        status.current = id;
        const t = Date.now();
        try {
          const r = step === 'targeting' ? await syncAccountTargetingOnly(id) : await syncAccountCopyOnly(id);
          status.done.push({ accountId: id, ok: !r.error, detail: r.error ?? 'ok', ms: Date.now() - t });
        } catch (err) {
          status.done.push({ accountId: id, ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - t });
        }
        if (i < accountIds.length - 1) await new Promise(r => setTimeout(r, PAUSE_BETWEEN_ACCOUNTS_MS));
      }
    } catch (err) {
      status.error = err instanceof Error ? err.message : String(err);
    } finally {
      status.running = false;
      status.current = null;
      status.finishedAt = new Date().toISOString();
      // The targeting report memoizes for 5 minutes; a backfill is exactly
      // when the marketer is waiting to see fresh circles.
      try { invalidateTargetingCache(); } catch { /* cache is best-effort */ }
      console.log('[MARKETER-BACKFILL]', JSON.stringify({ step, done: status.done.length, error: status.error }));
    }
  })();

  return { started: true, accountIds };
}
