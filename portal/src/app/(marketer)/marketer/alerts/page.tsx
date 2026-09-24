import { requireMarketerSession } from '@/lib/marketerAuth';
import { loadMarketerScope } from '@/lib/marketerScope';
import { resolveDateRange } from '@/lib/dateRange';
import { buildAlerts, type Alert, type AlertKind, type AlertSeverity } from '@/lib/marketer/alerts';
import RangeSelect from '../_components/RangeSelect';
import AlertsList from '../_components/AlertsList';
import { isAlertKind, SEVERITY_PILL_CLS } from '../_components/alertKinds';
import AlertFilters from './AlertFilters';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const SECTIONS: { severity: AlertSeverity; label: string; blurb: string }[] = [
  { severity: 'high', label: 'High', blurb: 'act today' },
  { severity: 'medium', label: 'Medium', blurb: 'this week' },
  { severity: 'low', label: 'Low', blurb: 'housekeeping' },
];

// Alerts feed. The date picker only moves the "as of" point (range end):
// every rule uses its own fixed lookback from there, so the picker's start
// date is irrelevant here and deliberately not shown.
export default async function MarketerAlertsPage({ searchParams }: { searchParams: SearchParams }) {
  await requireMarketerSession();
  const range = resolveDateRange({ preset: first(searchParams.preset), since: first(searchParams.since), until: first(searchParams.until) }, '30');
  const kinds = (first(searchParams.kinds) || '').split(',').map(s => s.trim()).filter(isAlertKind);
  const client = first(searchParams.client) || '';
  const brand = first(searchParams.brand) || '';
  const showDismissed = first(searchParams.showDismissed) === '1';

  const [scope, result] = await Promise.all([
    loadMarketerScope(),
    buildAlerts({
      until: range.until,
      includeDismissed: showDismissed,
      kinds: kinds.length ? (kinds as AlertKind[]) : undefined,
      clientIds: client ? [client] : undefined,
      brand: brand || undefined,
    }),
  ]);

  // buildAlerts' `kinds` filter is applied by the lib when supported, but
  // filter here too so the chips are authoritative even if the lib treats
  // the argument as a hint.
  const alerts: Alert[] = kinds.length ? result.alerts.filter(a => kinds.includes(a.kind)) : result.alerts;
  const bySeverity = new Map<AlertSeverity, Alert[]>(SECTIONS.map(s => [s.severity, []]));
  for (const a of alerts) bySeverity.get(a.severity)!.push(a);

  const brands = Array.from(new Set(scope.locationClients.map(c => c.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const clients = scope.locationClients.map(c => ({ id: c.id, name: c.name, brand: c.brand }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Alerts</h1>
          <p className="text-sm text-slate-400">
            As of <span className="font-mono text-slate-300">{result.until}</span> · last 7 days {result.windows.last7.since} → {result.windows.last7.until}, baseline {result.windows.prior28.since} → {result.windows.prior28.until}
          </p>
        </div>
        <RangeSelect currentPreset={range.preset} currentSince={range.since} currentUntil={range.until} />
      </div>

      <AlertFilters counts={result.counts} clients={clients} brands={brands} current={{ kinds, client, brand, showDismissed }} />

      {alerts.length === 0 ? (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-10 text-center">
          <p className="text-sm text-slate-300">Nothing needs attention{kinds.length || client || brand ? ' for these filters' : ''}.</p>
          <p className="text-xs text-slate-500 mt-1">{showDismissed ? 'No alerts, dismissed or otherwise.' : 'Dismissed and snoozed alerts are hidden — tick the box above to review them.'}</p>
        </div>
      ) : (
        SECTIONS.map(s => {
          const list = bySeverity.get(s.severity) ?? [];
          if (list.length === 0) return null;
          return (
            <section key={s.severity} className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-800 flex items-center gap-2">
                <span className={`inline-block text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full border ${SEVERITY_PILL_CLS[s.severity]}`}>{s.label}</span>
                <h2 className="text-sm font-semibold text-white">{list.length} alert{list.length === 1 ? '' : 's'}</h2>
                <span className="text-xs text-slate-500">· {s.blurb}</span>
              </div>
              <AlertsList alerts={list} />
            </section>
          );
        })
      )}
    </div>
  );
}
