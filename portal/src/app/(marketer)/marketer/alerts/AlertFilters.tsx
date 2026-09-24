'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AlertKind } from '@/lib/marketer/alerts';
import { ALERT_KIND_LABELS, ALERT_KINDS_ORDERED } from '../_components/alertKinds';

const inputCls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500';

// Kind chips + client/brand/dismissed controls, all URL-synced so the
// server page recomputes the feed and the view can be shared as a link.
// `counts` are for the CURRENT filter set (so a chip's number is what
// clicking it would show), which is why zero-count kinds stay visible.
export default function AlertFilters({ counts, clients, brands, current }: {
  counts: Partial<Record<AlertKind, number>>;
  clients: { id: string; name: string; brand: string }[];
  brands: string[];
  current: { kinds: AlertKind[]; client: string; brand: string; showDismissed: boolean };
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

  const selected = new Set(current.kinds);
  function toggleKind(k: AlertKind) {
    const next = selected.has(k) ? current.kinds.filter(x => x !== k) : [...current.kinds, k];
    navigate(p => setOrDelete(p, 'kinds', next.join(',')));
  }

  const clientPool = current.brand ? clients.filter(c => c.brand === current.brand) : clients;
  const anyActive = current.kinds.length > 0 || !!current.client || !!current.brand || current.showDismissed;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {ALERT_KINDS_ORDERED.map(k => {
          const on = selected.has(k);
          const n = counts[k] ?? 0;
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${on
                ? 'text-blue-200 border-blue-500/40 bg-blue-600/20'
                : n > 0 ? 'text-slate-300 border-slate-700 bg-slate-800 hover:border-slate-500' : 'text-slate-500 border-slate-800 hover:border-slate-600'}`}
              title={on ? 'Click to remove from filter' : 'Click to show only this kind'}
            >
              {ALERT_KIND_LABELS[k]} <span className={on ? 'text-blue-300' : 'text-slate-500'}>{n}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Brand</label>
          <select value={current.brand} onChange={e => navigate(p => { setOrDelete(p, 'brand', e.target.value); p.delete('client'); })} className={inputCls}>
            <option value="">All brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Client</label>
          <select value={current.client} onChange={e => navigate(p => setOrDelete(p, 'client', e.target.value))} className={`${inputCls} max-w-[280px]`}>
            <option value="">All clients</option>
            {clientPool.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-slate-300 pb-2">
          <input type="checkbox" checked={current.showDismissed} onChange={e => navigate(p => setOrDelete(p, 'showDismissed', e.target.checked ? '1' : ''))} className="accent-blue-500" />
          Show dismissed / snoozed
        </label>
        {anyActive && (
          <button
            type="button"
            onClick={() => navigate(p => { for (const k of ['kinds', 'client', 'brand', 'showDismissed']) p.delete(k); })}
            className="text-xs text-slate-400 hover:text-white border border-slate-700 hover:border-slate-600 rounded-lg px-3 py-2 transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
