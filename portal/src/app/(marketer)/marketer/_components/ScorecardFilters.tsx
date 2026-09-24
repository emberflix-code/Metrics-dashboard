'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

const inputCls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500';

// Brand + coach filter for the Overview scorecard. Both write to the URL
// (same pattern as RangeSelect / TargetingFilters) so the server page
// re-renders and the view is shareable. Coach is free text because coach
// names are typed into the client config, not picked from a list.
export default function ScorecardFilters({ brands, current }: {
  brands: string[];
  current: { brand: string; coach: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [coach, setCoach] = useState(current.coach);
  useEffect(() => { setCoach(current.coach); }, [current.coach]);

  function navigate(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.replace(`${pathname}?${params.toString()}`);
  }
  const setOrDelete = (p: URLSearchParams, key: string, value: string) => {
    if (value) p.set(key, value); else p.delete(key);
  };

  // Coach commits on blur/Enter rather than per keystroke: each navigation
  // re-runs the scorecard query on the server.
  function commitCoach() {
    if (coach.trim() === current.coach) return;
    navigate(p => setOrDelete(p, 'coach', coach.trim()));
  }

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
        <input
          value={coach}
          onChange={e => setCoach(e.target.value)}
          onBlur={commitCoach}
          onKeyDown={e => { if (e.key === 'Enter') commitCoach(); }}
          placeholder="Any coach — type to filter"
          className={`${inputCls} w-[220px]`}
        />
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
