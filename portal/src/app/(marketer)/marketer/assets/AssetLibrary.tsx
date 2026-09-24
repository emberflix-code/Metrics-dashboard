'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { AssetKind, AssetLibraryRow, AssetSort } from '@/lib/marketer/assetLibrary';
import { fmtInt, fmtPct, fmtUsd } from '../_components/format';
import AssetDetailDrawer from './AssetDetailDrawer';

// ── types ────────────────────────────────────────────────────────────────

export interface AssetLibraryOptions {
  clients: { id: string; name: string; brand: string }[];
  brands: string[];
  accounts: { id: string; name: string }[];
  offers: { token: string; campaignCount: number }[];
}

export interface AssetLibraryInitial {
  rows: AssetLibraryRow[];
  total: number;
  totals: { spend: number; results: number; impressions: number };
  page: number;
  pageSize: number;
}

interface Filters {
  kind: AssetKind;
  sort: AssetSort;
  dir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  offer: string[];
  client: string;
  brand: string;
  account: string;
  q: string;
  minSpend: string;
  type: '' | 'image' | 'video';
  theme: string;
  ugc: string;
  onlyActive: boolean;
}

const KIND_TABS: { kind: AssetKind; label: string }[] = [
  { kind: 'creative', label: 'Creatives' },
  { kind: 'body', label: 'Primary text' },
  { kind: 'title', label: 'Headlines' },
  { kind: 'description', label: 'Descriptions' },
];

const THEME_OPTIONS = [
  { value: 'non-active', label: 'Non-Active' },
  { value: 'strength', label: 'Strength' },
  { value: 'tread', label: 'Tread' },
  { value: 'strength+tread', label: 'Strength + Tread' },
];
const UGC_OPTIONS = [
  { value: 'ugc', label: 'UGC' },
  { value: 'non-ugc', label: 'Non-UGC' },
];

const SORTS: AssetSort[] = ['spend', 'results', 'cpl', 'ctr', 'cpm', 'impressions', 'reach', 'adCount', 'clientCount'];
const KINDS: AssetKind[] = ['creative', 'body', 'title', 'description'];

// URL <-> state. The URL is the source of truth on mount (deep links, the
// server-rendered first page), state is the source of truth afterwards.
function filtersFromParams(sp: URLSearchParams): Filters {
  const kindRaw = sp.get('kind') as AssetKind | null;
  const kind = kindRaw && KINDS.includes(kindRaw) ? kindRaw : 'creative';
  const sortRaw = sp.get('sort') as AssetSort | null;
  const sort = sortRaw && SORTS.includes(sortRaw) ? sortRaw : 'spend';
  const dirRaw = sp.get('dir');
  const typeRaw = sp.get('type');
  return {
    kind,
    sort,
    dir: dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : (sort === 'cpl' ? 'asc' : 'desc'),
    page: Math.max(1, parseInt(sp.get('page') || '1', 10) || 1),
    pageSize: [25, 50, 100].includes(parseInt(sp.get('pageSize') || '', 10)) ? parseInt(sp.get('pageSize') || '50', 10) : 50,
    offer: (sp.get('offer') || '').split(',').map(s => s.trim()).filter(Boolean),
    client: sp.get('client') || '',
    brand: sp.get('brand') || '',
    account: sp.get('account') || '',
    q: sp.get('q') || '',
    minSpend: sp.get('minSpend') || '',
    type: typeRaw === 'image' || typeRaw === 'video' ? typeRaw : '',
    theme: sp.get('theme') || '',
    ugc: sp.get('ugc') || '',
    onlyActive: sp.get('onlyActive') === '1',
  };
}

function paramsFromFilters(f: Filters, range: { preset: string; since: string; until: string }): URLSearchParams {
  const p = new URLSearchParams();
  // Range params first so RangeSelect (which rewrites these) keeps the rest.
  p.set('preset', range.preset);
  if (range.preset === 'custom') { p.set('since', range.since); p.set('until', range.until); }
  if (f.kind !== 'creative') p.set('kind', f.kind);
  if (f.sort !== 'spend') p.set('sort', f.sort);
  const defaultDir = f.sort === 'cpl' ? 'asc' : 'desc';
  if (f.dir !== defaultDir) p.set('dir', f.dir);
  if (f.page > 1) p.set('page', String(f.page));
  if (f.pageSize !== 50) p.set('pageSize', String(f.pageSize));
  if (f.offer.length) p.set('offer', f.offer.join(','));
  if (f.client) p.set('client', f.client);
  if (f.brand) p.set('brand', f.brand);
  if (f.account) p.set('account', f.account);
  if (f.q) p.set('q', f.q);
  if (f.minSpend && Number(f.minSpend) > 0) p.set('minSpend', f.minSpend);
  if (f.kind === 'creative') {
    if (f.type) p.set('type', f.type);
    if (f.theme) p.set('theme', f.theme);
    if (f.ugc) p.set('ugc', f.ugc);
  }
  if (f.onlyActive) p.set('onlyActive', '1');
  return p;
}

const inputCls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-50';
const smallInputCls = 'bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500';

// ── small building blocks ────────────────────────────────────────────────

/** Closes a dropdown on outside click / Esc. */
function useDismiss(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);
  return ref;
}

function OfferMultiSelect({ options, value, onChange }: { options: { token: string; campaignCount: number }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter(v => v !== t) : [...value, t]);
  const label = value.length === 0 ? 'All offers' : value.length === 1 ? value[0] : `${value.length} offers`;
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(o => !o)} className={`${inputCls} flex items-center gap-2 min-w-[140px]`}>
        <span className={value.length ? 'text-white' : 'text-slate-400'}>{label}</span>
        <span className="ml-auto text-slate-500 text-xs">▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-72 max-h-80 overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl p-1">
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="w-full text-left text-xs text-blue-300 hover:text-blue-200 px-2 py-1.5">Clear selection</button>
          )}
          {options.length === 0 && <p className="text-xs text-slate-500 px-2 py-1.5">No offers found</p>}
          {options.map(o => (
            <label key={o.token} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800 cursor-pointer text-sm text-slate-200">
              <input type="checkbox" checked={value.includes(o.token)} onChange={() => toggle(o.token)} className="accent-blue-500" />
              <span className="truncate">{o.token}</span>
              <span className="ml-auto text-[11px] text-slate-500">{o.campaignCount}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function ClientSearchSelect({ options, value, onChange }: { options: { id: string; name: string; brand: string }[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const selected = options.find(o => o.id === value);
  const filtered = useMemo(() => {
    const t = text.trim().toLowerCase();
    return (t ? options.filter(o => o.name.toLowerCase().includes(t)) : options).slice(0, 80);
  }, [options, text]);
  return (
    <div ref={ref} className="relative">
      <input
        type="text"
        value={open ? text : (selected?.name ?? '')}
        placeholder="All clients"
        onFocus={() => { setOpen(true); setText(''); }}
        onChange={e => setText(e.target.value)}
        className={`${inputCls} w-52`}
      />
      {value && !open && (
        <button type="button" onClick={() => onChange('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs" aria-label="Clear client">✕</button>
      )}
      {open && (
        <div className="absolute z-30 mt-1 w-72 max-h-80 overflow-y-auto bg-slate-900 border border-slate-700 rounded-lg shadow-xl p-1">
          <button type="button" onClick={() => { onChange(''); setOpen(false); }} className="w-full text-left text-sm text-slate-400 hover:bg-slate-800 px-2 py-1.5 rounded">All clients</button>
          {filtered.map(o => (
            <button key={o.id} type="button" onClick={() => { onChange(o.id); setOpen(false); }}
              className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-slate-800 ${o.id === value ? 'text-blue-300' : 'text-slate-200'}`}>
              {o.name}
            </button>
          ))}
          {filtered.length === 0 && <p className="text-xs text-slate-500 px-2 py-1.5">No match</p>}
        </div>
      )}
    </div>
  );
}

function Pill({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'blue' | 'amber' | 'red' | 'emerald' }) {
  const cls = {
    slate: 'text-slate-300 border-slate-700 bg-slate-800',
    blue: 'text-blue-300 border-blue-500/30 bg-blue-500/10',
    amber: 'text-amber-300 border-amber-500/30 bg-amber-500/10',
    red: 'text-red-300 border-red-500/30 bg-red-500/10',
    emerald: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  }[tone];
  return <span className={`inline-block text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>{children}</span>;
}

function OfferPills({ offers }: { offers: string[] }) {
  const shown = offers.slice(0, 3);
  const extra = offers.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map(o => <Pill key={o} tone={o === 'Unknown' ? 'slate' : 'blue'}>{o}</Pill>)}
      {extra > 0 && <Pill>+{extra}</Pill>}
    </div>
  );
}

export function Preview({ row, size = 96 }: { row: Pick<AssetLibraryRow, 'key' | 'type' | 'thumbnailUrl'>; size?: number }) {
  const [failed, setFailed] = useState(false);
  const isVideo = (row.type ?? row.key.split(':')[0]) === 'video';
  const style = { width: size, height: size };
  if (!row.thumbnailUrl || failed) {
    return (
      <div style={style} className="flex items-center justify-center rounded-md bg-slate-800 border border-slate-700 text-[10px] text-slate-500 text-center px-1">
        {isVideo ? '▶ no preview' : 'no preview'}
      </div>
    );
  }
  return (
    <div style={style} className="relative rounded-md overflow-hidden bg-slate-800 border border-slate-700 shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={row.thumbnailUrl} alt="" loading="lazy" onError={() => setFailed(true)} className="w-full h-full object-cover" />
      {isVideo && <span className="absolute bottom-1 right-1 text-[10px] leading-none px-1.5 py-0.5 rounded bg-black/70 text-white">▶</span>}
    </div>
  );
}

function CopyText({ text, fallback }: { text: string | null; fallback: string }) {
  const [more, setMore] = useState(false);
  if (!text) return <span className="font-mono text-xs text-slate-500">{fallback}</span>;
  const long = text.length > 160 || text.split('\n').length > 3;
  return (
    <div className="max-w-md">
      <p className={`text-sm text-slate-200 whitespace-pre-line ${more ? '' : 'line-clamp-3'}`}>{text}</p>
      {long && (
        <button type="button" onClick={e => { e.stopPropagation(); setMore(m => !m); }} className="text-[11px] text-blue-300 hover:text-blue-200 mt-0.5">
          {more ? 'less' : 'more'}
        </button>
      )}
    </div>
  );
}

// ── tagging ──────────────────────────────────────────────────────────────

type TagField = 'theme' | 'ugcStatus';

async function saveTag(row: AssetLibraryRow, field: TagField, value: string | null): Promise<boolean> {
  if (!row.thumbAccountId) return false;
  try {
    const res = await fetch('/api/admin/creative-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // accountIds = every account the asset ran in, so the tag lands on
      // each account's own row (same contract the client dashboard uses).
      body: JSON.stringify({ accountId: row.thumbAccountId, accountIds: row.accountIds, assetKey: row.key, [field]: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function TagSelect({ row, field, options, onChange, failed }: {
  row: AssetLibraryRow; field: TagField; options: { value: string; label: string }[]; onChange: (v: string | null) => void; failed: boolean;
}) {
  const current = field === 'theme' ? row.theme : row.ugcStatus;
  const label = options.find(o => o.value === current)?.label ?? (current || '—');
  if (failed || !row.thumbAccountId) {
    return <Pill tone={failed ? 'red' : 'slate'}>{failed ? `${label} (save failed)` : label}</Pill>;
  }
  return (
    <select value={current ?? ''} onClick={e => e.stopPropagation()} onChange={e => onChange(e.target.value || null)} className={smallInputCls}>
      <option value="">—</option>
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── main component ───────────────────────────────────────────────────────

export default function AssetLibrary({ initial, range, options }: {
  initial: AssetLibraryInitial;
  range: { preset: string; since: string; until: string };
  options: AssetLibraryOptions;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(new URLSearchParams(searchParams.toString())));
  const [rows, setRows] = useState<AssetLibraryRow[]>(initial.rows);
  const [total, setTotal] = useState(initial.total);
  const [totals, setTotals] = useState(initial.totals);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AssetLibraryRow | null>(null);
  const [tagFailed, setTagFailed] = useState<Set<string>>(new Set());
  const [qInput, setQInput] = useState(filters.q);
  const [minSpendInput, setMinSpendInput] = useState(filters.minSpend);
  const firstRender = useRef(true);
  const reqSeq = useRef(0);

  const isCreative = filters.kind === 'creative';

  // Any filter change: mirror it into the URL (no server round-trip — the
  // API is the data path) and refetch. The first render already has the
  // server's page for this exact URL, so it's skipped.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    const params = paramsFromFilters(filters, range);
    const qs = params.toString();
    window.history.replaceState(window.history.state, '', qs ? `${pathname}?${qs}` : pathname);

    const seq = ++reqSeq.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/marketer/assets?${qs}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ rows: AssetLibraryRow[]; total: number; totals: AssetLibraryInitial['totals'] }>;
      })
      .then(data => {
        if (seq !== reqSeq.current) return; // a newer request superseded this one
        setRows(data.rows);
        setTotal(data.total);
        setTotals(data.totals);
        setLoading(false);
      })
      .catch(err => {
        if (err?.name === 'AbortError' || seq !== reqSeq.current) return;
        setError(err?.message || 'Failed to load');
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [filters, pathname, range]);

  // Debounced free-text search so each keystroke doesn't hit the DB.
  useEffect(() => {
    const t = setTimeout(() => { if (qInput !== filters.q) update({ q: qInput }); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  /** Filter change resets to page 1; sort/page changes keep everything else. */
  const update = useCallback((patch: Partial<Filters>, opts?: { keepPage?: boolean }) => {
    setFilters(f => ({ ...f, ...patch, page: opts?.keepPage ? (patch.page ?? f.page) : 1 }));
  }, []);

  const setKind = (kind: AssetKind) => {
    if (kind === filters.kind) return;
    // Creative-only filters don't apply to copy kinds; sorting carries over.
    update({ kind, type: '', theme: '', ugc: '' });
  };

  const setSort = (sort: AssetSort) => {
    if (sort === filters.sort) update({ dir: filters.dir === 'asc' ? 'desc' : 'asc' }, { keepPage: true });
    else update({ sort, dir: sort === 'cpl' ? 'asc' : 'desc' }, { keepPage: true });
  };

  const onTag = async (row: AssetLibraryRow, field: TagField, value: string | null) => {
    const prev = field === 'theme' ? row.theme : row.ugcStatus;
    const apply = (v: string | null) => setRows(rs => rs.map(r => (r.key === row.key ? { ...r, [field]: v } : r)));
    apply(value);
    const ok = await saveTag(row, field, value);
    if (!ok) {
      apply(prev);
      setTagFailed(s => new Set(s).add(`${row.key}:${field}`));
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  const exportHref = `/api/marketer/assets/export?${paramsFromFilters({ ...filters, page: 1 }, range).toString()}`;
  const totalCpl = totals.results > 0 ? totals.spend / totals.results : null;

  const SortHeader = ({ sort, label, align = 'right' }: { sort: AssetSort; label: string; align?: 'left' | 'right' }) => {
    const active = filters.sort === sort;
    return (
      <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>
        <button type="button" onClick={() => setSort(sort)} className={`inline-flex items-center gap-1 hover:text-white ${active ? 'text-white' : ''}`}>
          {label}
          <span className={`text-[9px] ${active ? 'text-blue-300' : 'text-slate-700'}`}>{active ? (filters.dir === 'asc' ? '▲' : '▼') : '▼'}</span>
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-4">
      {/* Kind tabs */}
      <div className="flex items-center gap-1 border-b border-slate-800">
        {KIND_TABS.map(t => (
          <button key={t.kind} type="button" onClick={() => setKind(t.kind)}
            className={`px-4 py-2 text-sm -mb-px border-b-2 transition-colors ${filters.kind === t.kind ? 'border-blue-500 text-white' : 'border-transparent text-slate-400 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <OfferMultiSelect options={options.offers} value={filters.offer} onChange={v => update({ offer: v })} />
        <ClientSearchSelect options={options.clients} value={filters.client} onChange={v => update({ client: v })} />
        <select value={filters.brand} onChange={e => update({ brand: e.target.value })} className={inputCls}>
          <option value="">All brands</option>
          {options.brands.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={filters.account} onChange={e => update({ account: e.target.value })} className={`${inputCls} max-w-[220px]`}>
          <option value="">All accounts</option>
          {options.accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
        </select>
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">Min spend $</span>
          <input type="number" min={0} step={1} value={minSpendInput} placeholder="0"
            onChange={e => setMinSpendInput(e.target.value)}
            onBlur={() => { if (minSpendInput !== filters.minSpend) update({ minSpend: minSpendInput }); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className={`${inputCls} w-24`} />
        </div>
        {isCreative && (
          <>
            <select value={filters.type} onChange={e => update({ type: e.target.value as Filters['type'] })} className={inputCls}>
              <option value="">Image + video</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
            </select>
            <select value={filters.theme} onChange={e => update({ theme: e.target.value })} className={inputCls}>
              <option value="">Any theme</option>
              {THEME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={filters.ugc} onChange={e => update({ ugc: e.target.value })} className={inputCls}>
              <option value="">UGC + non-UGC</option>
              {UGC_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </>
        )}
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
          <input type="checkbox" checked={filters.onlyActive} onChange={e => update({ onlyActive: e.target.checked })} className="accent-blue-500" />
          Only in active ads
        </label>
        <input type="search" value={qInput} onChange={e => setQInput(e.target.value)}
          placeholder={isCreative ? 'Search campaign name / key…' : 'Search text…'} className={`${inputCls} w-56 ml-auto`} />
        <a href={exportHref} className="px-3 py-2 text-sm font-medium rounded-lg border border-slate-700 hover:border-slate-500 text-slate-200 hover:text-white transition-colors">
          Export CSV
        </a>
      </div>

      {/* Totals strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Spend (filtered)</p>
          <p className="text-xl font-semibold text-white mt-1">{fmtUsd(totals.spend, 0)}</p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Leads</p>
          <p className="text-xl font-semibold text-white mt-1">{fmtInt(totals.results)}</p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">CPL</p>
          <p className="text-xl font-semibold text-white mt-1">{fmtUsd(totalCpl)}</p>
        </div>
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Assets</p>
          <p className="text-xl font-semibold text-white mt-1">{fmtInt(total)}</p>
          <p className="text-xs text-slate-500 mt-0.5">{fmtInt(totals.impressions)} impressions</p>
        </div>
      </div>

      {error && <p className="text-sm text-red-300 border border-red-500/30 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>}

      {/* Table */}
      <div className={`bg-slate-900/60 border border-slate-800 rounded-xl overflow-x-auto transition-opacity ${loading ? 'opacity-60' : ''}`}>
        <table className="w-full text-sm min-w-[1100px]">
          <thead className="text-[11px] uppercase tracking-wider text-slate-500">
            <tr className="border-b border-slate-800">
              <th className="text-left px-3 py-2">{isCreative ? 'Preview' : 'Text'}</th>
              {isCreative && <th className="text-left px-3 py-2">Theme</th>}
              {isCreative && <th className="text-left px-3 py-2">UGC</th>}
              <SortHeader sort="spend" label="Spend" />
              <SortHeader sort="results" label="Leads" />
              <SortHeader sort="cpl" label="CPL" />
              <SortHeader sort="ctr" label="CTR" />
              <SortHeader sort="cpm" label="CPM" />
              <SortHeader sort="impressions" label="Impr." />
              <SortHeader sort="reach" label="Reach" />
              <SortHeader sort="adCount" label="Ads" />
              <SortHeader sort="clientCount" label="Clients" />
              <th className="text-left px-3 py-2">Offers</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {rows.length === 0 && !loading && (
              <tr><td colSpan={13} className="px-3 py-10 text-center text-slate-500">No assets match these filters in {range.since} → {range.until}.</td></tr>
            )}
            {rows.map(row => (
              <tr key={row.key} onClick={() => setSelected(row)} className="hover:bg-slate-800/30 cursor-pointer">
                <td className="px-3 py-2 align-top">
                  {isCreative
                    ? <Preview row={row} />
                    : <CopyText text={row.text} fallback={row.key.slice(0, 12)} />}
                  {!isCreative && row.isStaticOnly && <span className="block mt-1"><Pill>static ads only</Pill></span>}
                </td>
                {isCreative && (
                  <td className="px-3 py-2 align-top">
                    <TagSelect row={row} field="theme" options={THEME_OPTIONS} failed={tagFailed.has(`${row.key}:theme`)} onChange={v => onTag(row, 'theme', v)} />
                  </td>
                )}
                {isCreative && (
                  <td className="px-3 py-2 align-top">
                    <TagSelect row={row} field="ugcStatus" options={UGC_OPTIONS} failed={tagFailed.has(`${row.key}:ugcStatus`)} onChange={v => onTag(row, 'ugcStatus', v)} />
                  </td>
                )}
                <td className="px-3 py-2 text-right text-white align-top">{fmtUsd(row.spend)}</td>
                <td className="px-3 py-2 text-right text-slate-200 align-top">{fmtInt(row.results)}</td>
                <td className="px-3 py-2 text-right text-white font-medium align-top">{fmtUsd(row.cpl)}</td>
                <td className="px-3 py-2 text-right text-slate-300 align-top">{fmtPct(row.ctr)}</td>
                <td className="px-3 py-2 text-right text-slate-300 align-top">{fmtUsd(row.cpm)}</td>
                <td className="px-3 py-2 text-right text-slate-300 align-top">{fmtInt(row.impressions)}</td>
                <td className="px-3 py-2 text-right text-slate-300 align-top">{fmtInt(row.reach)}</td>
                <td className="px-3 py-2 text-right text-slate-300 align-top">
                  <span className={row.activeAdCount > 0 ? 'text-emerald-300' : 'text-slate-500'}>{row.activeAdCount}</span>
                  <span className="text-slate-600"> / </span>{row.adCount}
                </td>
                <td className="px-3 py-2 text-right text-slate-300 align-top">{row.clientCount}</td>
                <td className="px-3 py-2 align-top"><OfferPills offers={row.offers} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pager */}
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
        <button type="button" disabled={filters.page <= 1 || loading} onClick={() => update({ page: filters.page - 1 }, { keepPage: true })}
          className="px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 disabled:opacity-40 text-slate-200">‹ Prev</button>
        <span>page {filters.page} of {pageCount}</span>
        <button type="button" disabled={filters.page >= pageCount || loading} onClick={() => update({ page: filters.page + 1 }, { keepPage: true })}
          className="px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 disabled:opacity-40 text-slate-200">Next ›</button>
        <span className="text-slate-500">{fmtInt(total)} rows</span>
        <label className="ml-auto flex items-center gap-2">
          <span className="text-xs text-slate-500">Rows per page</span>
          <select value={filters.pageSize} onChange={e => update({ pageSize: Number(e.target.value) })} className={smallInputCls}>
            {[25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      {selected && (
        <AssetDetailDrawer
          kind={filters.kind}
          assetKey={selected.key}
          range={range}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
