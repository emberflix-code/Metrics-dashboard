import { requireMarketerSession } from '@/lib/marketerAuth';
import { loadMarketerScope } from '@/lib/marketerScope';
import { resolveDateRange } from '@/lib/dateRange';
import { listOffers, parseAssetLibraryParams, queryAssetLibrary } from '@/lib/marketer/assetLibrary';
import RangeSelect from '../_components/RangeSelect';
import AssetLibrary, { type AssetLibraryOptions } from './AssetLibrary';

export const dynamic = 'force-dynamic';

// Cross-account asset library: every creative and copy variant the agency
// has run, ranked on Meta's own per-asset breakdown numbers. The server
// renders the first page from the URL so a shared link lands on the same
// view; the client component takes over from there via /api/marketer/assets.
export default async function MarketerAssetsPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireMarketerSession();
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const range = resolveDateRange({ preset: first(searchParams.preset), since: first(searchParams.since), until: first(searchParams.until) }, '30');
  const q = parseAssetLibraryParams(searchParams, range);

  // Filter options always carry every client ever with an `active` flag, so
  // the "include inactive" checkbox can widen/narrow the dropdowns without a
  // server round-trip. The QUERY itself only widens when the URL says so.
  const [initial, scope] = await Promise.all([queryAssetLibrary(q), loadMarketerScope({ includeInactive: true })]);

  const activeAccountIds = Array.from(new Set(scope.clients.filter(c => c.active).flatMap(c => c.adAccountIds)));
  const allAccountIds = scope.accountIds;
  const activeAccountSet = new Set(activeAccountIds);
  // Offers for the default (active) scope, plus the wider list when inactive
  // clients bring in accounts of their own — reused when they don't.
  const offersActive = await listOffers(activeAccountIds);
  const offersAll = allAccountIds.length === activeAccountIds.length ? offersActive : await listOffers(allAccountIds);

  const options: AssetLibraryOptions = {
    clients: scope.clients
      .filter(c => !c.isRollup)
      .map(c => ({ id: c.id, name: c.name, brand: c.brand, active: c.active })),
    accounts: allAccountIds
      .map(id => ({ id, name: scope.accountNameById.get(id) || id, active: activeAccountSet.has(id) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    offers: offersActive.map(o => ({ token: o.token, campaignCount: o.campaignCount })),
    offersAll: offersAll.map(o => ({ token: o.token, campaignCount: o.campaignCount })),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Assets</h1>
          <p className="text-sm text-slate-400">Creatives and copy across every account, on Meta&apos;s own per-asset numbers.</p>
        </div>
        <RangeSelect currentPreset={range.preset} currentSince={range.since} currentUntil={range.until} />
      </div>

      {/* Keyed on the range so a picker change remounts with fresh first-page
          data instead of the component holding stale rows for the old range. */}
      <AssetLibrary key={`${range.since}:${range.until}:${q.kind}`} initial={{ ...initial, page: q.page, pageSize: q.pageSize }} range={range} options={options} />
    </div>
  );
}
