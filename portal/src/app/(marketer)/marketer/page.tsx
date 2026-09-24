import { requireMarketerSession } from '@/lib/marketerAuth';
import { loadMarketerScope } from '@/lib/marketerScope';
import { buildScorecard, coachNames } from '@/lib/marketer/scorecard';
import { resolveLiveRange } from '@/lib/marketer/campaignStats';
import { buildAlerts } from '@/lib/marketer/alerts';
import { query } from '@/lib/db';
import RangeSelect from './_components/RangeSelect';
import StatTile from './_components/StatTile';
import ScorecardFilters from './_components/ScorecardFilters';
import ScorecardTable from './_components/ScorecardTable';
import AlertsList from './_components/AlertsList';
import { fmtInt, fmtPct, fmtSignedPct, fmtUsd, pctChange } from './_components/format';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// Marketer Overview: the location health scorecard (every location vs its
// peers) with the top alerts on top. Everything is computed here from the
// lib functions; the client components only add sorting and triage.
export default async function MarketerOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  await requireMarketerSession();
  const brand = first(searchParams.brand) || '';
  const coach = first(searchParams.coach) || '';
  // Live = campaign-level numbers straight from Meta for short ranges (the
  // nightly cache can lag a day for "this week") AND the range runs through
  // today, since "live" means as of now. Cached mode still floors at
  // yesterday like the rest of the app.
  const { live, ...range } = resolveLiveRange(
    { preset: first(searchParams.preset), since: first(searchParams.since), until: first(searchParams.until) },
    first(searchParams.live) === '1'
  );

  const [scope, scorecard, alerts] = await Promise.all([
    loadMarketerScope(),
    buildScorecard({ since: range.since, until: range.until, brand: brand || undefined, coach: coach || undefined, live }),
    // Alerts are relative to the range end, not the range itself (their
    // windows are fixed 7d/28d lookbacks).
    buildAlerts({ until: range.until }),
  ]);

  const syncRows = scope.accountIds.length > 0
    ? await query<{ account_id: string; status: string; last_synced_at: string | null; last_success_until: string | null; last_error: string | null }>(
        `SELECT account_id, status, last_synced_at, last_success_until, last_error FROM agency_meta_sync_state WHERE account_id = ANY($1)`,
        [scope.accountIds]
      )
    : [];
  const syncByAccount = new Map(syncRows.map(r => [r.account_id, r]));

  const brands = Array.from(new Set(scope.locationClients.map(c => c.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const coaches = coachNames(scope.locationClients);
  const withData = scorecard.rows.filter(r => r.spend > 0).length;
  const highAlerts = alerts.alerts.filter(a => a.severity === 'high').length;
  const topAlerts = alerts.alerts.slice(0, 8);

  // CPL tile: compare the filtered view's blended CPL against the agency
  // median of location CPLs. Neutral inside ±10% so a rounding-level gap
  // doesn't read as a verdict.
  const cplVsMedian = scorecard.totals.cpl !== null && scorecard.agencyMedianCpl !== null ? pctChange(scorecard.totals.cpl, scorecard.agencyMedianCpl) : null;
  const cplTone = cplVsMedian === null ? 'neutral' : cplVsMedian > 10 ? 'bad' : cplVsMedian < -10 ? 'good' : 'neutral';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Overview</h1>
          <p className="text-sm text-slate-400">Every location against its peers, plus what needs attention today.{live ? ` Spend and leads live from Meta, including today (${range.until}).` : ''}</p>
        </div>
        <RangeSelect currentPreset={range.preset} currentSince={range.since} currentUntil={range.until} allowLive live={live} />
      </div>

      <ScorecardFilters brands={brands} coaches={coaches} current={{ brand, coach }} />

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
        <StatTile label="Spend" value={fmtUsd(scorecard.totals.spend, 0)} sub={brand || coach ? 'filtered view' : 'all locations'} />
        <StatTile label="Leads" value={fmtInt(scorecard.totals.results)} sub="per each client's lead source" />
        <StatTile
          label="CPL"
          value={fmtUsd(scorecard.totals.cpl)}
          tone={cplTone}
          sub={scorecard.agencyMedianCpl !== null ? `${fmtSignedPct(cplVsMedian)} vs agency median ${fmtUsd(scorecard.agencyMedianCpl)}` : 'no agency median yet'}
        />
        <StatTile label="Bookings" value={fmtInt(scorecard.totals.bookings)} sub={`${scorecard.totals.bookingsClients} GHL-connected location${scorecard.totals.bookingsClients === 1 ? '' : 's'}`} />
        <StatTile label="Cost / booking" value={fmtUsd(scorecard.totals.cpb)} sub="GHL-connected spend ÷ bookings" />
        <StatTile label="CTR" value={fmtPct(scorecard.totals.ctr)} />
        <StatTile label="Locations with data" value={`${withData} / ${scorecard.rows.length}`} tone={withData < scorecard.rows.length ? 'warn' : 'neutral'} sub="spend > $0 in range" />
        <StatTile label="High alerts" value={String(highAlerts)} tone={highAlerts > 0 ? 'bad' : 'good'} sub={`${alerts.alerts.length} open in total`} />
      </div>

      <ScorecardTable rows={scorecard.rows} totals={scorecard.totals} agencyMedianCpl={scorecard.agencyMedianCpl} live={live} />

      {scorecard.unattributed.campaigns > 0 && (
        <p className="text-xs text-slate-500">
          Unattributed spend: {fmtUsd(scorecard.unattributed.spend, 0)} across {scorecard.unattributed.campaigns} campaign{scorecard.unattributed.campaigns === 1 ? '' : 's'} ({fmtInt(scorecard.unattributed.results)} leads) isn&apos;t mapped to any location and is excluded from the scorecard.{' '}
          <a href="/marketer/alerts?kinds=unattributed_campaign" className="text-blue-300 hover:text-blue-200">Review →</a>
        </p>
      )}

      <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Needs attention</h2>
          <a href={`/marketer/alerts?preset=${encodeURIComponent(range.preset)}${range.preset === 'custom' ? `&since=${range.since}&until=${range.until}` : ''}`} className="text-xs text-blue-300 hover:text-blue-200">
            View all ({alerts.alerts.length}) →
          </a>
        </div>
        {topAlerts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500 text-center">No open alerts as of {alerts.until}.</p>
        ) : (
          <AlertsList alerts={topAlerts} compact />
        )}
      </div>

      <details className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden group">
        <summary className="px-4 py-3 cursor-pointer select-none flex items-center justify-between text-sm font-semibold text-white hover:bg-slate-800/30">
          <span>Ad accounts in scope ({scope.accountIds.length})</span>
          <span className="text-xs font-normal text-slate-500">cached data through <span className="font-mono">last_success_until</span></span>
        </summary>
        <table className="w-full text-sm border-t border-slate-800">
          <thead className="text-[11px] uppercase tracking-wider text-slate-500">
            <tr className="border-b border-slate-800">
              <th className="text-left px-4 py-2">Account</th>
              <th className="text-left px-4 py-2">ID</th>
              <th className="text-left px-4 py-2">Clients</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Data through</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {scope.accountIds.map(id => {
              const s = syncByAccount.get(id);
              const clients = scope.clients.filter(c => c.adAccountIds.includes(id));
              return (
                <tr key={id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-2 text-white">{scope.accountNameById.get(id) || '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">{id}</td>
                  <td className="px-4 py-2 text-slate-300">{clients.length}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${s?.status === 'error' ? 'text-red-300 border-red-500/30 bg-red-500/10' : s?.status === 'running' ? 'text-sky-300 border-sky-500/30 bg-sky-500/10' : 'text-slate-300 border-slate-700 bg-slate-800'}`}>
                      {s?.status ?? 'never synced'}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-400">{s?.last_success_until ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </details>
    </div>
  );
}
