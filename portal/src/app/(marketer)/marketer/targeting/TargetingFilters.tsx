'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface ClientOption { id: string; name: string; brand: string }
export interface AccountOption { id: string; name: string }

export interface CurrentFilters {
  clientIds: string[];
  brand: string;
  accountIds: string[];
  minScore: number;
  includeSameCampaign: boolean;
  includeInactive: boolean;
}

const MIN_SCORE_OPTIONS: { value: number; label: string }[] = [
  { value: 0.05, label: 'Any overlap (>5%)' },
  { value: 0.2, label: 'Medium and up (≥20%)' },
  { value: 0.5, label: 'High only (≥50%)' },
];

const inputCls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500';

// Every control writes straight to the URL (same navigate pattern as
// RangeSelect) so the server page re-renders with the new report and the
// view stays shareable as a link.
export default function TargetingFilters({ clients, brands, accounts, current }: {
  clients: ClientOption[];
  brands: string[];
  accounts: AccountOption[];
  current: CurrentFilters;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function navigate(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.push(`${pathname}?${params.toString()}`);
  }

  const setOrDelete = (p: URLSearchParams, key: string, value: string) => {
    if (value) p.set(key, value); else p.delete(key);
  };

  // Client multi-select: a search box with a dropdown, selected ones as chips.
  const [clientQuery, setClientQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const selectedSet = useMemo(() => new Set(current.clientIds), [current.clientIds]);
  const selectedClients = useMemo(() => clients.filter(c => selectedSet.has(c.id)), [clients, selectedSet]);
  const matches = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    const pool = clients.filter(c => !selectedSet.has(c.id) && (!current.brand || c.brand === current.brand));
    return (q ? pool.filter(c => c.name.toLowerCase().includes(q)) : pool).slice(0, 40);
  }, [clients, clientQuery, selectedSet, current.brand]);

  function setClients(ids: string[]) {
    navigate(p => setOrDelete(p, 'client', ids.join(',')));
  }
  function addClient(id: string) {
    setClientQuery('');
    setOpen(false);
    setClients([...current.clientIds, id]);
  }
  function removeClient(id: string) {
    setClients(current.clientIds.filter(x => x !== id));
  }

  const anyActive = current.clientIds.length > 0 || !!current.brand || current.accountIds.length > 0 || current.minScore !== 0.05 || current.includeSameCampaign || current.includeInactive;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-start gap-x-4 gap-y-3">
      <div ref={boxRef} className="relative min-w-[260px] flex-1">
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Clients</label>
        <div className={`${inputCls} flex flex-wrap items-center gap-1 py-1.5 min-h-[38px]`} onClick={() => setOpen(true)}>
          {selectedClients.map(c => (
            <span key={c.id} className="inline-flex items-center gap-1 bg-blue-600/20 text-blue-200 border border-blue-500/30 rounded-md px-2 py-0.5 text-xs">
              {c.name}
              <button type="button" aria-label={`Remove ${c.name}`} onClick={e => { e.stopPropagation(); removeClient(c.id); }} className="text-blue-300 hover:text-white leading-none">×</button>
            </span>
          ))}
          <input
            value={clientQuery}
            onChange={e => { setClientQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            placeholder={selectedClients.length === 0 ? 'All location clients — type to filter…' : 'Add another…'}
            className="bg-transparent outline-none text-sm text-white placeholder:text-slate-500 flex-1 min-w-[140px]"
          />
        </div>
        {open && matches.length > 0 && (
          <ul className="absolute z-30 mt-1 w-full max-h-64 overflow-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl text-sm">
            {matches.map(c => (
              <li key={c.id}>
                <button type="button" onClick={() => addClient(c.id)} className="w-full text-left px-3 py-1.5 hover:bg-slate-800 text-slate-200 flex items-center justify-between gap-2">
                  <span className="truncate">{c.name}</span>
                  <span className="text-[11px] text-slate-500 shrink-0">{c.brand}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Brand</label>
        <select value={current.brand} onChange={e => navigate(p => setOrDelete(p, 'brand', e.target.value))} className={inputCls}>
          <option value="">All brands</option>
          {brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Ad account</label>
        <select value={current.accountIds[0] ?? ''} onChange={e => navigate(p => setOrDelete(p, 'account', e.target.value))} className={`${inputCls} max-w-[260px]`}>
          <option value="">All accounts</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.id}</option>)}
        </select>
      </div>

      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Min. overlap</label>
        <select value={String(current.minScore)} onChange={e => navigate(p => setOrDelete(p, 'minScore', e.target.value === '0.05' ? '' : e.target.value))} className={inputCls}>
          {MIN_SCORE_OPTIONS.map(o => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
          {!MIN_SCORE_OPTIONS.some(o => o.value === current.minScore) && (
            <option value={String(current.minScore)}>{`>${Math.round(current.minScore * 100)}%`}</option>
          )}
        </select>
      </div>

      <div className="flex flex-col gap-1.5 pt-5 text-sm text-slate-300">
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={current.includeSameCampaign} onChange={e => navigate(p => setOrDelete(p, 'includeSameCampaign', e.target.checked ? '1' : ''))} className="accent-blue-500" />
          Include same-campaign pairs
        </label>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={current.includeInactive} onChange={e => navigate(p => setOrDelete(p, 'includeInactive', e.target.checked ? '1' : ''))} className="accent-blue-500" />
          Include paused ad sets
        </label>
      </div>

      {anyActive && (
        <button
          type="button"
          onClick={() => navigate(p => { for (const k of ['client', 'brand', 'account', 'minScore', 'includeSameCampaign', 'includeInactive']) p.delete(k); })}
          className="self-end text-xs text-slate-400 hover:text-white border border-slate-700 hover:border-slate-600 rounded-lg px-3 py-2 transition-colors"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
