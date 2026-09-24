'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';

const inputCls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500';

// Brand + coach filter for the Overview scorecard. Both write to the URL
// (same pattern as RangeSelect / TargetingFilters) so the server page
// re-renders and the view is shareable. Coach is a dropdown of the distinct
// names on the client roster (a client can list several, comma-separated).
export default function ScorecardFilters({ brands, coaches, current }: {
  brands: string[];
  coaches: string[];
  current: { brand: string; coach: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function navigate(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(`${pathname}?${params.toString()}`);
  }
  const setOrDelete = (p: URLSearchParams, key: string, value: string) => {
    if (value) p.set(key, value); else p.delete(key);
  };

  const anyActive = !!current.brand || !!current.coach;
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-end gap-x-4 gap-y-3">
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Brand</label>
        <select value={current.brand} onChange={e => navigate(p => setOrDelete(p, 'brand', e.target.value))} className={inputCls}>
          <option value="">All brands</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Coach</label>
        <select value={current.coach} onChange={e => navigate(p => setOrDelete(p, 'coach', e.target.value))} className={`${inputCls} min-w-[200px]`}>
          <option value="">All coaches</option>
          {coaches.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {anyActive && (
        <button
          type="button"
          onClick={() => navigate(p => { p.delete('brand'); p.delete('coach'); })}
          className="text-xs text-slate-400 hover:text-white border border-slate-700 hover:border-slate-600 rounded-lg px-3 py-2 transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
