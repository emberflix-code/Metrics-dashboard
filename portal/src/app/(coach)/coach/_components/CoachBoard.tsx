'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BOARD_COLUMNS, COLUMN_BY_KEY, CHEAP_METRIC_KEYS, CPA_METRIC_KEYS, GROUP_BY_OPTIONS, RANGE_PRESETS, defaultColumns, type CoachBoardPrefs } from '@/lib/coach/columns';
import { groupColorFor } from '@/lib/groupColors';

export interface BoardClient {
  id: string;
  name: string;
  isRollup: boolean;
  marketingType: string;
  offer: string;
  coachName: string;
  contactName: string;
  locationAddress: string;
  leadsSource: string;
  hasMeta: boolean;
  hasGoogle: boolean;
  googleSource: 'api' | 'sheet' | null;
  hasGhl: boolean;
  dataSource: string;
  showCreativesV3: boolean;
  showBookings: boolean;
  cpaEnabled: boolean;
  ltvEnabled: boolean;
}

type Metrics = Record<string, number | null | undefined> & { error?: string };

const META_METRIC_KEYS = new Set(['spend', 'leads', 'cpl', 'impressions', 'reach', 'link_clicks', 'ctr']);

const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n: number, dp = 0) => n.toLocaleString('en-US', { maximumFractionDigits: dp });

function formatMetric(key: string, v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  switch (key) {
    case 'spend': case 'cpl': case 'g_spend': case 'g_cpl': case 'total_spend': case 'cpa': case 'ltv': return money(v);
    case 'ctr': return v.toFixed(2) + '%';
    case 'g_leads': return num(v, 2);
    case 'spend_delta': return (v > 0 ? '+' : '') + v.toFixed(1) + '%';
    default: return num(v);
  }
}

function groupKeyOf(c: BoardClient, groupBy: string): string {
  if (c.isRollup) return 'Rollups (combined dashboards)';
  if (groupBy === 'offer') return c.offer || '(no offer)';
  if (groupBy === 'coach') return c.coachName || '(no coach)';
  if (groupBy === 'none') return 'All clients';
  return c.marketingType || '(no marketing type)';
}

export default function CoachBoard({ clients, prefs, isAdmin, coachNames }: {
  clients: BoardClient[]; prefs: CoachBoardPrefs; isAdmin: boolean; coachNames: string[];
}) {
  const [columns, setColumns] = useState<string[]>(prefs.columns);
  const [groupBy, setGroupBy] = useState(prefs.groupBy);
  const [range, setRange] = useState(prefs.range);
  const [collapsed, setCollapsed] = useState<string[]>(prefs.collapsed);
  const [coachFilter, setCoachFilter] = useState(prefs.coachFilter);
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  // metrics[range][clientId] = merged values; loaded[range] = keys fetched for that range
  const [metrics, setMetrics] = useState<Record<string, Record<string, Metrics>>>({});
  const loadedRef = useRef<Record<string, Set<string>>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [rangeInfo, setRangeInfo] = useState<Record<string, { since: string; until: string; meta: string | null; google: string | null }>>({});
  const [error, setError] = useState('');

  // ── save settings (debounced) ──
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) { firstSave.current = false; return; }
    const t = setTimeout(() => {
      fetch('/api/coach/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns, groupBy, range, collapsed, ...(isAdmin ? { coachFilter } : {}) }) }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [columns, groupBy, range, collapsed, coachFilter, isAdmin]);

  // ── visible clients ──
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return clients.filter(c => {
      if (isAdmin && coachFilter) {
        const names = c.coachName.split(',').map(n => n.trim().toLowerCase());
        if (!names.includes(coachFilter.toLowerCase())) return false;
      }
      if (!term) return true;
      return [c.name, c.offer, c.marketingType, c.coachName, c.contactName].some(v => v.toLowerCase().includes(term));
    });
  }, [clients, search, isAdmin, coachFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, BoardClient[]>();
    for (const c of visible) { const k = groupKeyOf(c, groupBy); map.set(k, [...(map.get(k) || []), c]); }
    const rank = (k: string) => (k.startsWith('Rollups') ? 2 : k.startsWith('(') ? 1 : 0);
    return Array.from(map.entries()).sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
  }, [visible, groupBy]);

  // ── load cheap metrics for visible columns (only keys not loaded yet for this range) ──
  const cheapVisible = useMemo(() => columns.filter(k => CHEAP_METRIC_KEYS.includes(k)), [columns]);
  useEffect(() => {
    const loaded = loadedRef.current[range] || new Set<string>();
    const missing = cheapVisible.filter(k => !loaded.has(k));
    if (!missing.length) return;
    const ctrl = new AbortController();
    let done = false;
    missing.forEach(k => loaded.add(k));
    loadedRef.current[range] = loaded;
    setLoadingKeys(s => new Set([...Array.from(s), ...missing]));
    fetch('/api/coach/board-metrics', { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range, keys: missing }) })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j.error || 'Failed to load numbers');
        done = true;
        setRangeInfo(s => ({ ...s, [range]: { since: j.range.since, until: j.range.until, meta: j.metaCachedThrough, google: j.googleCachedThrough } }));
        setMetrics(s => {
          const cur = { ...(s[range] || {}) };
          for (const [id, row] of Object.entries<Metrics>(j.rows || {})) cur[id] = { ...(cur[id] || {}), ...row };
          return { ...s, [range]: cur };
        });
      })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); missing.forEach(k => loaded.delete(k)); } })
      .finally(() => setLoadingKeys(s => { const n = new Set(s); missing.forEach(k => n.delete(k)); return n; }));
    // Only an unfinished request is undone; finished keys stay loaded.
    return () => { if (!done) { ctrl.abort(); missing.forEach(k => loaded.delete(k)); } };
  }, [cheapVisible, range]);

  // ── slower columns (live GHL calls / CPA sheet reads): never loaded in bulk.
  // Each cell has an eye button that loads that one client's numbers for the
  // group (GHL → leads + bookings; CPA → won, CPA, LTV) for the current range.
  const [revealing, setRevealing] = useState<Set<string>>(new Set());
  const reveal = useCallback(async (kind: 'ghl' | 'cpa', clientId: string) => {
    const key = `${range}|${kind}|${clientId}`;
    setRevealing(s => new Set(s).add(key));
    try {
      const r = await fetch(`/api/coach/board-metrics/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range, clientIds: [clientId] }) });
      const j = await r.json();
      const row: Metrics = (j.rows || {})[clientId] || { error: j.error || 'No data returned' };
      setMetrics(s => {
        const cur = { ...(s[range] || {}) };
        cur[clientId] = { ...(cur[clientId] || {}), ...row, ...(row.error ? { [`${kind}_error`]: 1 } : {}) };
        return { ...s, [range]: cur };
      });
    } catch { /* leave the eye so they can retry */ }
    setRevealing(s => { const n = new Set(s); n.delete(key); return n; });
  }, [range]);

  const shown = columns.map(k => COLUMN_BY_KEY.get(k)!).filter(Boolean);
  const rangeMetrics = metrics[range] || {};
  const info = rangeInfo[range];
  const staleMeta = info?.meta && info.until > info.meta;
  const staleGoogle = info?.google && info.until > info.google;

  const toggleGroup = useCallback((k: string) => setCollapsed(c => c.includes(k) ? c.filter(x => x !== k) : [...c, k]), []);

  function cell(c: BoardClient, key: string) {
    const m = rangeMetrics[c.id];
    switch (key) {
      case 'offer': return c.offer || <span className="text-slate-600">—</span>;
      case 'marketing_type': return c.marketingType || <span className="text-slate-600">—</span>;
      case 'coach': return c.coachName || <span className="text-slate-600">—</span>;
      case 'contact': return c.contactName || <span className="text-slate-600">—</span>;
      case 'location': return <span className="text-slate-400">{c.locationAddress || '—'}</span>;
      case 'leads_source': return <span className="text-[11px] uppercase tracking-wide text-slate-400">{c.leadsSource}</span>;
      case 'channels': return <ChannelBadges c={c} staleMeta={!!staleMeta} staleGoogle={!!staleGoogle} info={info} />;
      case 'data_source': return c.hasMeta
        ? <span className={`text-[11px] px-1.5 py-0.5 rounded ${c.dataSource === 'cached' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>{c.dataSource === 'cached' ? 'Cached' : 'Live'}</span>
        : <span className="text-slate-700">—</span>;
      case 'creatives_v3': return <Flag on={c.showCreativesV3} />;
      case 'ghl': return <Flag on={c.hasGhl} />;
      case 'bookings_on': return <Flag on={c.showBookings} />;
      case 'cpa_on': return <Flag on={c.cpaEnabled} />;
      case 'ltv_on': return <Flag on={c.ltvEnabled} />;
    }
    const col = COLUMN_BY_KEY.get(key);
    if (col?.kind !== 'metric') return null;
    if (col.cost === 'slow') {
      const kind: 'ghl' | 'cpa' = CPA_METRIC_KEYS.includes(key) ? 'cpa' : 'ghl';
      const eligible = kind === 'cpa' ? (key === 'ltv' ? c.ltvEnabled : c.cpaEnabled) : c.hasGhl;
      if (!eligible) {
        const why = kind === 'cpa' ? (key === 'ltv' ? 'LTV is not on for this client' : 'CPA is not on for this client') : 'GHL is not connected for this client';
        // No integration / no data for this client: leave the cell blank (reason on hover).
        return <span className="inline-block w-4 h-4" title={why} />;
      }
      if (m?.[`${kind}_error`]) return <button type="button" onClick={() => reveal(kind, c.id)} className="text-rose-400" title={`${String(m.error)} — click to retry`}>!</button>;
      if (m?.[key] !== undefined) return formatMetric(key, m[key] as number);
      const busy = revealing.has(`${range}|${kind}|${c.id}`);
      return (
        <button type="button" onClick={() => reveal(kind, c.id)} disabled={busy}
          title={kind === 'cpa' ? 'Show won sales, CPA and LTV for this client' : 'Show GHL leads and bookings for this client'}
          className="inline-flex justify-end text-slate-400 hover:text-blue-300 disabled:opacity-60">
          {busy ? <span className="text-slate-500">…</span> : <EyeIcon />}
        </button>
      );
    }
    // Channel not set up for this client: a dash, not a misleading $0.00.
    if (key.startsWith('g_') && !c.hasGoogle) return <span className="text-slate-700" title="No Google Ads set up">—</span>;
    if (META_METRIC_KEYS.has(key) && !c.hasMeta) return <span className="text-slate-700" title="No Meta ads set up">—</span>;
    if (!m || m[key] === undefined) return loadingKeys.has(key) ? <span className="inline-block h-3 w-12 rounded bg-slate-800 animate-pulse" /> : <span className="text-slate-600">—</span>;
    const v = m[key] as number | null;
    if (key === 'leads' && c.leadsSource !== 'meta') {
      return <span title={`This client's dashboard counts leads from ${c.leadsSource === 'ghl' ? 'GHL' : 'the sheet'}; this is Meta's own number`}>{formatMetric(key, v)}<span className="text-slate-500">*</span></span>;
    }
    if (key === 'spend_delta' && typeof v === 'number') return <span className={v >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{formatMetric(key, v)}</span>;
    return formatMetric(key, v);
  }

  function groupTotal(cs: BoardClient[], key: string): string {
    const sum = (k: string) => cs.reduce((s, c) => s + (Number(rangeMetrics[c.id]?.[k]) || 0), 0);
    switch (key) {
      case 'spend': case 'leads': case 'impressions': case 'reach': case 'link_clicks': case 'g_spend': case 'g_leads': case 'total_spend':
        return cs.some(c => rangeMetrics[c.id]?.[key] !== undefined) ? formatMetric(key, sum(key)) : '';
      case 'cpl': { const l = sum('leads'); return l > 0 && cs.some(c => rangeMetrics[c.id]?.spend !== undefined) ? money(sum('spend') / l) : ''; }
      case 'g_cpl': { const l = sum('g_leads'); return l > 0 ? money(sum('g_spend') / l) : ''; }
      case 'ctr': { const i = sum('impressions'); return i > 0 && columns.includes('link_clicks') ? (sum('link_clicks') / i * 100).toFixed(2) + '%' : ''; }
      default: return '';
    }
  }

  const colSpan = shown.length + 2;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients, offers, owners…"
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 w-64 focus:outline-none focus:border-blue-500" />
        <Select label="Group by" value={groupBy} onChange={setGroupBy}
          options={GROUP_BY_OPTIONS.filter(o => isAdmin || o.key !== 'coach').map(o => ({ value: o.key, label: o.label }))} />
        <Select label="Range" value={range} onChange={setRange} options={RANGE_PRESETS.map(r => ({ value: r.key, label: r.label }))} />
        {isAdmin && (
          <Select label="Coach" value={coachFilter} onChange={setCoachFilter}
            options={[{ value: '', label: 'All coaches' }, ...coachNames.map(n => ({ value: n, label: n }))]} />
        )}
        <div className="relative">
          <button type="button" onClick={() => setPickerOpen(o => !o)}
            className="text-sm text-slate-200 border border-slate-700 hover:border-slate-500 rounded-lg px-3 py-2">Columns ({shown.length})</button>
          {pickerOpen && <ColumnPicker columns={columns} setColumns={setColumns} isAdmin={isAdmin} onClose={() => setPickerOpen(false)} />}
        </div>
        <div className="ml-auto text-xs text-slate-500">
          {visible.length} client{visible.length === 1 ? '' : 's'}
          {info && <> · {info.since === info.until ? info.since : `${info.since} → ${info.until}`}</>}
          {info?.meta && <> · data through {info.meta}{staleMeta ? ' (Meta)' : ''}</>}
        </div>
      </div>
      {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">{error}</p>}

      <div className="border border-slate-800 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/80 text-[11px] uppercase tracking-wider text-slate-500 sticky top-0">
            <tr>
              <th className="text-left px-3 py-2.5 min-w-[260px]">Client</th>
              {shown.map(col => (
                <th key={col.key} title={col.help} className={`px-3 py-2.5 whitespace-nowrap text-${col.align}`}>{col.label}</th>
              ))}
              <th className="text-right px-3 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={colSpan} className="px-3 py-8 text-center text-slate-500">No clients match.</td></tr>}
            {groups.map(([key, cs]) => {
              const color = groupColorFor(key);
              const open = !collapsed.includes(key);
              return (
                <Fragment key={key}>
                  <tr className="cursor-pointer select-none" style={{ backgroundColor: color.tint }} onClick={() => toggleGroup(key)}>
                    <td colSpan={colSpan} className="p-0">
                      <div className="flex items-stretch">
                        <div className="w-1.5 shrink-0" style={{ backgroundColor: color.bar }} />
                        <div className="flex items-center gap-2 px-3 py-2.5">
                          <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="font-semibold text-white text-sm">{key}</span>
                          <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full text-slate-900" style={{ backgroundColor: color.bar }}>{cs.length}</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {open && cs.map(c => (
                    <tr key={c.id} className="border-t border-slate-800/70 hover:bg-slate-900/60">
                      <td className="p-0">
                        <div className="flex items-stretch">
                          <div className="w-1.5 shrink-0" style={{ backgroundColor: color.bar }} />
                          <div className="px-3 py-2 text-slate-100">{c.name}</div>
                        </div>
                      </td>
                      {shown.map(col => (
                        <td key={col.key} className={`px-3 py-2 whitespace-nowrap text-${col.align} ${col.kind === 'metric' ? 'font-mono text-xs text-slate-200' : 'text-xs text-slate-300'}`}>
                          {cell(c, col.key)}
                        </td>
                      ))}
                      <td className="px-3 py-2"><RowActions client={c} /></td>
                    </tr>
                  ))}
                  {open && shown.some(col => col.kind === 'metric') && (
                    <tr className="border-t border-slate-700 bg-slate-900/40 text-xs">
                      <td className="px-3 py-1.5 pl-6 text-[11px] uppercase tracking-wider text-slate-500">Group total</td>
                      {shown.map(col => (
                        <td key={col.key} className={`px-3 py-1.5 text-${col.align} font-mono text-slate-300`}>{col.kind === 'metric' ? groupTotal(cs, col.key) : ''}</td>
                      ))}
                      <td />
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {columns.includes('leads') && <p className="text-[11px] text-slate-500">* Meta&apos;s own lead count. This client&apos;s dashboard counts leads from the sheet or GHL, so it can show a different number.</p>}
    </div>
  );
}

function Flag({ on }: { on: boolean }) {
  return on ? <span className="text-emerald-300" title="On">✓</span> : <span className="text-slate-700" title="Off">—</span>;
}

function EyeIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z" />
      <circle cx="12" cy="12" r="3" strokeWidth={2} />
    </svg>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-400 border border-slate-700 rounded-lg px-2 py-1.5">
      {label}
      <select value={value} onChange={e => onChange(e.target.value)} className="bg-transparent text-sm text-white focus:outline-none">
        {options.map(o => <option key={o.value} value={o.value} className="bg-slate-900">{o.label}</option>)}
      </select>
    </label>
  );
}

function ChannelBadges({ c, staleMeta, staleGoogle, info }: { c: BoardClient; staleMeta: boolean; staleGoogle: boolean; info?: { meta: string | null; google: string | null } }) {
  const pill = (on: boolean, label: string, stale: boolean, title: string) => (
    <span title={title} className={`relative inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${on
      ? label === 'Meta' ? 'bg-blue-500/15 text-blue-200 border-blue-500/30' : 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30'
      : 'bg-slate-800/50 text-slate-600 border-slate-700/50'}`}>
      {label}
      {on && stale && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400" />}
    </span>
  );
  return (
    <span className="inline-flex gap-1">
      {pill(c.hasMeta, 'Meta', staleMeta, c.hasMeta ? `Meta ads${info?.meta ? ` — data through ${info.meta}` : ''}` : 'No Meta ads set up')}
      {pill(c.hasGoogle, 'Google', staleGoogle, c.hasGoogle ? `Google Ads (${c.googleSource === 'api' ? 'live from Google Ads' : 'from the Google sheet tab'})${info?.google && c.googleSource === 'api' ? ` — data through ${info.google}` : ''}` : 'No Google Ads set up')}
    </span>
  );
}

function ColumnPicker({ columns, setColumns, isAdmin, onClose }: { columns: string[]; setColumns: (c: string[]) => void; isAdmin: boolean; onClose: () => void }) {
  const toggle = (key: string) => setColumns(columns.includes(key) ? columns.filter(k => k !== key) : BOARD_COLUMNS.map(c => c.key).filter(k => k === key || columns.includes(k)));
  const section = (title: string, kind: 'config' | 'metric') => (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">{title}</p>
      {BOARD_COLUMNS.filter(c => c.kind === kind && (isAdmin || c.key !== 'coach')).map(c => (
        <label key={c.key} className="flex items-start gap-2 py-1 text-sm text-slate-200 cursor-pointer" title={c.help}>
          <input type="checkbox" checked={columns.includes(c.key)} onChange={() => toggle(c.key)} className="mt-0.5 accent-blue-500" />
          <span>{c.label}{c.cost === 'slow' && <span className="ml-1 text-[10px] text-amber-300" title="Not loaded for every row — click the eye on a row to see it">per row</span>}</span>
        </label>
      ))}
    </div>
  );
  return (
    <div className="absolute z-30 mt-2 w-[420px] right-0 bg-slate-900 border border-slate-700 rounded-xl shadow-xl p-4">
      <div className="grid grid-cols-2 gap-4">
        {section('Details', 'config')}
        {section('Numbers', 'metric')}
      </div>
      <div className="flex justify-between mt-3 pt-3 border-t border-slate-800">
        <button type="button" onClick={() => setColumns(defaultColumns(isAdmin))} className="text-xs text-slate-400 hover:text-white">Reset to default</button>
        <button type="button" onClick={onClose} className="text-xs text-blue-300 hover:text-blue-200">Done</button>
      </div>
      <p className="text-[11px] text-slate-500 mt-2">Only the numbers you show are loaded. Saved to your login.</p>
    </div>
  );
}

function RowActions({ client }: { client: BoardClient }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'none' | 'error'>('idle');
  const [opening, setOpening] = useState(false);

  async function copy() {
    try {
      const r = await fetch(`/api/coach/clients/${client.id}/auto-login`);
      const j = await r.json();
      if (!r.ok) { setCopyState('error'); return; }
      if (!j.url) { setCopyState('none'); return; }
      await navigator.clipboard.writeText(j.url);
      setCopyState('copied');
    } catch { setCopyState('error'); }
    setTimeout(() => setCopyState('idle'), 2500);
  }

  async function open() {
    setOpening(true);
    try {
      const r = await fetch('/api/coach/impersonate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: client.id }) });
      const j = await r.json();
      if (!r.ok) { alert(j.error || 'Could not open this dashboard'); setOpening(false); return; }
      window.location.href = j.redirect || '/dashboard';
    } catch { setOpening(false); }
  }

  return (
    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
      <button type="button" onClick={copy} title="Copy the client's auto-login link"
        className={`text-xs px-2 py-1 rounded-md border ${copyState === 'copied' ? 'border-emerald-500/40 text-emerald-300' : copyState === 'none' || copyState === 'error' ? 'border-amber-500/40 text-amber-300' : 'border-slate-700 text-slate-300 hover:text-white hover:border-slate-500'}`}>
        {copyState === 'copied' ? 'Copied ✓' : copyState === 'none' ? 'No link yet' : copyState === 'error' ? 'Failed' : 'Copy link'}
      </button>
      <button type="button" onClick={open} disabled={opening} title="Open this client's dashboard as the client"
        className="text-xs px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
        {opening ? 'Opening…' : 'View dashboard'}
      </button>
    </div>
  );
}
