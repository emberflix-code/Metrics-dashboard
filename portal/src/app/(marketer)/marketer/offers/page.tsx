import { requireMarketerSession } from '@/lib/marketerAuth';
import { loadMarketerScope } from '@/lib/marketerScope';
import { resolveDateRange } from '@/lib/dateRange';
import { buildOfferMatrix } from '@/lib/marketer/offerMatrix';
import { liveRangeAllowed } from '@/lib/marketer/campaignStats';
import RangeSelect from '../_components/RangeSelect';
import StatTile from '../_components/StatTile';
import { fmtInt, fmtUsd } from '../_components/format';
import OfferMatrixView from './OfferMatrixView';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

// Offer matrix: which offer works where. Rows = locations (or brands),
// columns = offer tokens parsed from campaign names, cells = CPL.
export default async function MarketerOffersPage({ searchParams }: { searchParams: SearchParams }) {
  await requireMarketerSession();
  const range = resolveDateRange({ preset: first(searchParams.preset), since: first(searchParams.since), until: first(searchParams.until) }, '30');
  const brand = first(searchParams.brand) || '';
  const groupBy: 'client' | 'brand' = first(searchParams.groupBy) === 'brand' ? 'brand' : 'client';
  const minSpendRaw = Number(first(searchParams.minSpend));
  const minSpend = Number.isFinite(minSpendRaw) && minSpendRaw > 0 ? minSpendRaw : 0;
  const live = first(searchParams.live) === '1' && liveRangeAllowed(range.since, range.until);

  const [scope, matrix] = await Promise.all([
    loadMarketerScope(),
    buildOfferMatrix({ since: range.since, until: range.until, brand: brand || undefined, groupBy, minSpend, live }),
  ]);
  const brands = Array.from(new Set(scope.locationClients.map(c => c.brand).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const totalSpend = matrix.offers.reduce((s, o) => s + o.spend, 0);
  const totalResults = matrix.offers.reduce((s, o) => s + o.results, 0);
  const top = matrix.offers[0];
  // "Best" = lowest median per-location CPL among offers with a median at
  // all (i.e. at least one judged cell), not lowest blended CPL, so one
  // big cheap location can't crown an offer.
  const best = matrix.offers.filter(o => o.medianCpl !== null).sort((a, b) => a.medianCpl! - b.medianCpl!)[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Offers</h1>
          <p className="text-sm text-slate-400">CPL by offer and location, from campaign-name offer tokens. Which promotion is earning its spend where.{live ? ' Live from Meta.' : ''}</p>
        </div>
        <RangeSelect currentPreset={range.preset} currentSince={range.since} currentUntil={range.until} allowLive live={live} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Offers running" value={String(matrix.offers.length)} sub={`${matrix.rows.length} ${groupBy === 'brand' ? 'brands' : 'locations'} shown`} />
        <StatTile label="Attributed spend" value={fmtUsd(totalSpend, 0)} sub={`${fmtInt(totalResults)} leads · CPL ${fmtUsd(totalResults > 0 ? totalSpend / totalResults : null)}`} />
        <StatTile label="Biggest offer" value={top ? top.token : '—'} sub={top ? `${fmtUsd(top.spend, 0)} · CPL ${fmtUsd(top.cpl)}` : undefined} />
        <StatTile label="Lowest median CPL" value={best ? fmtUsd(best.medianCpl) : '—'} tone={best ? 'good' : 'neutral'} sub={best ? `${best.token} · ${best.clients} client${best.clients === 1 ? '' : 's'}` : 'no judged cells'} />
      </div>

      <OfferMatrixView matrix={matrix} brands={brands} current={{ brand, groupBy, minSpend }} />
    </div>
  );
}
