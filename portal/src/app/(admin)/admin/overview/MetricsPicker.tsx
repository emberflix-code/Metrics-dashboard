'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import { OPTIONAL_METRICS, OptionalMetricKey } from './metrics';

export default function MetricsPicker({ current }: { current: Set<OptionalMetricKey> }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function toggle(key: OptionalMetricKey) {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    const params = new URLSearchParams(searchParams.toString());
    if (next.size > 0) params.set('metrics', Array.from(next).join(','));
    else params.delete('metrics');
    router.push(`/admin/overview?${params.toString()}`);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors"
      >
        Columns{current.size > 0 ? ` (${current.size})` : ''}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-56 bg-slate-900 border border-slate-700 rounded-lg shadow-xl z-10 p-2">
          <p className="text-xs text-slate-500 px-2 py-1">Additional Meta metrics</p>
          {OPTIONAL_METRICS.map(m => (
            <label key={m.key} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer text-sm text-slate-200">
              <input
                type="checkbox"
                checked={current.has(m.key)}
                onChange={() => toggle(m.key)}
                className="w-4 h-4 rounded border-slate-600 bg-slate-900 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
              />
              {m.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
