import { requireMarketerSession } from '@/lib/marketerAuth';
import { loadMarketerScope } from '@/lib/marketerScope';
import { resolveDateRange } from '@/lib/dateRange';
import { buildTargetingReport, DEFAULT_RING_KM, RING_OPTIONS_KM } from '@/lib/marketer/targeting';
import RangeSelect from '../_components/RangeSelect';
import StatTile from '../_components/StatTile';
import { fmtMi, fmtUsd } from '../_components/format';
import TargetingFilters from './TargetingFilters';
import TargetingView from './TargetingView';
import DataGaps from './DataGaps';

export const dynamic = 'force-dynamic';

type SearchParams = { [key: string]: string | string[] | undefined };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function csv(v: string | string[] | undefined): string[] | undefined {
  const s = first(v);
  if (!s) return undefined;
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

// Targeting overlap: every active, spending ad set's radius circle on one
// map, with the pairs that compete for the same people ranked by how much
// of the smaller circle the other covers. Picking a client focuses on it
// (full universe kept, neighbours + radius simulation on the right);
// `only=1` narrows the whole page to that client instead. The report is
// built here directly (no self-fetch) and handed to the client components.
export default async function TargetingPage({ searchParams }: { searchParams: SearchParams }) {
  await requireMarketerSession();
  const range = resolveDateRange({ preset: first(searchParams.preset), since: first(searchParams.since), until: first(searchParams.until) }, '30');

  const minScoreRaw = Number(first(searchParams.minScore));
  const minScore = first(searchParams.minScore) !== undefined && Number.isFinite(minScoreRaw) ? Math.max(0, Math.min(1, minScoreRaw)) : 0.05;
  const selectedClientIds = csv(searchParams.client);
  const only = first(searchParams.only) === '1';
  const ringRaw = Number(first(searchParams.ring));
  const ringKm = Number.isFinite(ringRaw) && ringRaw > 0 ? Math.min(500, ringRaw) : DEFAULT_RING_KM;
  const focusClientId = !only && selectedClientIds ? selectedClientIds[0] : undefined;

  const includeSameCampaign = first(searchParams.includeSameCampaign) === '1';
  const filters = {
    since: range.since,
    until: range.until,
    clientIds: only ? selectedClientIds : undefined,
    brand: first(searchParams.brand) || undefined,
    accountIds: csv(searchParams.account)?.map(a => a.replace(/^act_/i, '')),
    minScore,
    includeSameCampaign,
    includeInactive: first(searchParams.includeInactive) === '1',
    focusClientId,
    ringKm,
  };

  const [scope, report] = await Promise.all([loadMarketerScope(), buildTargetingReport(filters)]);

  const clientOptions = scope.locationClients.map(c => ({ id: c.id, name: c.name, brand: c.brand }));
  const brandOptions = Array.from(new Set(scope.locationClients.map(c => c.brand))).sort((a, b) => a.localeCompare(b));
  const accountOptions = scope.accountIds.map(id => ({ id, name: scope.accountNameById.get(id) || id }));

  const s = report.summary;
  const focus = report.focus;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">
            Targeting overlap{focus && <span className="text-emerald-300"> · {focus.clientName}</span>}
          </h1>
          <p className="text-sm text-slate-400">
            {focus
              ? `Everything running within ${fmtMi(focus.ringKm)} of ${focus.clientName}, plus anything already touching its ad sets. Drag a radius on the right to see what it would collide with.`
              : 'Active ad sets with spend in range, drawn as their targeting radius. Pairs are ranked by how much of the smaller circle the other one covers.'}
          </p>
        </div>
        <RangeSelect currentPreset={range.preset} currentSince={range.since} currentUntil={range.until} />
      </div>

      <TargetingFilters
        clients={clientOptions}
        brands={brandOptions}
        accounts={accountOptions}
        current={{
          clientIds: selectedClientIds ?? [],
          only,
          ringKm,
          ringOptionsKm: RING_OPTIONS_KM,
          brand: filters.brand ?? '',
          accountIds: filters.accountIds ?? [],
          minScore,
          includeSameCampaign,
          includeInactive: filters.includeInactive,
        }}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatTile label="Ad sets" value={String(s.adsets)} sub={`${s.circles} circles drawn`} />
        <StatTile label="High overlaps" value={String(s.pairsHigh)} tone={s.pairsHigh > 0 ? 'bad' : 'good'} sub="≥50% of the smaller circle" />
        <StatTile label="Medium overlaps" value={String(s.pairsMedium)} tone={s.pairsMedium > 0 ? 'warn' : 'neutral'} sub="20–50%" />
        {focus ? (
          <StatTile label="Neighbours in ring" value={String(focus.neighbours.length)} sub={`${focus.focusCircles.length} own circle${focus.focusCircles.length === 1 ? '' : 's'} · ${focus.unmappedNeighbours.length} can't assess`} tone={focus.neighbours.some(n => n.overlapWithFocus.length > 0) ? 'warn' : 'neutral'} />
        ) : (
          <StatTile label="Low overlaps" value={String(s.pairsLow)} sub={`>${Math.round(minScore * 100)}%`} />
        )}
        <StatTile label="Spend in high pairs" value={fmtUsd(s.spendInHighPairs, 0)} tone={s.spendInHighPairs > 0 ? 'bad' : 'neutral'} sub="distinct ad sets, in range" />
        <StatTile label="Clubs geocoded" value={`${s.clubsGeocoded} / ${s.clubs}`} tone={s.clubsGeocoded === s.clubs ? 'good' : 'warn'} />
      </div>

      <TargetingView report={report} includeSameCampaign={includeSameCampaign} />

      <DataGaps
        unmapped={report.unmapped}
        broadCount={report.broad.length}
        adsetsWithoutTargeting={report.unmapped.adsetsWithoutTargeting}
      />
    </div>
  );
}
