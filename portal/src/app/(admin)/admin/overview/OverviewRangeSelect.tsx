'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// Mirrors Meta Business Manager's date-range picker: named presets plus a
// custom From/To range. All presets are computed relative to "yesterday"
// (never today/future), consistent with the rest of the app's date handling.
type PresetKey = 'today' | 'yesterday' | 'this_week' | '7' | '14' | '30' | '90' | 'this_month' | 'last_month' | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
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

export default function OverviewRangeSelect({ currentPreset, currentSince, currentUntil }: { currentPreset: string; currentSince: string; currentUntil: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [customFrom, setCustomFrom] = useState(currentSince);
  const [customTo, setCustomTo] = useState(currentUntil);
  const [showCustom, setShowCustom] = useState(currentPreset === 'custom');

  function navigate(params: URLSearchParams) {
    router.push(`/admin/overview?${params.toString()}`);
  }

  function handlePresetChange(preset: string) {
    if (preset === 'custom') {
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    const params = new URLSearchParams(searchParams.toString());
    params.set('preset', preset);
    params.delete('since');
    params.delete('until');
    navigate(params);
  }

  function applyCustomRange() {
    if (!customFrom || !customTo) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('preset', 'custom');
    params.set('since', customFrom);
    params.set('until', customTo);
    navigate(params);
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={currentPreset}
        onChange={e => handlePresetChange(e.target.value)}
        className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
      >
        {PRESETS.map(p => (
          <option key={p.key} value={p.key}>{p.label}</option>
        ))}
      </select>
      {showCustom && (
        <>
          <input
            type="date"
            value={customFrom}
            max={customTo || undefined}
            onChange={e => setCustomFrom(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <span className="text-slate-500 text-sm">to</span>
          <input
            type="date"
            value={customTo}
            min={customFrom || undefined}
            onChange={e => setCustomTo(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
          />
          <button
            type="button"
            onClick={applyCustomRange}
            disabled={!customFrom || !customTo}
            className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Apply
          </button>
        </>
      )}
    </div>
  );
}
