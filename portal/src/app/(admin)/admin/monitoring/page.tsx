import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import AutoRefresh from './AutoRefresh';

interface ClientRow {
  id: string;
  name: string;
  active: boolean;
  data_source: 'live' | 'cached';
  leads_source: 'meta' | 'sheet' | 'ghl';
  ad_account_ids: string[];
  show_creatives_v3: boolean;
  show_theme_breakdown: boolean;
  show_insights: boolean;
  show_meta_kpi_sheet: boolean;
  enable_cross_account_creative_tagging: boolean;
}

interface SyncStateRow {
  account_id: string;
  status: string;
  last_synced_at: string | null;
  last_success_until: string | null;
  last_error: string | null;
  backfill_complete: boolean;
  creatives_backfill_complete: boolean;
}

// This is a config-and-sync-health SNAPSHOT — everything here already
// exists in the DB (clients' own config columns, agency_meta_sync_state
// from the daily sync scheduler). It does NOT track whether a client has
// actually opened their dashboard or hit a runtime error while doing so —
// that would need new event logging (dashboard-load/error write path,
// a new table, a retention policy) that doesn't exist yet. Scoped
// deliberately smaller as a first step; see project memory if that gets
// built later.
export default async function MonitoringPage() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') redirect('/login');

  const clients = await query<ClientRow>(`
    SELECT id, name, active, data_source, leads_source, ad_account_ids,
           show_creatives_v3, show_theme_breakdown, show_insights,
           show_meta_kpi_sheet, enable_cross_account_creative_tagging
    FROM clients
    ORDER BY active DESC, name ASC
  `);

  const syncRows = await query<SyncStateRow>(`
    SELECT account_id, status, last_synced_at, last_success_until, last_error,
           backfill_complete, creatives_backfill_complete
    FROM agency_meta_sync_state
  `);
  const syncByAccount = new Map(syncRows.map(r => [r.account_id, r] as const));

  // Live presence — see client_heartbeats' comment in lib/db.ts. A client
  // counts as "live" if its last heartbeat (sent every ~30s while a tab is
  // open and visible) landed within LIVE_WINDOW_SECONDS — wide enough to
  // survive a couple of missed beats (a slow request, a brief network
  // blip) without flickering offline, tight enough that a closed tab reads
  // as offline well within one page auto-refresh cycle.
  const LIVE_WINDOW_SECONDS = 90;
  const heartbeats = await query<{ client_id: string; last_seen_at: string; last_path: string }>(
    `SELECT client_id, last_seen_at, last_path FROM client_heartbeats WHERE last_seen_at > NOW() - INTERVAL '${LIVE_WINDOW_SECONDS} seconds'`
  );
  const liveByClient = new Map(heartbeats.map(h => [h.client_id, h] as const));

  // A sync run older than this with no update is worth flagging — the
  // daily scheduler (instrumentation.ts) is expected to touch every
  // client-attached account roughly once a day.
  const STALE_HOURS = 36;
  function hoursSince(iso: string | null): number | null {
    if (!iso) return null;
    return (Date.now() - new Date(iso).getTime()) / 3_600_000;
  }

  function worstSyncForClient(accountIds: string[]): { state: SyncStateRow | null; staleHours: number | null; hasError: boolean } {
    let worst: SyncStateRow | null = null;
    let worstHours: number | null = null;
    let hasError = false;
    for (const id of accountIds) {
      const s = syncByAccount.get(id);
      if (!s) continue;
      if (s.last_error) hasError = true;
      const h = hoursSince(s.last_synced_at);
      if (h !== null && (worstHours === null || h > worstHours)) {
        worst = s;
        worstHours = h;
      }
    }
    return { state: worst, staleHours: worstHours, hasError };
  }

  const rows = clients.map(c => {
    const accountIds = c.ad_account_ids || [];
    const { state, staleHours, hasError } = worstSyncForClient(accountIds);
    const isStale = c.data_source === 'cached' && (staleHours === null || staleHours > STALE_HOURS);
    return { client: c, syncState: state, staleHours, hasError, isStale, accountCount: accountIds.length };
  });

  const activeRows = rows.filter(r => r.client.active);
  const flaggedCount = activeRows.filter(r => r.hasError || r.isStale || r.accountCount === 0).length;

  function formatAgo(hours: number | null): string {
    if (hours === null) return 'never';
    if (hours < 1) return `${Math.round(hours * 60)}m ago`;
    if (hours < 48) return `${Math.round(hours)}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">
              Client Monitoring
              <span className="ml-2 font-mono text-[11px] text-slate-600 font-normal" title="Deployed build">
                {(() => {
                  const version = process.env.NEXT_PUBLIC_VERSION;
                  const sha = process.env.NEXT_PUBLIC_BUILD_SHA || 'dev';
                  return !version || version === sha ? `v.${sha}` : `${version} (${sha})`;
                })()}
              </span>
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Config snapshot + Meta sync health per client — data/leads source, Creatives version, last sync, sync errors.
              Live status auto-refreshes every 30s.
            </p>
          </div>
          <a
            href="/admin"
            className="text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors"
          >
            ← Back to admin
          </a>
        </div>

        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-emerald-500/15 text-emerald-300">
            {activeRows.length} active
          </span>
          <span className="text-xs font-semibold px-2 py-1 rounded-full bg-slate-700/50 text-slate-400">
            {rows.length - activeRows.length} inactive
          </span>
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded-full bg-blue-500/15 text-blue-300">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            {liveByClient.size} live now
          </span>
          {flaggedCount > 0 && (
            <span className="text-xs font-semibold px-2 py-1 rounded-full bg-amber-500/15 text-amber-300">
              {flaggedCount} flagged (no account / sync error / stale sync)
            </span>
          )}
          <AutoRefresh intervalMs={30_000} />
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-800/40">
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Client</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Live</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Data Source</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Leads Source</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Creatives</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Ad Accounts</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Last Sync</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">Sync Health</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const c = r.client;
                const heartbeat = liveByClient.get(c.id);
                return (
                  <tr key={c.id} className={`border-b border-slate-800/50 hover:bg-slate-800/30 ${!c.active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-2.5 font-medium text-white">
                      <a href={`/admin/clients/${c.id}`} className="hover:text-blue-300">{c.name}</a>
                    </td>
                    <td className="px-4 py-2.5">
                      {heartbeat ? (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-300" title={`On ${heartbeat.last_path || 'their dashboard'}`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                          Live
                        </span>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${c.active ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700/50 text-slate-400'}`}>
                        {c.active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${c.data_source === 'live' ? 'bg-sky-500/15 text-sky-300' : 'bg-violet-500/15 text-violet-300'}`}>
                        {c.data_source}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                        {c.leads_source}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${c.show_creatives_v3 ? 'bg-teal-500/15 text-teal-300' : 'bg-slate-800 text-slate-500'}`}>
                        {c.show_creatives_v3 ? 'v3' : 'v2'}
                      </span>
                      {c.enable_cross_account_creative_tagging && (
                        <span className="ml-1 text-xs font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400" title="Cross-account creative tagging enabled">
                          x-acct
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">
                      {r.accountCount === 0 ? (
                        <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400" title="No ad account configured — dashboard will show no Meta data">
                          none configured
                        </span>
                      ) : (
                        <span className="font-mono text-xs">{r.accountCount}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">
                      <span className="font-mono text-xs" title={r.syncState?.last_synced_at ?? undefined}>
                        {formatAgo(r.staleHours)}
                      </span>
                      {r.syncState?.last_success_until && (
                        <span className="text-xs text-slate-500 ml-1">(through {r.syncState.last_success_until})</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      {r.hasError ? (
                        <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400" title={r.syncState?.last_error ?? undefined}>
                          sync error
                        </span>
                      ) : r.accountCount === 0 ? (
                        <span className="text-xs text-slate-600">—</span>
                      ) : r.isStale ? (
                        <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300" title={`No successful sync in over ${STALE_HOURS}h`}>
                          stale
                        </span>
                      ) : (
                        <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">
                          ok
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
