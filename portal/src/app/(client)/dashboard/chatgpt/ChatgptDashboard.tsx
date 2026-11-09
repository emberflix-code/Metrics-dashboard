'use client';

// ChatGPT Ads (OpenAI Ads Manager) view of a client's dashboard, laid out like
// the Meta dashboard: filter bar, KPI cards, Campaigns / Ad Groups / Ads tables
// (Table or Analytics view) and a Creatives tab in the Creatives v3 card style.
// Cache only: /api/chatgpt-ads/daily returns every synced ad-level daily row +
// the entities; date range / delivery / search are applied here. Leads = the
// conversions OpenAI attributes from the account's pixel. Kept separate from
// the Meta / Google totals.
import { useEffect, useMemo, useRef, useState } from 'react';
import Script from 'next/script';
import GlossaryButton from '@/components/GlossaryButton';

interface Row {
  date: string; adId: string; adName: string; adGroupId: string; adGroupName: string; campaignId: string; campaignName: string;
  impressions: number; clicks: number; spend: number; conversions: number;
}
interface Entity {
  id: string; level: 'campaign' | 'ad_group' | 'ad'; name: string; status: string; parentId: string; reviewStatus: string;
  creativeType: string; title: string; body: string; targetUrl: string; hasImage: boolean;
  imageCrop: { x: number; y: number; width: number; height: number } | null;
}
interface Props { clientName: string; hasMeta: boolean; hasGoogleAds: boolean }

type Level = 'campaign' | 'ad_group' | 'ad';
type Tab = Level | 'creatives';
type Preset = 'yesterday' | '7' | '14' | '30' | 'mtd' | 'lastmonth' | 'max' | 'custom';
const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'yesterday', label: 'Yesterday' }, { id: '7', label: 'Last 7 days' }, { id: '14', label: 'Last 14 days' },
  { id: '30', label: 'Last 30 days' }, { id: 'mtd', label: 'This month' }, { id: 'lastmonth', label: 'Last month' }, { id: 'max', label: 'Maximum' },
];

declare global { interface Window { Chart?: new (ctx: CanvasRenderingContext2D, cfg: unknown) => { destroy(): void } } }

// ── formatting ────────────────────────────────────────────────────────────
const addDays = (ymd: string, n: number) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const usd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number | null) => (n === null ? '—' : (n * 100).toFixed(2) + '%');
const opt = (n: number | null, f: (x: number) => string) => (n === null ? '—' : f(n));
const fmtDay = (ymd: string) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function rangeFor(p: Preset, last: string, first: string): [string, string] {
  switch (p) {
    case 'yesterday': return [last, last];
    case '7': return [addDays(last, -6), last];
    case '14': return [addDays(last, -13), last];
    case '30': return [addDays(last, -29), last];
    case 'mtd': return [last.slice(0, 8) + '01', last];
    case 'lastmonth': { const end = addDays(last.slice(0, 8) + '01', -1); return [end.slice(0, 8) + '01', end]; }
    default: return [first, last];
  }
}

interface Totals { spend: number; impressions: number; clicks: number; leads: number; ctr: number | null; cpc: number | null; cpm: number | null; cpl: number | null }
function totals(rows: Row[]): Totals {
  let spend = 0, impressions = 0, clicks = 0, leads = 0;
  for (const r of rows) { spend += r.spend; impressions += r.impressions; clicks += r.clicks; leads += r.conversions; }
  return {
    spend, impressions, clicks, leads,
    ctr: impressions ? clicks / impressions : null,
    cpc: clicks ? spend / clicks : null,
    cpm: impressions ? (spend / impressions) * 1000 : null,
    cpl: leads ? spend / leads : null,
  };
}

// ── icons (lucide paths, inline so React owns the DOM) ────────────────────
const ICONS: Record<string, string> = {
  dollar: '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  pointer: '<path d="m9 9 5 12 1.774-5.226L21 14 9 9z"/><path d="m16.071 16.071 4.243 4.243"/><path d="m7.188 2.239.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656-2.12 2.122"/>',
  percent: '<line x1="19" x2="5" y1="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  table: '<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>',
  chart: '<line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>',
  trend: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
};
function Icon({ name, className = 'w-4 h-4' }: { name: keyof typeof ICONS; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}

const CARD_COLORS: Record<string, string> = {
  emerald: 'from-emerald-500/20 to-emerald-500/5 border-emerald-500/20', indigo: 'from-indigo-500/20 to-indigo-500/5 border-indigo-500/20',
  blue: 'from-blue-500/20 to-blue-500/5 border-blue-500/20', rose: 'from-rose-500/20 to-rose-500/5 border-rose-500/20',
  amber: 'from-amber-500/20 to-amber-500/5 border-amber-500/20', violet: 'from-violet-500/20 to-violet-500/5 border-violet-500/20',
  sky: 'from-sky-500/20 to-sky-500/5 border-sky-500/20', teal: 'from-teal-500/20 to-teal-500/5 border-teal-500/20',
};
const ICON_COLORS: Record<string, string> = {
  emerald: 'text-emerald-400', indigo: 'text-indigo-400', blue: 'text-blue-400', rose: 'text-rose-400',
  amber: 'text-amber-400', violet: 'text-violet-400', sky: 'text-sky-400', teal: 'text-teal-400',
};

function Delivery({ status }: { status: string }) {
  const s = (status || '').toLowerCase();
  const on = s === 'active';
  const label = s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ') : 'Unknown';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${on ? 'text-emerald-300' : 'text-slate-400'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-emerald-400' : 'bg-slate-500'}`} />{label}
    </span>
  );
}

type SortKey = 'name' | 'impressions' | 'cpm' | 'leads' | 'spend' | 'ctr' | 'clicks' | 'cpc' | 'cpl';
const COLS: { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'impressions', label: 'Impressions', right: true }, { key: 'cpm', label: 'CPM', right: true },
  { key: 'leads', label: 'Leads', right: true }, { key: 'spend', label: 'Spent (USD)', right: true },
  { key: 'ctr', label: 'CTR', right: true }, { key: 'clicks', label: 'Clicks', right: true },
  { key: 'cpc', label: 'CPC', right: true }, { key: 'cpl', label: 'CPL', right: true },
];

export default function ChatgptDashboard({ clientName, hasMeta, hasGoogleAds }: Props) {
  const [all, setAll] = useState<Row[] | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [syncedThrough, setSyncedThrough] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [preset, setPreset] = useState<Preset>('30');
  const [custom, setCustom] = useState<[string, string] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [draft, setDraft] = useState<[string, string]>(['', '']);
  const [delivery, setDelivery] = useState<'all' | 'active' | 'paused'>('all');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Tab>('campaign');
  const [view, setView] = useState<'table' | 'analytics'>('table');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'spend', dir: -1 });
  const [chartReady, setChartReady] = useState(false);

  useEffect(() => {
    fetch('/api/chatgpt-ads/daily')
      .then(r => r.json())
      .then(j => {
        if (j.error) throw new Error(j.error);
        setAll(j.rows || []); setEntities(j.entities || []); setSyncedThrough(j.syncedThrough); setTimeZone(j.timeZone);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { if (typeof window !== 'undefined' && window.Chart) setChartReady(true); }, []);

  const firstDay = all && all.length ? all[0].date : null;
  const lastDay = syncedThrough || (all && all.length ? all[all.length - 1].date : null);
  const [since, until] = useMemo<[string, string]>(() => {
    if (!lastDay || !firstDay) return ['', ''];
    if (preset === 'custom' && custom) return custom;
    return rangeFor(preset, lastDay, firstDay);
  }, [preset, custom, lastDay, firstDay]);

  const entById = useMemo(() => new Map(entities.map(e => [e.id, e])), [entities]);
  const statusOf = (id: string) => (entById.get(id)?.status || '').toLowerCase();
  const terms = search.toLowerCase().split(/[,\s]+/).filter(Boolean);

  // Rows in the date range, narrowed by delivery (of the row's entity at the
  // current tab's level) and by the campaign-name search.
  const inRange = useMemo(() => (all || []).filter(r => r.date >= since && r.date <= until), [all, since, until]);
  const filtered = useMemo(() => inRange.filter(r => {
    if (terms.length && !terms.every(t => r.campaignName.toLowerCase().includes(t))) return false;
    if (delivery !== 'all') {
      const id = tab === 'ad_group' ? r.adGroupId : tab === 'campaign' ? r.campaignId : r.adId;
      if (statusOf(id) !== delivery) return false;
    }
    return true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [inRange, delivery, search, tab, entById]);
  const t = totals(filtered);

  // Table rows for the current level
  const tableRows = useMemo(() => {
    const level: Level = tab === 'creatives' ? 'ad' : tab;
    const groups = new Map<string, Row[]>();
    for (const r of filtered) {
      const id = level === 'campaign' ? r.campaignId : level === 'ad_group' ? r.adGroupId : r.adId;
      const a = groups.get(id) ?? []; a.push(r); groups.set(id, a);
    }
    const out = Array.from(groups.entries()).map(([id, rs]) => {
      const last = rs[rs.length - 1];
      const name = level === 'campaign' ? last.campaignName : level === 'ad_group' ? last.adGroupName : last.adName;
      const parent = level === 'ad_group' ? last.campaignName : level === 'ad' ? `${last.adGroupName} · ${last.campaignName}` : '';
      return { id, name: entById.get(id)?.name || name, parent, status: statusOf(id), ...totals(rs) };
    });
    const v = (x: (typeof out)[number]) => (sort.key === 'name' ? x.name.toLowerCase() : sort.key === 'leads' ? x.leads : (x[sort.key] ?? -1));
    return out.sort((a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * sort.dir);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, tab, sort, entById]);

  const byDay = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (let d = since; d && d <= until; d = addDays(d, 1)) m.set(d, []);
    for (const r of filtered) m.get(r.date)?.push(r);
    return Array.from(m.entries()).map(([date, rs]) => ({ date, ...totals(rs) }));
  }, [filtered, since, until]);

  // Creatives: every ad with delivery in the range (Creatives v3 style)
  const creatives = useMemo(() => {
    const groups = new Map<string, Row[]>();
    for (const r of filtered) { const a = groups.get(r.adId) ?? []; a.push(r); groups.set(r.adId, a); }
    return Array.from(groups.entries())
      .map(([id, rs]) => ({ id, ent: entById.get(id), last: rs[rs.length - 1], ...totals(rs) }))
      .filter(c => c.impressions > 0 || c.spend > 0)
      .sort((a, b) => b.spend - a.spend);
  }, [filtered, entById]);

  // Analytics chart (Chart.js, same CDN build as the Meta dashboard)
  const chartRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (view !== 'analytics' || tab === 'creatives' || !chartReady || !chartRef.current || !window.Chart) return;
    const ctx = chartRef.current.getContext('2d');
    if (!ctx) return;
    const font = { size: 10, family: 'DM Sans, sans-serif' }; const color = '#94a3b8'; const grid = 'rgba(148,163,184,0.08)';
    const chart = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels: byDay.map(d => d.date.slice(5)),
        datasets: [
          { label: 'Spend', data: byDay.map(d => +d.spend.toFixed(2)), borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.10)', yAxisID: 'ySpend', tension: 0.35, pointRadius: 2, fill: true },
          { label: 'Clicks', data: byDay.map(d => d.clicks), borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.10)', yAxisID: 'yCount', tension: 0.35, pointRadius: 2 },
          { label: 'Leads', data: byDay.map(d => d.leads), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.10)', yAxisID: 'yCount', tension: 0.35, pointRadius: 2 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color, font, boxWidth: 10 } } },
        scales: {
          x: { ticks: { color, font }, grid: { color: grid } },
          ySpend: { position: 'left', title: { display: true, text: 'Daily Spend', color: '#34d399', font }, ticks: { color: '#34d399', font, callback: (v: number) => '$' + v.toLocaleString() }, grid: { color: grid } },
          yCount: { position: 'right', title: { display: true, text: 'Clicks / Leads', color: '#60a5fa', font }, ticks: { color: '#60a5fa', font }, grid: { drawOnChartArea: false } },
        },
      },
    });
    return () => chart.destroy();
  }, [view, tab, chartReady, byDay]);

  const tzLabel = timeZone === 'America/Chicago' ? 'Central Time' : timeZone || '';
  const presetLabel = preset === 'custom' ? 'Custom' : PRESETS.find(p => p.id === preset)?.label || '';
  const noLeadsYet = t.leads === 0;

  const cards: { label: string; value: string; icon: keyof typeof ICONS; color: string; sub?: string }[] = [
    { label: 'Amount Spent', value: usd(t.spend), icon: 'dollar', color: 'emerald' },
    { label: 'Impressions', value: int(t.impressions), icon: 'eye', color: 'indigo' },
    { label: 'Clicks', value: int(t.clicks), icon: 'pointer', color: 'blue' },
    { label: 'CTR', value: pct(t.ctr), icon: 'percent', color: 'rose' },
    { label: 'CPC', value: opt(t.cpc, usd), icon: 'coins', color: 'sky' },
    { label: 'CPM', value: opt(t.cpm, usd), icon: 'gauge', color: 'teal' },
    { label: 'Leads', value: int(t.leads), icon: 'users', color: 'amber', sub: noLeadsYet ? 'From the ChatGPT pixel' : undefined },
    { label: 'CPL', value: opt(t.cpl, usd), icon: 'receipt', color: 'violet' },
  ];

  const pill = (active: boolean) => `text-xs px-3 py-1 rounded transition-colors ${active ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`;
  const th = 'px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500 whitespace-nowrap select-none cursor-pointer hover:text-slate-300';
  const levelName = tab === 'ad_group' ? 'Ad Group' : tab === 'ad' ? 'Ad' : 'Campaign';
  const sortBy = (key: SortKey) => setSort(s => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === 'name' ? 1 : -1 }));
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : '');

  return (
    <div className="w-full min-h-screen flex flex-col bg-slate-950 text-slate-200" style={{ fontFamily: 'DM Sans, sans-serif' }}>
      <Script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js" strategy="afterInteractive" onLoad={() => setChartReady(true)} />

      {/* Header */}
      <header className="bg-slate-900/80 backdrop-blur-md border-b border-slate-800 sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/gmnlogo.png" alt="Logo" className="w-9 h-9 rounded-lg object-contain" />
            <h1 className="text-lg font-bold text-white tracking-tight">ChatGPT Ads Dashboard</h1>
            <span className="text-[10px] font-mono bg-amber-500/20 text-amber-400 px-2 py-0.5 rounded-full uppercase tracking-wider">{clientName}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400">
              {error ? 'Could not load ChatGPT Ads data' : !all ? 'Loading ChatGPT Ads…' : syncedThrough ? `Data through ${fmtDay(syncedThrough)}${tzLabel ? ` (${tzLabel})` : ''} · updated daily` : 'Not synced yet'}
            </span>
            <div className="flex items-center bg-slate-800/60 rounded-lg p-0.5 border border-slate-700">
              {hasMeta && <a href="/dashboard" className={pill(false)}>Meta</a>}
              {hasGoogleAds && <a href="/dashboard/google" className={pill(false)}>Google Ads</a>}
              <a href="/dashboard/chatgpt" className={pill(true)}>ChatGPT</a>
            </div>
            <GlossaryButton audience="client" onlyOnPage />
          </div>
        </div>
      </header>

      {/* Filter bar */}
      <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 pt-5 pb-2">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1.5 relative">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Date Range</label>
            <button onClick={() => { setDraft([since, until]); setPickerOpen(o => !o); }}
              className="flex items-center gap-2 bg-slate-900 border border-slate-700 hover:border-slate-500 rounded-lg px-3 py-2 text-sm text-white transition-colors whitespace-nowrap">
              <Icon name="calendar" className="w-4 h-4 text-slate-400" />
              <span>{presetLabel}</span>
              <Icon name="chevron" className="w-3.5 h-3.5 text-slate-400 ml-1" />
            </button>
            <span className="text-[10px] text-slate-400 font-mono px-1 h-4 whitespace-nowrap">{since && `${fmtDay(since)} – ${fmtDay(until)}`}</span>
            {pickerOpen && lastDay && firstDay && (
              <div className="absolute left-0 top-full mt-1 z-40 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-3 w-[300px]">
                <div className="grid grid-cols-2 gap-1 mb-3">
                  {PRESETS.map(p => (
                    <button key={p.id} onClick={() => { setPreset(p.id); setCustom(null); setPickerOpen(false); }}
                      className={`text-left text-xs px-2.5 py-1.5 rounded-md ${preset === p.id ? 'bg-blue-600/25 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>{p.label}</button>
                  ))}
                </div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1.5">Custom</div>
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <input type="date" value={draft[0]} min={firstDay} max={lastDay} onChange={e => setDraft([e.target.value, draft[1]])}
                    className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 [color-scheme:dark]" />
                  to
                  <input type="date" value={draft[1]} min={firstDay} max={lastDay} onChange={e => setDraft([draft[0], e.target.value])}
                    className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 [color-scheme:dark]" />
                </div>
                <div className="flex justify-end gap-2 mt-3">
                  <button onClick={() => setPickerOpen(false)} className="text-xs px-3 py-1.5 rounded-lg text-slate-300 hover:bg-slate-800">Cancel</button>
                  <button disabled={!draft[0] || !draft[1] || draft[0] > draft[1]} onClick={() => { setPreset('custom'); setCustom(draft); setPickerOpen(false); }}
                    className="text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-40">Update</button>
                </div>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Delivery</label>
            <div className="relative">
              <select value={delivery} onChange={e => setDelivery(e.target.value as typeof delivery)}
                className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 pr-8 text-sm text-white appearance-none focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer min-w-[150px]">
                <option value="all">All Delivery</option><option value="active">Active</option><option value="paused">Paused</option>
              </select>
              <Icon name="chevron" className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
            </div>
            <span className="h-4 block" />
          </div>
          <div className="flex flex-col gap-1.5 flex-1 min-w-[260px]">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Search Campaigns</label>
            <div className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2">
              <Icon name="search" className="w-4 h-4 text-slate-500" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Enter a name or keyword..."
                className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none" />
            </div>
            <span className="h-4 block" />
          </div>
        </div>
      </div>

      {error && <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6"><div className="rounded-lg border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">{error}</div></div>}
      {all && all.length === 0 && !error && (
        <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6"><div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">No ChatGPT Ads data synced yet. It fills in after the next daily sync.</div></div>
      )}

      {/* Summary cards */}
      <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 py-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
          {cards.map((c, i) => (
            <div key={c.label} className={`bg-gradient-to-br ${CARD_COLORS[c.color]} border rounded-xl px-4 py-3 fade-up fade-up-${Math.min(i + 1, 6)}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{c.label}</span>
                <Icon name={c.icon} className={`w-4 h-4 ${ICON_COLORS[c.color]}`} />
              </div>
              <div className="text-xl font-bold text-white font-mono">{all ? c.value : '…'}</div>
              <div className="mt-1 h-4 text-[11px] text-slate-500">{c.sub || ''}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Main panel */}
      <div className="max-w-[1600px] mx-auto w-full px-4 sm:px-6 pb-6 flex-1">
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
          <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-slate-800">
            {([['campaign', 'Campaigns'], ['ad_group', 'Ad Groups'], ['ad', 'Ads'], ['creatives', 'Creatives']] as [Tab, string][]).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`level-tab px-4 py-2 text-xs font-semibold rounded-t-lg transition-colors${tab === id ? ' active-tab' : ''}`}>{label}</button>
            ))}
            {tab !== 'creatives' && (
              <div className="ml-auto flex items-center gap-2 pb-2">
                <div className="flex items-center gap-0.5 bg-slate-800/60 rounded-lg p-0.5">
                  <button onClick={() => setView('table')} className={`view-btn flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold${view === 'table' ? ' active-view-btn' : ''}`}><Icon name="table" className="w-3 h-3" /> Table</button>
                  <button onClick={() => setView('analytics')} className={`view-btn flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold${view === 'analytics' ? ' active-view-btn' : ''}`}><Icon name="chart" className="w-3 h-3" /> Analytics</button>
                </div>
              </div>
            )}
          </div>

          {tab !== 'creatives' && view === 'table' && (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th onClick={() => sortBy('name')} className={`${th} text-left min-w-[260px]`}>{levelName}{arrow('name')}</th>
                    <th className={`${th} text-left cursor-default hover:text-slate-500`}>Delivery</th>
                    {COLS.map(c => <th key={c.key} onClick={() => sortBy(c.key)} className={`${th} text-right`}>{c.label}{arrow(c.key)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map(r => (
                    <tr key={r.id} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-3">
                        <div className="text-slate-100 font-medium">{r.name}</div>
                        {r.parent && <div className="text-[11px] text-slate-500 mt-0.5">{r.parent}</div>}
                      </td>
                      <td className="px-4 py-3"><Delivery status={r.status} /></td>
                      <td className="px-4 py-3 text-right font-mono text-slate-300">{int(r.impressions)}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-300">{opt(r.cpm, usd)}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-300">{int(r.leads)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-300">{usd(r.spend)}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-300">{pct(r.ctr)}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-300">{int(r.clicks)}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-300">{opt(r.cpc, usd)}</td>
                      <td className="px-4 py-3 text-right font-mono text-violet-300">{opt(r.cpl, usd)}</td>
                    </tr>
                  ))}
                </tbody>
                {tableRows.length > 0 && (
                  <tfoot>
                    <tr className="bg-slate-800/40 font-semibold">
                      <td className="px-4 py-3 text-slate-300 text-xs uppercase tracking-wider">Total ({tableRows.length})</td>
                      <td />
                      <td className="px-4 py-3 text-right font-mono text-white">{int(t.impressions)}</td>
                      <td className="px-4 py-3 text-right font-mono text-white">{opt(t.cpm, usd)}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-300">{int(t.leads)}</td>
                      <td className="px-4 py-3 text-right font-mono text-emerald-300">{usd(t.spend)}</td>
                      <td className="px-4 py-3 text-right font-mono text-white">{pct(t.ctr)}</td>
                      <td className="px-4 py-3 text-right font-mono text-white">{int(t.clicks)}</td>
                      <td className="px-4 py-3 text-right font-mono text-white">{opt(t.cpc, usd)}</td>
                      <td className="px-4 py-3 text-right font-mono text-violet-300">{opt(t.cpl, usd)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
              {all && tableRows.length === 0 && (
                <div className="px-6 py-12 text-center text-slate-500"><p className="font-medium">No {levelName.toLowerCase()}s found</p><p className="text-xs mt-1">Try another date range or adjusting your filters</p></div>
              )}
            </div>
          )}

          {tab !== 'creatives' && view === 'analytics' && (
            <div className="p-5 space-y-4">
              <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-2"><Icon name="trend" className="w-3.5 h-3.5 text-emerald-400" /> Daily Spend, Clicks &amp; Leads</h3>
                  <span className="text-[10px] font-mono text-slate-500">{since && `${fmtDay(since)} – ${fmtDay(until)}`}</span>
                </div>
                {byDay.length > 1
                  ? <div style={{ position: 'relative', height: 260 }}><canvas ref={chartRef} /></div>
                  : <div className="text-center text-slate-500 py-8 text-xs">Select a multi-day date range to see daily trends</div>}
              </div>
            </div>
          )}

          {tab === 'creatives' && (
            <div className="p-5">
              {creatives.length === 0 && all && <div className="text-center text-slate-500 py-10 text-sm">No ads delivered in these dates.</div>}
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {creatives.map((c, i) => {
                  const e = c.ent;
                  const crop = e?.imageCrop;
                  const pos = crop ? `${Math.round((crop.x + crop.width / 2) * 100)}% ${Math.round((crop.y + crop.height / 2) * 100)}%` : 'center';
                  return (
                    <div key={c.id} className={`bg-slate-900/40 border border-slate-800 hover:border-slate-700 rounded-xl overflow-hidden fade-up fade-up-${Math.min(i + 1, 6)} transition-colors`}>
                      <div className="relative aspect-video bg-slate-800 overflow-hidden">
                        {e?.hasImage
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={`/api/chatgpt-ads/image/${encodeURIComponent(c.id)}`} alt="" className="w-full h-full object-cover" style={{ objectPosition: pos }} />
                          : <div className="w-full h-full flex items-center justify-center text-slate-600"><Icon name="image" className="w-8 h-8" /></div>}
                        <div className="absolute top-2 left-2 text-[10px] font-semibold bg-slate-950/80 text-emerald-300 px-1.5 py-0.5 rounded">ChatGPT card</div>
                        <div className="absolute top-2 right-2 bg-slate-950/80 px-1.5 py-0.5 rounded"><Delivery status={e?.status || ''} /></div>
                      </div>
                      <div className="p-3">
                        <div className="mb-2">
                          <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-0.5">Sponsored · {host(e?.targetUrl || '')}</div>
                          <div className="text-sm font-semibold text-white leading-snug">{e?.title || c.last.adName}</div>
                          {e?.body && <div className="text-xs text-slate-300 mt-0.5">{e.body}</div>}
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] mb-2">
                          <div className="text-slate-500">Spend</div><div className="text-right font-mono text-emerald-300">{usd(c.spend)}</div>
                          <div className="text-slate-500">Impressions</div><div className="text-right font-mono text-slate-300">{int(c.impressions)}</div>
                          <div className="text-slate-500">Clicks</div><div className="text-right font-mono text-blue-300">{int(c.clicks)}</div>
                          <div className="text-slate-500">CTR</div><div className="text-right font-mono text-rose-300">{pct(c.ctr)}</div>
                          <div className="text-slate-500">CPC</div><div className="text-right font-mono text-sky-300">{opt(c.cpc, usd)}</div>
                          <div className="text-slate-500">Leads</div><div className="text-right font-mono text-amber-300">{int(c.leads)}</div>
                          <div className="text-slate-500">CPL</div><div className="text-right font-mono text-violet-300">{opt(c.cpl, usd)}</div>
                        </div>
                        <div className="text-[11px] text-slate-500 border-t border-slate-800 pt-2">
                          <div className="truncate" title={c.last.adName}>Ad: {c.last.adName}</div>
                          <div className="truncate" title={c.last.campaignName}>Campaign: {c.last.campaignName}</div>
                          {e?.targetUrl && (
                            <a href={e.targetUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-blue-400 hover:text-blue-300">
                              <Icon name="link" className="w-3 h-3" />{host(e.targetUrl)}
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-500 mt-3">
          ChatGPT Ads numbers are kept separate from the Meta and Google Ads totals. Leads are the conversions ChatGPT&apos;s pixel reports for these ads; they appear once the pixel starts sending them.
        </p>
      </div>
    </div>
  );
}
