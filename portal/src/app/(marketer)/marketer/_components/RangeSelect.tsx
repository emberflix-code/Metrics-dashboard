'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// Same preset vocabulary as the Agency Overview picker (lib/dateRange.ts),
// minus "today" — the marketer views are always through yesterday.
type PresetKey = 'yesterday' | 'this_week' | '7' | '14' | '30' | '90' | 'this_month' | 'last_month' | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'this_week', label: 'This week (Fri–yesterday)' },
  { key: '7', label: 'Last 7 days' },
  { key: '14', label: 'Last 14 days' },
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'custom', label: 'Custom range…' },
];

// "Live from Meta" is offered for short ranges only (≤ LIVE_MAX_DAYS): one
// campaign-level insights call per account is cheap for a week, and the
// nightly cache can lag a day behind for "this week" checks. Live also
// runs the range through TODAY (the cached views floor at yesterday), so
// eligibility is measured against the extended range.
export const LIVE_MAX_DAYS = 14;
function rangeDays(since: string, until: string): number {
  return Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1;
}
// Today in America/New_York, matching the server's live clock.
function todayEt(): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${p.find(x => x.type === 'year')!.value}-${p.find(x => x.type === 'month')!.value}-${p.find(x => x.type === 'day')!.value}`;
}

export default function RangeSelect({ currentPreset, currentSince, currentUntil, allowLive = false, live = false }: {
  currentPreset: string; currentSince: string; currentUntil: string;
  /** Show the "Live from Meta" checkbox (only pages whose data layer supports it). */
  allowLive?: boolean;
  live?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [customFrom, setCustomFrom] = useState(currentSince);
  const [customTo, setCustomTo] = useState(currentUntil);
  const [showCustom, setShowCustom] = useState(currentPreset === 'custom');

  function navigate(params: URLSearchParams) {
    router.push(`${pathname}?${params.toString()}`);
  }

  function handlePresetChange(preset: string) {
    if (preset === 'custom') { setShowCustom(true); return; }
    setShowCustom(false);
    const params = new URLSearchParams(searchParams.toString());
    params.set('preset', preset);
    params.delete('since');
    params.delete('until');
    params.delete('page');
    navigate(params);
  }

  function applyCustomRange() {
    if (!customFrom || !customTo) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('preset', 'custom');
    params.set('since', customFrom);
    params.set('until', customTo);
    params.delete('page');
    navigate(params);
  }

  function toggleLive(on: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (on) params.set('live', '1'); else params.delete('live');
    navigate(params);
  }

  // When live is off the shown range ends yesterday, so measure the cap
  // against what live would actually request (through today).
  const liveUntil = currentUntil >= todayEt() ? currentUntil : todayEt();
  const liveEligible = allowLive && rangeDays(currentSince, liveUntil) <= LIVE_MAX_DAYS;
  const cls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select value={currentPreset} onChange={e => handlePresetChange(e.target.value)} className={cls}>
        {PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>
      {showCustom && (
        <>
          <input type="date" value={customFrom} max={customTo || undefined} onChange={e => setCustomFrom(e.target.value)} className={cls} />
          <span className="text-slate-500 text-sm">to</span>
          <input type="date" value={customTo} min={customFrom || undefined} onChange={e => setCustomTo(e.target.value)} className={cls} />
          <button type="button" onClick={applyCustomRange} disabled={!customFrom || !customTo}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
            Apply
          </button>
        </>
      )}
      <span className="text-xs text-slate-500 font-mono">{currentSince} → {currentUntil}</span>
      {allowLive && (
        <label
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border ${liveEligible ? 'border-slate-700 text-slate-300 cursor-pointer hover:border-slate-600' : 'border-slate-800 text-slate-600 cursor-not-allowed'}`}
          title={liveEligible ? `Pull spend and leads straight from Meta for this range instead of the nightly cache, through today (${liveUntil}). Today's numbers are partial and still settling.` : `Live mode is available for ranges up to ${LIVE_MAX_DAYS} days (including today)`}
        >
          <input type="checkbox" checked={live && liveEligible} disabled={!liveEligible} onChange={e => toggleLive(e.target.checked)} className="accent-emerald-500" />
          Live from Meta
        </label>
      )}
    </div>
  );
}
