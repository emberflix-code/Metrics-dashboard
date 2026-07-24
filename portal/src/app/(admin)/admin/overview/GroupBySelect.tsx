'use client';

import { useRouter, useSearchParams } from 'next/navigation';

export type GroupByKey = 'none' | 'prefix' | 'marketing_type' | 'offer';

const OPTIONS: { key: GroupByKey; label: string }[] = [
  { key: 'none', label: 'No grouping' },
  { key: 'prefix', label: 'Group by name prefix' },
  { key: 'marketing_type', label: 'Group by Marketing Type' },
  { key: 'offer', label: 'Group by Offer' },
];

export default function GroupBySelect({ current }: { current: GroupByKey }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === 'none') params.delete('group_by');
    else params.set('group_by', value);
    router.push(`/admin/overview?${params.toString()}`);
  }

  return (
    <select
      value={current}
      onChange={e => handleChange(e.target.value)}
      className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
    >
      {OPTIONS.map(o => (
        <option key={o.key} value={o.key}>{o.label}</option>
      ))}
    </select>
  );
}
