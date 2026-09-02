// Next.js instrumentation hook — runs once when the server process starts
// (stable in Next 14, no config flag needed). This is the "future scheduler"
// anticipated by the doc comments in metaSync.ts and the sync API route:
// syncAccount()/syncClientAccounts() were always written as plain,
// trigger-agnostic functions specifically so something like this could call
// them directly, without a queue or separate worker service.
//
// Only registers the scheduler in the Node.js runtime (not the edge runtime,
// which this project doesn't use, and not during `next build`) and only in
// the actual server process, never in a browser/client bundle.
export async function register() {
  // Gated to production only — `next dev` also runs this hook, and with no
  // guard a local dev server silently kicks off real syncs against every
  // prod Meta ad account 60s after boot (see startDailySyncScheduler),
  // discovered when a local test run left several accounts' sync locks
  // stuck mid-run. Local dev should never touch prod Meta accounts.
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NODE_ENV === 'production') {
    const { startDailySyncScheduler } = await import('./lib/syncScheduler');
    startDailySyncScheduler();
  }
}
