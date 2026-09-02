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
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startDailySyncScheduler } = await import('./lib/syncScheduler');
    startDailySyncScheduler();
  }
}
