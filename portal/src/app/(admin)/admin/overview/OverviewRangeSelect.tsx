'use client';

import { useRouter, useSearchParams } from 'next/navigation';

const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

export default function OverviewRangeSelect({ currentDays }: { currentDays: number }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(days: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('days', String(days));
    router.push(`/admin/overview?${params.toString()}`);
  }

  return (
    <select
      value={currentDays}
      onChange={e => handleChange(Number(e.target.value))}
      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
    >
      {PRESETS.map(p => (
        <option key={p.days} value={p.days}>{p.label}</option>
      ))}
    </select>
  );
}
