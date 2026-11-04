'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BOARD_COLUMNS, COLUMN_BY_KEY, CHEAP_METRIC_KEYS, CPA_METRIC_KEYS, GROUP_BY_OPTIONS, defaultColumns, type CoachBoardPrefs } from '@/lib/coach/columns';
import { resolveBoardRange, formatRangeLabel } from '@/lib/coach/dateRange';
import { groupColorFor } from '@/lib/groupColors';
import DateRangePicker from './DateRangePicker';

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
type SlowKind = 'ghl' | 'cpa';

const META_METRIC_KEYS = new Set(['spend', 'leads', 'cpl', 'impressions', 'reach', 'link_clicks', 'ctr']);
// Always loaded (one cheap cached query) for the summary strip above the table.
const SUMMARY_KEYS = ['spend', 'leads', 'g_spend', 'g_leads'];
// Per-row (eye) numbers load in small batches so cells fill in as they arrive.
const SLOW_BATCH = 6;

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

const slowKindOf = (key: string): SlowKind => (CPA_METRIC_KEYS.includes(key) ? 'cpa' : 'ghl');
const eligibleFor = (c: BoardClient, kind: SlowKind) => (kind === 'cpa' ? c.cpaEnabled : c.hasGhl);

function configText(c: BoardClient, key: string): string {
  switch (key) {
    case 'offer': return c.offer;
    case 'marketing_type': return c.marketingType;
    case 'coach': return c.coachName;
    case 'contact': return c.contactName;
    case 'location': return c.locationAddress;
    case 'leads_source': return c.leadsSource;
    case 'channels': return `${c.hasMeta ? 'a' : 'b'}${c.hasGoogle ? 'a' : 'b'}`;
    case 'data_source': return c.hasMeta ? c.dataSource : '';
    case 'creatives_v3': return c.showCreativesV3 ? '1' : '';
    case 'ghl': return c.hasGhl ? '1' : '';
    case 'bookings_on': return c.showBookings ? '1' : '';
    case 'cpa_on': return c.cpaEnabled ? '1' : '';
    case 'ltv_on': return c.ltvEnabled ? '1' : '';
    default: return '';
  }
}

export default function CoachBoard({ clients, prefs, isAdmin, coachNames }: {
  clients: BoardClient[]; prefs: CoachBoardPrefs; isAdmin: boolean; coachNames: string[];
}) {
  const [columns, setColumns] = useState<string[]>(prefs.columns);
  const [groupBy, setGroupBy] = useState(prefs.groupBy);
  const [range, setRange] = useState(prefs.range);
  const [collapsed, setCollapsed] = useState<string[]>(prefs.collapsed);
  const [coachFilter, setCoachFilter] = useState(prefs.coachFilter);
  const [revealed, setRevealed] = useState<string[]>(prefs.revealed);
  const [sort, setSort] = useState(prefs.sort);
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  // metrics[range][clientId] = merged values for that range
  const [metrics, setMetrics] = useState<Record<string, Record<string, Metrics>>>({});
  const loadedRef = useRef<Record<string, Set<string>>>({});
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set());
  const [rangeInfo, setRangeInfo] = useState<Record<string, { since: string; until: string; meta: string | null; google: string | null }>>({});
  const [error, setError] = useState('');

  const resolved = resolveBoardRange(range) || resolveBoardRange('last_7d')!;

  // ── save settings (debounced) ──
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) { firstSave.current = false; return; }
    const t = setTimeout(() => {
      fetch('/api/coach/prefs', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns, groupBy, range, collapsed, revealed, sort, ...(isAdmin ? { coachFilter } : {}) }) }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [columns, groupBy, range, collapsed, coachFilter, revealed, sort, isAdmin]);

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

  const rangeMetrics = useMemo(() => metrics[range] || {}, [metrics, range]);

  const groups = useMemo(() => {
    const map = new Map<string, BoardClient[]>();
    for (const c of visible) { const k = groupKeyOf(c, groupBy); map.set(k, [...(map.get(k) || []), c]); }
    const rank = (k: string) => (k.startsWith('Rollups') ? 2 : k.startsWith('(') ? 1 : 0);
    const [sortKey, dir] = sort ? sort.split(':') : ['', 'asc'];
    const mul = dir === 'desc' ? -1 : 1;
    const cmp = (a: BoardClient, b: BoardClient) => {
      if (!sortKey || sortKey === 'name') return mul * a.name.localeCompare(b.name);
      const col = COLUMN_BY_KEY.get(sortKey);
      if (col?.kind === 'metric') {
        const va = rangeMetrics[a.id]?.[sortKey], vb = rangeMetrics[b.id]?.[sortKey];
        const na = typeof va === 'number', nb = typeof vb === 'number';
        // Rows without a number always sink to the bottom.
        if (na !== nb) return na ? -1 : 1;
        if (na && nb && va !== vb) return mul * ((va as number) - (vb as number));
        return a.name.localeCompare(b.name);
      }
      const ta = configText(a, sortKey), tb = configText(b, sortKey);
      if (!ta !== !tb) return ta ? -1 : 1;
      return mul * ta.localeCompare(tb) || a.name.localeCompare(b.name);
    };
    return Array.from(map.entries())
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([k, cs]) => [k, [...cs].sort(cmp)] as [string, BoardClient[]]);
  }, [visible, groupBy, sort, rangeMetrics]);

  // ── cheap (cached) numbers: visible columns + summary keys, only what isn't loaded for this range ──
  const cheapWanted = useMemo(() => Array.from(new Set([...SUMMARY_KEYS, ...columns.filter(k => CHEAP_METRIC_KEYS.includes(k))])), [columns]);
  useEffect(() => {
    const loaded = loadedRef.current[range] || new Set<string>();
    const missing = cheapWanted.filter(k => !loaded.has(k));
    if (!missing.length) return;
    const ctrl = new AbortController();
    let done = false;
    missing.forEach(k => loaded.add(k));
    loadedRef.current[range] = loaded;
    setLoadingKeys(s => new Set([...Array.from(s), ...missing]));
    setError('');
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
  }, [cheapWanted, range]);

  // ── slower numbers (live GHL calls / CPA sheet reads): never loaded in bulk.
  // The eye on a row adds it to `revealed` (saved to the login); every revealed
  // row then loads for whatever range is picked — changing the range reloads
  // them instead of hiding them again.
  const slowDoneRef = useRef<Record<string, Set<string>>>({});
  const [slowBusy, setSlowBusy] = useState<Set<string>>(new Set());
  const [slowTick, setSlowTick] = useState(0);
  const clientById = useMemo(() => new Map(clients.map(c => [c.id, c] as const)), [clients]);
  const shownSlowKinds = useMemo(() => new Set(columns.filter(k => COLUMN_BY_KEY.get(k)?.cost === 'slow').map(slowKindOf)), [columns]);

  useEffect(() => {
    const done = slowDoneRef.current[range] || new Set<string>();
    slowDoneRef.current[range] = done;
    const todo: Record<SlowKind, string[]> = { ghl: [], cpa: [] };
    for (const r of revealed) {
      const [kind, id] = r.split(':') as [SlowKind, string];
      const c = clientById.get(id);
      if (!c || !eligibleFor(c, kind) || !shownSlowKinds.has(kind) || done.has(r)) continue;
      todo[kind].push(id);
    }
    const batches: { kind: SlowKind; ids: string[] }[] = [];
    for (const kind of ['ghl', 'cpa'] as SlowKind[]) {
      for (let i = 0; i < todo[kind].length; i += SLOW_BATCH) batches.push({ kind, ids: todo[kind].slice(i, i + SLOW_BATCH) });
    }
    if (!batches.length) return;
    const keys = batches.flatMap(b => b.ids.map(id => `${b.kind}:${id}`));
    keys.forEach(k => done.add(k));
    setSlowBusy(s => new Set([...Array.from(s), ...keys.map(k => `${range}|${k}`)]));
    (async () => {
      // Two batches at a time: GHL and the CPA sheet both rate-limit.
      let next = 0;
      const runOne = async () => {
        while (next < batches.length) {
          const b = batches[next++];
          let rows: Record<string, Metrics> = {};
          let failMsg = '';
          try {
            const r = await fetch(`/api/coach/board-metrics/${b.kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ range, clientIds: b.ids }) });
            const j = await r.json();
            if (!r.ok) failMsg = j.error || 'Failed to load';
            rows = j.rows || {};
          } catch { failMsg = 'Network error'; }
          setMetrics(s => {
            const cur = { ...(s[range] || {}) };
            for (const id of b.ids) {
              const row: Metrics = rows[id] || { error: failMsg || 'No data returned' };
              cur[id] = { ...(cur[id] || {}), ...row, [`${b.kind}_error`]: row.error ? 1 : undefined };
              if (row.error) (cur[id] as Record<string, unknown>)[`${b.kind}_errmsg`] = String(row.error);
            }
            return { ...s, [range]: cur };
          });
          setSlowBusy(s => { const n = new Set(s); b.ids.forEach(id => n.delete(`${range}|${b.kind}:${id}`)); return n; });
        }
      };
      await Promise.all([runOne(), runOne()]);
    })();
  }, [revealed, range, clientById, shownSlowKinds, slowTick]);

  const reveal = useCallback((kind: SlowKind, clientId: string) => {
    const k = `${kind}:${clientId}`;
    // Retry after an error: forget the failed load for this range.
    slowDoneRef.current[range]?.delete(k);
    setRevealed(r => (r.includes(k) ? r : [...r, k]));
    setSlowTick(t => t + 1);
  }, [range]);
  const hideRow = useCallback((kind: SlowKind, clientId: string) => setRevealed(r => r.filter(x => x !== `${kind}:${clientId}`)), []);

  const shown = columns.map(k => COLUMN_BY_KEY.get(k)!).filter(Boolean);
  const info = rangeInfo[range];
  const staleMeta = !!(info?.meta && info.until > info.meta);
  const staleGoogle = !!(info?.google && info.until > info.google);

  const toggleGroup = useCallback((k: string) => setCollapsed(c => c.includes(k) ? c.filter(x => x !== k) : [...c, k]), []);
  const allCollapsed = groups.length > 0 && groups.every(([k]) => collapsed.includes(k));

  function toggleSort(key: string) {
    const [k, d] = sort ? sort.split(':') : ['', ''];
    const metric = COLUMN_BY_KEY.get(key)?.kind === 'metric';
    const first = metric ? 'desc' : 'asc';
    if (k !== key) setSort(`${key}:${first}`);
    else if (d === first) setSort(`${key}:${first === 'asc' ? 'desc' : 'asc'}`);
    else setSort('');
  }
  const sortDir = (key: string) => (sort.startsWith(key + ':') ? sort.split(':')[1] : '');

  // ── summary strip (non-rollup clients only: rollups re-count their clubs' spend) ──
  const summary = useMemo(() => {
    const base = visible.filter(c => !c.isRollup);
    const sum = (k: string) => base.reduce((s, c) => s + (Number(rangeMetrics[c.id]?.[k]) || 0), 0);
    const ready = base.some(c => rangeMetrics[c.id]?.spend !== undefined || rangeMetrics[c.id]?.g_spend !== undefined);
    const spend = sum('spend'), leads = sum('leads'), gSpend = sum('g_spend'), gLeads = sum('g_leads');
    return {
      ready, clients: base.length, rollups: visible.length - base.length,
      spend, leads, cpl: leads > 0 ? spend / leads : null,
      gSpend, gLeads, gCpl: gLeads > 0 ? gSpend / gLeads : null,
      total: spend + gSpend,
      anyGoogle: base.some(c => c.hasGoogle),
    };
  }, [visible, rangeMetrics]);

  function slowCell(c: BoardClient, key: string, m: Metrics | undefined) {
    const kind = slowKindOf(key);
    const eligible = key === 'ltv' ? c.ltvEnabled : eligibleFor(c, kind);
    if (!eligible) {
      const why = kind === 'cpa' ? (key === 'ltv' ? 'LTV is not on for this client' : 'CPA is not on for this client') : 'GHL is not connected for this client';
      // No integration / no data for this client: leave the cell blank (reason on hover).
      return <span className="inline-block w-4 h-4" title={why} />;
    }
    const isRevealed = revealed.includes(`${kind}:${c.id}`);
    const busy = slowBusy.has(`${range}|${kind}:${c.id}`);
    if (isRevealed && m?.[`${kind}_error`]) {
      return <button type="button" onClick={() => reveal(kind, c.id)} className="text-rose-400 font-sans font-semibold" title={`${String(m[`${kind}_errmsg`] ?? 'Failed')} — click to retry`}>!</button>;
    }
    if (isRevealed && m?.[key] !== undefined) {
      return (
        <button type="button" onClick={() => hideRow(kind, c.id)} className="hover:line-through decoration-slate-500"
          title={kind === 'cpa' ? 'Click to hide this client’s won/CPA/LTV again' : 'Click to hide this client’s GHL numbers again'}>
          {formatMetric(key, m[key] as number)}
        </button>
      );
    }
    if (isRevealed && busy) return <span className="inline-block h-3 w-10 rounded bg-slate-800 animate-pulse align-middle" />;
    return (
      <button type="button" onClick={() => reveal(kind, c.id)}
        title={kind === 'cpa' ? 'Show won sales, CPA and LTV for this client (stays on when you change dates)' : 'Show GHL leads and bookings for this client (stays on when you change dates)'}
        className="inline-flex justify-end text-slate-500 hover:text-blue-300">
        <EyeIcon />
      </button>
    );
  }

  function cell(c: BoardClient, key: string) {
    const m = rangeMetrics[c.id];
    const dash = <span className="text-slate-600">—</span>;
    switch (key) {
      case 'offer': return c.offer || dash;
      case 'marketing_type': return c.marketingType || dash;
      case 'coach': return c.coachName || dash;
      case 'contact': return c.contactName || dash;
      case 'location': return <span className="text-slate-400">{c.locationAddress || '—'}</span>;
      case 'leads_source': return <span className="text-[11px] uppercase tracking-wide text-slate-400">{c.leadsSource}</span>;
      case 'channels': return <ChannelBadges c={c} staleMeta={staleMeta} staleGoogle={staleGoogle} info={info} />;
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
    if (col.cost === 'slow') return slowCell(c, key, m);
    // Channel not set up for this client: a dash, not a misleading $0.00.
    if (key.startsWith('g_') && !c.hasGoogle) return <span className="text-slate-700" title="No Google Ads set up">—</span>;
    if (META_METRIC_KEYS.has(key) && !c.hasMeta) return <span className="text-slate-700" title="No Meta ads set up">—</span>;
    if (!m || m[key] === undefined) return loadingKeys.has(key) ? <span className="inline-block h-3 w-12 rounded bg-slate-800 animate-pulse align-middle" /> : dash;
    const v = m[key] as number | null;
    if (key === 'leads' && c.leadsSource !== 'meta') {
      return <span title={`This client's dashboard counts leads from ${c.leadsSource === 'ghl' ? 'GHL' : 'the sheet'}; this is Meta's own number`}>{formatMetric(key, v)}<span className="text-slate-500">*</span></span>;
    }
    if (key === 'spend_delta' && typeof v === 'number') return <span className={v >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{formatMetric(key, v)}</span>;
    if ((key === 'spend' || key === 'g_spend' || key === 'total_spend') && v === 0) return <span className="text-slate-500">{formatMetric(key, v)}</span>;
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
  const anyLoading = loadingKeys.size > 0 || slowBusy.size > 0;
  const shownRevealed = revealed.filter(r => shownSlowKinds.has(r.split(':')[0] as SlowKind) && visible.some(c => c.id === r.split(':')[1])).length;
  const thBase = 'sticky top-0 z-20 bg-slate-900 px-3 py-2.5 whitespace-nowrap shadow-[0_1px_0_0_rgb(51_65_85)]';

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" strokeWidth={2} /><path strokeWidth={2} strokeLinecap="round" d="M20 20l-3.5-3.5" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search clients, offers, owners…"
            className="h-9 bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-7 text-sm text-white placeholder-slate-500 w-64 focus:outline-none focus:border-blue-500" />
          {search && <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-sm" aria-label="Clear search">×</button>}
        </div>
        <DateRangePicker value={range} onChange={setRange} />
        <Select label="Group by" value={groupBy} onChange={setGroupBy}
          options={GROUP_BY_OPTIONS.filter(o => isAdmin || o.key !== 'coach').map(o => ({ value: o.key, label: o.label }))} />
        {isAdmin && (
          <Select label="Coach" value={coachFilter} onChange={setCoachFilter}
            options={[{ value: '', label: 'All coaches' }, ...coachNames.map(n => ({ value: n, label: n }))]} />
        )}
        <div className="relative">
          <button type="button" onClick={() => setPickerOpen(o => !o)}
            className={`h-9 inline-flex items-center gap-1.5 text-sm border rounded-lg px-3 ${pickerOpen ? 'border-blue-500 text-white' : 'border-slate-700 text-slate-200 hover:border-slate-500'}`}>
            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeWidth={2} strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16M9 4v16M15 4v16" /></svg>
            Columns <span className="text-slate-500">{shown.length}</span>
          </button>
          {pickerOpen && <ColumnPicker columns={columns} setColumns={setColumns} isAdmin={isAdmin} onClose={() => setPickerOpen(false)} />}
        </div>
        <button type="button" onClick={() => setCollapsed(allCollapsed ? [] : groups.map(([k]) => k))}
          className="h-9 text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 rounded-lg px-3">
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
        {shownRevealed > 0 && (
          <button type="button" onClick={() => setRevealed([])} title="Hide every per-row number you opened with the eye"
            className="h-9 text-sm text-slate-400 hover:text-white rounded-lg px-2">
            Hide per-row numbers ({shownRevealed})
          </button>
        )}
        {sort && (
          <button type="button" onClick={() => setSort('')} className="h-9 text-sm text-slate-400 hover:text-white rounded-lg px-2">Clear sort</button>
        )}
        <div className="ml-auto text-xs text-slate-500 text-right leading-snug">
          <div>{formatRangeLabel(resolved.since, resolved.until)}</div>
          {info?.meta && <div className={staleMeta ? 'text-amber-300/80' : ''}>Meta data through {info.meta}{info.google ? ` · Google through ${info.google}` : ''}</div>}
        </div>
      </div>

      {/* summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
        <Kpi label="Clients" value={String(summary.clients)} sub={summary.rollups ? `+ ${summary.rollups} rollup${summary.rollups === 1 ? '' : 's'}` : undefined} />
        <Kpi label="Meta spend" value={summary.ready ? money(summary.spend) : null} />
        <Kpi label="Meta leads" value={summary.ready ? num(summary.leads) : null} />
        <Kpi label="Meta CPL" value={summary.ready ? (summary.cpl !== null ? money(summary.cpl) : '—') : null} />
        <Kpi label="Google spend" value={summary.ready ? (summary.anyGoogle ? money(summary.gSpend) : '—') : null} dim={!summary.anyGoogle} />
        <Kpi label="Google leads" value={summary.ready ? (summary.anyGoogle ? num(summary.gLeads, 2) : '—') : null} dim={!summary.anyGoogle}
          sub={summary.anyGoogle && summary.gCpl !== null ? `CPL ${money(summary.gCpl)}` : undefined} />
        <Kpi label="Total spend" value={summary.ready ? money(summary.total) : null} accent />
      </div>
      {error && <p className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">{error}</p>}

      {/* The table scrolls inside its own box (both ways) so the header row and
          the Client column stay pinned while scrolling. */}
      <div className="relative border border-slate-800 rounded-xl overflow-auto max-h-[calc(100vh-250px)] bg-slate-950">
        {anyLoading && <div className="sticky top-0 left-0 z-40 h-0.5 w-full overflow-hidden"><div className="h-full w-1/3 bg-blue-500 animate-[coachload_1.2s_ease-in-out_infinite]" /></div>}
        <table className="w-full text-sm border-separate border-spacing-0">
          <thead className="text-[11px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className={`${thBase} left-0 z-30 text-left min-w-[260px]`}>
                <SortButton label="Client" dir={sortDir('name')} onClick={() => toggleSort('name')} align="left" />
              </th>
              {shown.map(col => (
                <th key={col.key} title={col.help} className={`${thBase} text-${col.align}`}>
                  <SortButton label={col.label} dir={sortDir(col.key)} onClick={() => toggleSort(col.key)} align={col.align}
                    extra={col.cost === 'slow' ? <span className="ml-1 normal-case tracking-normal text-[10px] text-amber-300/80">per row</span> : null} />
                </th>
              ))}
              <th className={`${thBase} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <tr><td colSpan={colSpan} className="px-3 py-10 text-center text-slate-500">No clients match{search ? ` “${search}”` : ''}.</td></tr>}
            {groups.map(([key, cs]) => {
              const color = groupColorFor(key);
              const open = !collapsed.includes(key);
              const opaqueTint = `linear-gradient(${color.tint}, ${color.tint}), rgb(2 6 23)`;
              return (
                <Fragment key={key}>
                  <tr className="cursor-pointer select-none group/gh" onClick={() => toggleGroup(key)}>
                    <td className="p-0 sticky left-0 z-10 border-t border-slate-800" style={{ background: opaqueTint }}>
                      <div className="flex items-stretch">
                        <div className="w-1.5 shrink-0" style={{ backgroundColor: color.bar }} />
                        <div className="flex items-center gap-2 px-3 py-2.5">
                          <svg className={`w-3.5 h-3.5 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                          </svg>
                          <span className="font-semibold text-sm" style={{ color: color.bar }}>{key}</span>
                          <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded-full text-slate-900" style={{ backgroundColor: color.bar }}>{cs.length}</span>
                        </div>
                      </div>
                    </td>
                    {/* collapsed groups still show their totals */}
                    {shown.map(col => (
                      <td key={col.key} className={`px-3 py-2.5 border-t border-slate-800 text-${col.align} font-mono text-xs text-slate-300 whitespace-nowrap`} style={{ background: color.tint }}>
                        {!open && col.kind === 'metric' ? groupTotal(cs, col.key) : ''}
                      </td>
                    ))}
                    <td className="border-t border-slate-800" style={{ background: color.tint }} />
                  </tr>
                  {open && cs.map(c => (
                    <tr key={c.id} className="group/row">
                      <td className="p-0 sticky left-0 z-10 bg-slate-950 group-hover/row:bg-slate-900 border-t border-slate-800/70">
                        <div className="flex items-stretch h-full">
                          <div className="w-1.5 shrink-0" style={{ backgroundColor: color.bar, opacity: 0.6 }} />
                          <div className="px-3 py-2 text-slate-100 flex items-center gap-2 min-w-0">
                            <span className="truncate max-w-[300px]" title={c.name}>{c.name}</span>
                            {c.isRollup && <span className="shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">Rollup</span>}
                          </div>
                        </div>
                      </td>
                      {shown.map(col => (
                        <td key={col.key} className={`px-3 py-2 whitespace-nowrap border-t border-slate-800/70 group-hover/row:bg-slate-900 text-${col.align} ${col.kind === 'metric' ? 'font-mono text-xs text-slate-200 tabular-nums' : 'text-xs text-slate-300'}`}>
                          {cell(c, col.key)}
                        </td>
                      ))}
                      <td className="px-3 py-2 border-t border-slate-800/70 group-hover/row:bg-slate-900"><RowActions client={c} /></td>
                    </tr>
                  ))}
                  {open && shown.some(col => col.kind === 'metric') && (
                    <tr className="text-xs">
                      <td className="sticky left-0 z-10 bg-slate-900 border-t border-slate-700 px-3 py-1.5 pl-6 text-[11px] uppercase tracking-wider text-slate-500">Group total</td>
                      {shown.map(col => (
                        <td key={col.key} className={`bg-slate-900/60 border-t border-slate-700 px-3 py-1.5 text-${col.align} font-mono text-slate-300 whitespace-nowrap`}>{col.kind === 'metric' ? groupTotal(cs, col.key) : ''}</td>
                      ))}
                      <td className="bg-slate-900/60 border-t border-slate-700" />
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-slate-500">
        {columns.includes('leads') && <p>* Meta&apos;s own lead count. This client&apos;s dashboard counts leads from the sheet or GHL, so it can show a different number.</p>}
        {shown.some(c => c.cost === 'slow') && <p>Per-row numbers: click the eye on a row. They stay on when you change dates; click a number to hide it again.</p>}
        <p>Summary excludes rollups (their clubs are already counted).</p>
      </div>
      <style>{`@keyframes coachload { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }`}</style>
    </div>
  );
}

function Kpi({ label, value, sub, accent, dim }: { label: string; value: string | null; sub?: string; accent?: boolean; dim?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${accent ? 'border-blue-500/30 bg-blue-500/5' : 'border-slate-800 bg-slate-900/50'} ${dim ? 'opacity-60' : ''}`}>
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      {value === null
        ? <span className="mt-1.5 inline-block h-5 w-20 rounded bg-slate-800 animate-pulse" />
        : <p className="text-lg font-semibold text-white tabular-nums leading-tight mt-0.5">{value}</p>}
      {sub && <p className="text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function SortButton({ label, dir, onClick, align, extra }: { label: string; dir: string; onClick: () => void; align: string; extra?: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} title="Sort"
      className={`inline-flex items-center gap-1 uppercase tracking-wider hover:text-white ${dir ? 'text-white' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}>
      <span>{label}{extra}</span>
      <span className={`text-[9px] ${dir ? 'text-blue-300' : 'text-slate-600'}`}>{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}</span>
    </button>
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
    <label className="h-9 flex items-center gap-2 text-xs text-slate-400 border border-slate-700 hover:border-slate-500 rounded-lg px-2.5">
      {label}
      <select value={value} onChange={e => onChange(e.target.value)} className="bg-transparent text-sm text-white focus:outline-none cursor-pointer">
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const toggle = (key: string) => setColumns(columns.includes(key) ? columns.filter(k => k !== key) : BOARD_COLUMNS.map(c => c.key).filter(k => k === key || columns.includes(k)));
  const section = (title: string, kind: 'config' | 'metric') => (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">{title}</p>
      {BOARD_COLUMNS.filter(c => c.kind === kind && (isAdmin || c.key !== 'coach')).map(c => (
        <label key={c.key} className="flex items-start gap-2 py-1 px-1 -mx-1 rounded text-sm text-slate-200 cursor-pointer hover:bg-slate-800/60" title={c.help}>
          <input type="checkbox" checked={columns.includes(c.key)} onChange={() => toggle(c.key)} className="mt-0.5 accent-blue-500" />
          <span>{c.label}{c.cost === 'slow' && <span className="ml-1 text-[10px] text-amber-300" title="Not loaded for every row — click the eye on a row to see it">per row</span>}</span>
        </label>
      ))}
    </div>
  );
  return (
    <div ref={ref} className="absolute z-50 mt-2 w-[440px] max-w-[90vw] left-0 sm:left-auto sm:right-0 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4">
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
    <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
      <button type="button" onClick={copy} title="Copy the client's auto-login link"
        className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border ${copyState === 'copied' ? 'border-emerald-500/40 text-emerald-300' : copyState === 'none' || copyState === 'error' ? 'border-amber-500/40 text-amber-300' : 'border-slate-700 text-slate-300 hover:text-white hover:border-slate-500'}`}>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" strokeWidth={2} /><path strokeWidth={2} d="M5 15V5a2 2 0 012-2h10" /></svg>
        {copyState === 'copied' ? 'Copied' : copyState === 'none' ? 'No link yet' : copyState === 'error' ? 'Failed' : 'Link'}
      </button>
      <button type="button" onClick={open} disabled={opening} title="Open this client's dashboard as the client"
        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50">
        {opening ? 'Opening…' : 'Dashboard'}
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5M19 5l-8 8M10 5H6a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-4" /></svg>
      </button>
    </div>
  );
}
