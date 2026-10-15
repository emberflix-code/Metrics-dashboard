'use client';

// "Enhanced" view of the GMN Marketing Report (beta, toggled on the page; the Classic view is untouched).
// Everything here is derived from the same published snapshot as the Classic view — no new data, so every number
// still matches the audited report. Charts are plain SVG (no chart library).
// Colors: dark-mode reference palette (validated on the #2C2A29 surface): categorical blue / orange / aqua (+ gray
// "Other"), diverging blue (better than the network) <-> red (worse) with a neutral gray midpoint, status colors only
// with an icon + label, brand yellow for emphasis (never a series).
import { useMemo, useState, type ReactNode } from 'react';
import type { GmnCopyItem, GmnCreative, GmnMetricRow, GmnReportPayload } from '@/lib/gmnReport';
import { fmtInt, fmtPct, fmtUsd } from '@/app/(marketer)/marketer/_components/format';

const C = {
  blue: '#3987e5', orange: '#d95926', aqua: '#199e70', gray: '#6b6a66', neutral: '#383835',
  red: '#e66767', good: '#0ca30c', warning: '#fab219', critical: '#d03b3b', accent: '#E1E000',
  grid: 'rgba(255,255,255,0.08)', axis: 'rgba(255,255,255,0.35)', text2: '#c3c2b7',
};
const SERIES = [C.blue, C.orange, C.aqua];

type Metric = 'cpl' | 'cpb' | 'bookRate' | 'ctr';
const METRICS: Record<Metric, { label: string; better: 'low' | 'high'; fmt: (n: number | null) => string; of: (r: GmnMetricRow) => number | null }> = {
  cpl: { label: 'CPL', better: 'low', fmt: n => fmtUsd(n), of: r => r.cpl },
  cpb: { label: 'CPB', better: 'low', fmt: n => fmtUsd(n), of: r => r.cpb },
  bookRate: { label: 'Booking rate', better: 'high', fmt: n => fmtPct(n), of: r => (r.leads && r.bookings != null ? (r.bookings / r.leads) * 100 : null) },
  ctr: { label: 'CTR', better: 'high', fmt: n => fmtPct(n), of: r => r.ctr },
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const short = (label: string) => label.replace(/^Alloy (personal training|Personal Training)\s*-?\s*/i, '').replace(/^Alloy\s+/, '');

// Brand kits for the Enhanced view's header. Alloy: their yellow-on-transparent logo (public/brand/alloy-logo.png,
// from alloypersonaltraining.com), Alloy yellow #E1E000 on black/charcoal, bold condensed uppercase type (their site
// uses United Sans Semi Condensed; Oswald is the free stand-in, falling back to a system condensed face).
export const BRANDS = {
  alloy: { logo: '/brand/alloy-logo.png', name: 'Alloy Personal Training', tagline: 'Stronger Together' },
} as const;
export type BrandKey = keyof typeof BRANDS;
const BRAND_FONT = "'Oswald', 'Arial Narrow', 'Roboto Condensed', sans-serif";
export const BRAND_FONT_STACK = BRAND_FONT;
export const BRAND_LOGOS: Record<BrandKey, string> = { alloy: BRANDS.alloy.logo };

export default function EnhancedView({ report, brand, onOpenLocation, onOpenOffer, onOpenCopy, renderCreatives }: {
  report: GmnReportPayload;
  brand?: BrandKey;
  onOpenLocation?: (label: string) => void;
  onOpenOffer?: (label: string) => void;
  onOpenCopy?: (item: GmnCopyItem, kind: CopyKind) => void;
  renderCreatives: (cs: GmnCreative[]) => ReactNode;
}) {
  const T = report.locationsTotal;
  const bookRate = T.leads && T.bookings != null ? (T.bookings / T.leads) * 100 : null;
  return (
    <div className="space-y-12 gmn-enhanced">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap" />
      <style>{`.gmn-enhanced h3, .gmn-enhanced .brand-type { font-family: ${BRAND_FONT}; text-transform: uppercase; letter-spacing: 0.04em; }`}</style>
      {brand && <BrandHeader brand={brand} report={report} />}
      <Hero report={report} bookRate={bookRate} />
      <Spotlights report={report} onOpenLocation={onOpenLocation} />
      <HeatTable rows={report.locations} total={T} month={report.month} onOpenLocation={onOpenLocation} />
      <Leaderboard rows={report.locations} total={T} onOpenLocation={onOpenLocation} />
      <OfferMix report={report} onOpenOffer={onOpenOffer} />
      <CreativeShowcase creatives={report.topCreatives} note={report.creativesNote} renderCreatives={renderCreatives} />
      <WinningWords headlines={report.topHeadlines ?? []} adCopy={report.topAdCopy ?? []} note={report.copyNote} onOpenCopy={onOpenCopy} />
      <EfficiencyMap rows={report.locations} onOpenLocation={onOpenLocation} />
    </div>
  );
}

function BrandHeader({ brand, report }: { brand: BrandKey; report: GmnReportPayload }) {
  const b = BRANDS[brand];
  return (
    <section className="relative overflow-hidden rounded-2xl bg-black border border-[#E1E000]/30">
      {/* angled yellow planes echoing the logo mark */}
      <div aria-hidden className="absolute -right-24 -top-24 w-80 h-80 rotate-45 bg-[#E1E000]/10" />
      <div aria-hidden className="absolute -right-40 top-10 w-80 h-80 rotate-45 bg-[#E1E000]/5" />
      <div className="relative flex flex-col sm:flex-row items-start sm:items-center gap-6 p-6 sm:p-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={b.logo} alt={b.name} className="h-20 sm:h-24 w-auto" />
        <div>
          <p className="brand-type text-[#E1E000] text-sm tracking-[0.3em]">{b.tagline}</p>
          <h2 className="brand-type text-3xl sm:text-5xl font-bold leading-none mt-1" style={{ fontFamily: BRAND_FONT }}>Local Marketing Report</h2>
          <p className="brand-type text-slate-300 text-lg mt-2" style={{ fontFamily: BRAND_FONT }}>{report.monthLabel} · {report.overview.totalLocations} locations</p>
        </div>
      </div>
      <div className="relative h-1.5 bg-gradient-to-r from-[#E1E000] via-[#E1E000]/60 to-transparent" aria-hidden />
    </section>
  );
}

function SectionTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
      <div>
        <h3 className="text-xl font-light">{title}</h3>
        {sub && <p className="text-xs text-slate-400 mt-1 max-w-3xl">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

// ---------- 1. hero numbers ----------
function Hero({ report, bookRate }: { report: GmnReportPayload; bookRate: number | null }) {
  const T = report.locationsTotal;
  const big: [string, string, string][] = [
    ['Ad spend', fmtUsd(T.spend), `${fmtInt(report.overview.totalLocations)} locations · avg ${fmtUsd(report.overview.avgLocationSpend)}`],
    ['Leads', fmtInt(T.leads), `CPL ${fmtUsd(T.cpl)}`],
    ['Bookings', fmtInt(T.bookings), `CPB ${fmtUsd(T.cpb)}`],
  ];
  const small: [string, string][] = [
    ['Lead → booking', fmtPct(bookRate)], ['CTR', fmtPct(T.ctr)], ['Link clicks', fmtInt(T.linkClicks)],
    ['Impressions', fmtInt(T.impressions)], ['Cost / click', fmtUsd(T.linkClicks ? T.spend / T.linkClicks : null)],
    ['CPM', fmtUsd(T.impressions ? (T.spend / T.impressions) * 1000 : null)],
  ];
  return (
    <section className="rounded-2xl border border-white/10 bg-gradient-to-br from-black/40 via-black/20 to-[#4F5124]/40 p-6 sm:p-8">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {big.map(([l, v, s]) => (
          <div key={l}>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{l}</p>
            <p className="text-4xl sm:text-5xl font-semibold mt-2 tabular-nums" style={{ color: l === 'Leads' ? C.accent : undefined }}>{v}</p>
            <p className="text-sm text-slate-400 mt-1">{s}</p>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 mt-8">
        {small.map(([l, v]) => (
          <div key={l} className="bg-black/25 rounded-xl px-4 py-3 border border-white/5">
            <p className="text-[11px] uppercase tracking-wider text-slate-500">{l}</p>
            <p className="text-lg font-semibold mt-0.5 tabular-nums">{v}</p>
          </div>
        ))}
      </div>
      <Funnel report={report} />
    </section>
  );
}

// impressions -> clicks -> leads -> bookings, bar widths on a log-ish scale so all four stay visible
function Funnel({ report }: { report: GmnReportPayload }) {
  const T = report.locationsTotal;
  const steps: [string, number, string][] = [
    ['Impressions', T.impressions, ''],
    ['Link clicks', T.linkClicks, `${fmtPct(T.ctr)} of impressions`],
    ['Leads', T.leads ?? 0, T.linkClicks ? `${fmtPct(((T.leads ?? 0) / T.linkClicks) * 100)} of clicks` : ''],
    ['Bookings', T.bookings ?? 0, T.leads ? `${fmtPct(((T.bookings ?? 0) / T.leads) * 100)} of leads` : ''],
  ];
  const max = Math.log10(Math.max(1, steps[0][1]));
  return (
    <div className="mt-8 space-y-2" aria-label="Funnel from impressions to bookings">
      {steps.map(([l, v, s]) => (
        <div key={l} className="flex items-center gap-3 text-sm">
          <span className="w-24 text-slate-400 shrink-0">{l}</span>
          <div className="flex-1 h-6 bg-black/20 rounded-md overflow-hidden">
            <div className="h-full rounded-r-md" style={{ width: `${Math.max(4, (Math.log10(Math.max(1, v)) / max) * 100)}%`, background: l === 'Bookings' ? C.accent : C.blue, opacity: l === 'Bookings' ? 0.9 : 0.75 }} />
          </div>
          <span className="w-24 text-right tabular-nums font-semibold">{fmtInt(v)}</span>
          <span className="w-40 text-xs text-slate-500 hidden sm:block">{s}</span>
        </div>
      ))}
      <p className="text-[11px] text-slate-500">Bar lengths use a log scale so every stage stays visible.</p>
    </div>
  );
}

// ---------- 2. spotlights (rule-based callouts) ----------
function Spotlights({ report, onOpenLocation }: { report: GmnReportPayload; onOpenLocation?: (l: string) => void }) {
  const cards = useMemo(() => {
    const L = report.locations.filter(r => r.spend > 0);
    const out: { tone: 'good' | 'warning' | 'info'; icon: string; title: string; value: string; who: string; detail: string; link?: string }[] = [];
    const pick = <T,>(xs: T[], f: (x: T) => number, dir: 1 | -1) => xs.reduce((b, x) => (b === undefined || dir * (f(x) - f(b)) < 0 ? x : b), undefined as T | undefined);
    const bestCpl = pick(L.filter(r => r.spend >= 500 && r.cpl != null), r => r.cpl!, 1);
    if (bestCpl) out.push({ tone: 'good', icon: '▲', title: 'Most efficient location', value: fmtUsd(bestCpl.cpl), who: short(bestCpl.label), detail: `CPL on ${fmtUsd(bestCpl.spend)} spend · ${fmtInt(bestCpl.leads)} leads`, link: bestCpl.label });
    const vol = pick(L.filter(r => r.leads != null), r => r.leads!, -1);
    if (vol) out.push({ tone: 'info', icon: '◆', title: 'Lead volume leader', value: `${fmtInt(vol.leads)} leads`, who: short(vol.label), detail: `${fmtUsd(vol.spend)} spend · CPL ${fmtUsd(vol.cpl)}`, link: vol.label });
    const br = pick(L.filter(r => (r.leads ?? 0) >= 20 && r.bookings != null), r => r.bookings! / r.leads!, -1);
    if (br) out.push({ tone: 'good', icon: '▲', title: 'Best lead → booking rate', value: fmtPct((br.bookings! / br.leads!) * 100), who: short(br.label), detail: `${fmtInt(br.bookings)} bookings from ${fmtInt(br.leads)} leads`, link: br.label });
    const worst = pick(L.filter(r => r.spend >= 1000 && r.cpl != null), r => r.cpl!, -1);
    if (worst) out.push({ tone: 'warning', icon: '!', title: 'Highest CPL at $1k+ spend', value: fmtUsd(worst.cpl), who: short(worst.label), detail: `${fmtUsd(worst.spend)} spend for ${fmtInt(worst.leads)} leads — worth a creative/offer review`, link: worst.label });
    const offers = report.offers.filter(o => (o.leads ?? 0) >= 20 && o.cpb != null);
    const bo = pick(offers, o => o.cpb!, 1);
    if (bo) out.push({ tone: 'good', icon: '▲', title: 'Best offer by cost per booking', value: fmtUsd(bo.cpb), who: bo.label, detail: `${fmtInt(bo.bookings)} bookings · CPL ${fmtUsd(bo.cpl)}` });
    const tc = report.topCreatives[0];
    if (tc) out.push({ tone: 'info', icon: '★', title: 'Top creative', value: fmtUsd(tc.cpl), who: `Creative #${tc.rank} · ${tc.type === 'video' ? 'Video' : 'Image'}`, detail: `CPL across ${tc.locations.length} locations · ${fmtUsd(tc.spend)} spend` });
    return out;
  }, [report]);
  const toneCls = { good: 'text-[#0ca30c]', warning: 'text-[#fab219]', info: 'text-[#E1E000]' } as const;
  const toneLabel = { good: 'Strong', warning: 'Watch', info: 'Highlight' } as const;
  return (
    <section>
      <SectionTitle title="Spotlights" sub="Automatic callouts from this month's numbers. Click a location callout to open its report." />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map(c => {
          const body = (
            <>
              <p className={`text-[11px] font-semibold uppercase tracking-wider ${toneCls[c.tone]}`}><span aria-hidden>{c.icon}</span> {toneLabel[c.tone]} · {c.title}</p>
              <p className="text-3xl font-semibold mt-2 tabular-nums">{c.value}</p>
              <p className="text-sm mt-1">{c.who}</p>
              <p className="text-xs text-slate-400 mt-1">{c.detail}</p>
            </>
          );
          return c.link && onOpenLocation ? (
            <button key={c.title} type="button" onClick={() => onOpenLocation(c.link!)} className="text-left bg-black/25 border border-white/10 hover:border-[#E1E000]/60 rounded-xl p-5 transition-colors">{body}</button>
          ) : (
            <div key={c.title} className="bg-black/25 border border-white/10 rounded-xl p-5">{body}</div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- 3. efficiency map: spend (x) vs CPL (y), bubble = leads, split at the medians ----------
function EfficiencyMap({ rows, onOpenLocation }: { rows: GmnMetricRow[]; onOpenLocation?: (l: string) => void }) {
  const [hover, setHover] = useState<GmnMetricRow | null>(null);
  const pts = rows.filter(r => r.spend > 0 && r.cpl != null && r.leads);
  const W = 900, H = 460, P = { l: 60, r: 20, t: 20, b: 44 };
  const maxX = Math.max(...pts.map(r => r.spend)) * 1.05, maxY = Math.max(...pts.map(r => r.cpl!)) * 1.08;
  const x = (v: number) => P.l + (v / maxX) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / maxY) * (H - P.t - P.b);
  const maxLeads = Math.max(...pts.map(r => r.leads!));
  const rad = (l: number) => 5 + Math.sqrt(l / maxLeads) * 16;
  const mx = median(pts.map(r => r.spend)), my = median(pts.map(r => r.cpl!));
  const ticks = (max: number, n: number) => Array.from({ length: n + 1 }, (_, i) => (max / n) * i);
  const labelled = new Set([...pts].sort((a, b) => b.leads! - a.leads!).slice(0, 3).map(r => r.label));
  const quad = (r: GmnMetricRow) => (r.cpl! <= my ? (r.spend >= mx ? 'Stars: high spend, low CPL' : 'Room to scale: low spend, low CPL') : (r.spend >= mx ? 'Fix first: high spend, high CPL' : 'Watch: low spend, high CPL'));
  return (
    <section>
      <SectionTitle title="Efficiency map" sub="Each bubble is a location: further right = more spend, lower = cheaper leads, bigger = more leads. The dashed lines are the network medians, splitting locations into four groups." />
      <div className="relative bg-black/20 border border-white/10 rounded-xl p-3">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Spend versus CPL by location">
          {ticks(maxX, 5).map(t => <line key={'gx' + t} x1={x(t)} x2={x(t)} y1={P.t} y2={H - P.b} stroke={C.grid} />)}
          {ticks(maxY, 5).map(t => (
            <g key={'gy' + t}>
              <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke={C.grid} />
              <text x={P.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill={C.text2}>{fmtUsd(t, 0)}</text>
            </g>
          ))}
          {ticks(maxX, 5).map(t => <text key={'tx' + t} x={x(t)} y={H - P.b + 18} textAnchor="middle" fontSize="11" fill={C.text2}>{fmtUsd(t, 0)}</text>)}
          <text x={(W + P.l) / 2} y={H - 6} textAnchor="middle" fontSize="12" fill={C.text2}>Spend</text>
          <text x={14} y={(H - P.b) / 2} textAnchor="middle" fontSize="12" fill={C.text2} transform={`rotate(-90 14 ${(H - P.b) / 2})`}>CPL</text>
          <line x1={x(mx)} x2={x(mx)} y1={P.t} y2={H - P.b} stroke={C.axis} strokeDasharray="5 5" />
          <line x1={P.l} x2={W - P.r} y1={y(my)} y2={y(my)} stroke={C.axis} strokeDasharray="5 5" />
          <text x={W - P.r - 6} y={y(my) - 6} textAnchor="end" fontSize="11" fill={C.text2}>median CPL {fmtUsd(my)}</text>
          <text x={W - P.r - 6} y={P.t + 14} textAnchor="end" fontSize="12" fill={C.red}>Fix first</text>
          <text x={W - P.r - 6} y={H - P.b - 8} textAnchor="end" fontSize="12" fill={C.blue}>Stars</text>
          <text x={P.l + 6} y={H - P.b - 8} fontSize="12" fill={C.blue}>Room to scale</text>
          <text x={P.l + 6} y={P.t + 14} fontSize="12" fill={C.red}>Watch</text>
          {[...pts].sort((a, b) => b.leads! - a.leads!).map(r => {
            const good = r.cpl! <= my;
            return (
              <g key={r.label} onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(h => (h === r ? null : h))} onClick={() => onOpenLocation?.(r.label)} style={{ cursor: onOpenLocation ? 'pointer' : 'default' }}>
                <circle cx={x(r.spend)} cy={y(r.cpl!)} r={rad(r.leads!) + 6} fill="transparent" />
                <circle cx={x(r.spend)} cy={y(r.cpl!)} r={rad(r.leads!)} fill={good ? C.blue : C.red} fillOpacity={hover && hover !== r ? 0.25 : 0.7} stroke="#2C2A29" strokeWidth={2} />
                {labelled.has(r.label) && <text x={x(r.spend)} y={y(r.cpl!) - rad(r.leads!) - 6} textAnchor="middle" fontSize="11" fill="#f0efec">{short(r.label)}</text>}
              </g>
            );
          })}
        </svg>
        {hover && (
          <div className="pointer-events-none absolute top-3 right-3 bg-[#1F1E1D] border border-white/20 rounded-lg px-3 py-2 text-xs shadow-xl">
            <p className="font-semibold text-sm">{short(hover.label)}</p>
            <p className="text-slate-400">{quad(hover)}</p>
            <p className="mt-1 tabular-nums">Spend {fmtUsd(hover.spend)} · Leads {fmtInt(hover.leads)} · CPL {fmtUsd(hover.cpl)}</p>
            <p className="tabular-nums">Bookings {fmtInt(hover.bookings)} · CPB {fmtUsd(hover.cpb)}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-slate-400 mt-2 px-2">
          <span><span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: C.blue }} />CPL at or below the median</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-full mr-1.5 align-middle" style={{ background: C.red }} />CPL above the median</span>
          <span>Bubble size = leads</span>
        </div>
      </div>
    </section>
  );
}

// ---------- 4. leaderboard with a metric switch ----------
function Leaderboard({ rows, total, onOpenLocation }: { rows: GmnMetricRow[]; total: GmnMetricRow; onOpenLocation?: (l: string) => void }) {
  const [metric, setMetric] = useState<Metric>('cpl');
  const [hover, setHover] = useState<string | null>(null);
  const M = METRICS[metric];
  const data = rows.map(r => ({ r, v: M.of(r) })).filter(d => d.v != null && d.r.spend > 0) as { r: GmnMetricRow; v: number }[];
  data.sort((a, b) => (M.better === 'low' ? a.v - b.v : b.v - a.v));
  const avg = M.of(total);
  const max = Math.max(...data.map(d => d.v), avg ?? 0) * 1.05;
  return (
    <section>
      <SectionTitle
        title="Location leaderboard"
        sub={`Ranked best to worst by ${M.label}. Blue = better than the network (${M.fmt(avg)}), red = worse. Click a bar to open the location.`}
        right={
          <div className="flex bg-black/30 border border-white/10 rounded-lg p-0.5" role="tablist" aria-label="Metric">
            {(Object.keys(METRICS) as Metric[]).map(k => (
              <button key={k} type="button" role="tab" aria-selected={metric === k} onClick={() => setMetric(k)}
                className={`text-xs px-3 py-1.5 rounded-md transition-colors ${metric === k ? 'bg-[#E1E000] text-black font-semibold' : 'text-slate-300 hover:text-white'}`}>{METRICS[k].label}</button>
            ))}
          </div>
        }
      />
      <div className="bg-black/20 border border-white/10 rounded-xl p-4 space-y-1">
        {data.map(({ r, v }, i) => {
          const better = avg == null ? true : M.better === 'low' ? v <= avg : v >= avg;
          return (
            <button key={r.label} type="button" onClick={() => onOpenLocation?.(r.label)} onMouseEnter={() => setHover(r.label)} onMouseLeave={() => setHover(null)}
              className="w-full flex items-center gap-3 text-xs text-left group">
              <span className="w-6 text-right text-slate-500 tabular-nums">{i + 1}</span>
              <span className={`w-48 sm:w-64 truncate ${hover === r.label ? 'text-[#E1E000]' : 'text-slate-300'}`}>{short(r.label)}</span>
              <span className="flex-1 relative h-4">
                {avg != null && <span className="absolute top-[-3px] bottom-[-3px] w-px bg-white/40" style={{ left: `${(avg / max) * 100}%` }} />}
                <span className="absolute left-0 top-0 h-4 rounded-r" style={{ width: `${Math.max(1, (v / max) * 100)}%`, background: better ? C.blue : C.red, opacity: hover && hover !== r.label ? 0.4 : 0.85 }} />
              </span>
              <span className="w-20 text-right tabular-nums font-semibold">{M.fmt(v)}</span>
            </button>
          );
        })}
        <p className="text-[11px] text-slate-500 pt-2">The thin vertical line marks the network figure. Locations without that metric (e.g. no bookings data) are left out.</p>
      </div>
    </section>
  );
}

// ---------- 5. offer mix ----------
function OfferMix({ report, onOpenOffer }: { report: GmnReportPayload; onOpenOffer?: (l: string) => void }) {
  const offers = [...report.offers].sort((a, b) => b.spend - a.spend);
  const top = offers.slice(0, 3);
  const rest = offers.slice(3);
  const total = report.offersTotal.spend || 1;
  const segs = [
    ...top.map((o, i) => ({ label: o.label, spend: o.spend, color: SERIES[i] })),
    ...(rest.length ? [{ label: `Other (${rest.length} offers)`, spend: rest.reduce((s, o) => s + o.spend, 0), color: C.gray }] : []),
  ];
  const bestCpl = Math.max(...offers.map(o => o.cpl ?? 0));
  return (
    <section>
      <SectionTitle title="Offer mix" sub="Where the budget went by offer, and what each offer cost per lead and per booking. Click an offer to see the locations that ran it." />
      <div className="bg-black/20 border border-white/10 rounded-xl p-5 space-y-6">
        <div>
          <div className="flex h-9 rounded-lg overflow-hidden gap-[2px] bg-[#2C2A29]" role="img" aria-label="Spend share by offer">
            {segs.map(s => (
              <div key={s.label} title={`${s.label}: ${fmtUsd(s.spend)} (${fmtPct((s.spend / total) * 100)})`} style={{ width: `${(s.spend / total) * 100}%`, background: s.color }} className="min-w-[3px]" />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-xs">
            {segs.map(s => (
              <span key={s.label} className="text-slate-300">
                <span className="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-middle" style={{ background: s.color }} />
                {s.label} <span className="text-slate-500 tabular-nums">{fmtPct((s.spend / total) * 100)}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[640px]">
            <thead>
              <tr className="text-slate-400 text-left">
                <th className="py-1.5 font-medium">Offer</th>
                <th className="py-1.5 font-medium text-right">Spend</th>
                <th className="py-1.5 font-medium text-right">Leads</th>
                <th className="py-1.5 font-medium pl-4 w-[30%]">CPL</th>
                <th className="py-1.5 font-medium text-right">Bookings</th>
                <th className="py-1.5 font-medium text-right">CPB</th>
              </tr>
            </thead>
            <tbody>
              {offers.map(o => (
                <tr key={o.label} className="border-t border-white/5">
                  <td className="py-1.5 pr-2">
                    {onOpenOffer ? <button type="button" onClick={() => onOpenOffer(o.label)} className="text-left hover:text-[#E1E000] underline decoration-white/20 underline-offset-2">{o.label}</button> : o.label}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{fmtUsd(o.spend)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtInt(o.leads)}</td>
                  <td className="py-1.5 pl-4">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2.5 bg-black/30 rounded">
                        <div className="h-2.5 rounded-r" style={{ width: `${o.cpl ? (o.cpl / bestCpl) * 100 : 0}%`, background: C.blue, opacity: 0.85 }} />
                      </div>
                      <span className="w-16 text-right tabular-nums">{fmtUsd(o.cpl)}</span>
                    </div>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{fmtInt(o.bookings)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtUsd(o.cpb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[11px] text-slate-500 mt-2">Small offers (few leads) swing a lot month to month — read their CPL with care.</p>
        </div>
      </div>
    </section>
  );
}

// ---------- 6. creatives: equal-size cards grouped Images / Videos (ranks kept) ----------
function CreativeShowcase({ creatives, note, renderCreatives }: { creatives: GmnCreative[]; note?: string; renderCreatives: (cs: GmnCreative[]) => ReactNode }) {
  if (!creatives.length) return null;
  return (
    <section>
      <SectionTitle title="Creative hall of fame" sub={note} />
      {renderCreatives(creatives)}
    </section>
  );
}

// ---------- 6b. winning words: top headlines + top ad copy ----------
export type CopyKind = 'headline' | 'adcopy';

// Copy text with the "{City}" / "{Coach}" placeholders (each location's own city / coach name) shown as yellow chips.
export function CopyText({ text }: { text: string }) {
  const parts = text.split(/(\{City\}|\{Coach\})/);
  return (
    <>
      {parts.map((p, i) => (p === '{City}' || p === '{Coach}')
        ? <span key={i} className="inline-block bg-[#E1E000]/15 text-[#E1E000] rounded px-1 text-[0.9em] font-semibold not-italic">{p.slice(1, -1)}</span>
        : <span key={i}>{p}</span>)}
    </>
  );
}

function WinningWords({ headlines, adCopy, note, onOpenCopy }: {
  headlines: GmnCopyItem[]; adCopy: GmnCopyItem[]; note?: string; onOpenCopy?: (item: GmnCopyItem, kind: CopyKind) => void;
}) {
  if (!headlines.length && !adCopy.length) return null;
  return (
    <section>
      <SectionTitle title="Winning words" sub={note} />
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6 items-start">
        <CopyList title="Top headlines" items={headlines} kind="headline" onOpenCopy={onOpenCopy} className="xl:col-span-2" />
        <CopyList title="Top ad copy" items={adCopy} kind="adcopy" onOpenCopy={onOpenCopy} className="xl:col-span-3" />
      </div>
    </section>
  );
}

function CopyList({ title, items, kind, onOpenCopy, className = '' }: {
  title: string; items: GmnCopyItem[]; kind: CopyKind; onOpenCopy?: (item: GmnCopyItem, kind: CopyKind) => void; className?: string;
}) {
  const best = Math.min(...items.map(i => i.cpl ?? Infinity));
  return (
    <div className={`bg-black/25 border border-white/10 rounded-2xl p-5 ${className}`}>
      <p className="brand-type text-sm font-semibold text-[#E1E000] mb-4">{title}</p>
      {!items.length && <p className="text-sm text-slate-400">None reached $300 spend with a lead this month.</p>}
      <ol className="space-y-3">
        {items.map(it => {
          const body = (
            <div className="flex gap-4">
              <span className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${it.rank === 1 ? 'bg-[#E1E000] text-black' : 'bg-white/10 text-slate-200'}`}>{it.rank}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-4">
                  <p className={kind === 'headline'
                    ? 'text-base font-semibold text-white break-words'
                    : 'text-sm text-slate-200 whitespace-pre-line line-clamp-3 break-words'}>
                    <CopyText text={it.text} />
                  </p>
                  <div className="shrink-0 text-right">
                    <p className="text-lg font-semibold tabular-nums leading-none">{fmtUsd(it.cpl)}</p>
                    <p className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">CPL</p>
                  </div>
                </div>
                <div className="mt-2 h-1.5 bg-black/30 rounded">
                  <div className="h-1.5 rounded-r" style={{ width: `${it.cpl ? (best / it.cpl) * 100 : 0}%`, background: it.rank === 1 ? C.accent : C.blue, opacity: 0.85 }} />
                </div>
                <p className="text-xs text-slate-400 mt-1.5 tabular-nums">
                  {fmtUsd(it.spend)} spend · {fmtInt(it.leads)} leads · CTR {fmtPct(it.ctr)} · {it.locations.length} location{it.locations.length === 1 ? '' : 's'}
                </p>
              </div>
            </div>
          );
          return (
            <li key={it.rank}>
              {onOpenCopy
                ? <button type="button" onClick={() => onOpenCopy(it, kind)} className="w-full text-left rounded-xl p-3 -m-1 hover:bg-white/5 border border-transparent hover:border-[#E1E000]/40 transition-colors">{body}</button>
                : <div className="p-3 -m-1">{body}</div>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---------- 7. heat table: sortable, searchable, CSV ----------
type Col = { key: keyof GmnMetricRow | 'bookRate'; label: string; fmt: (r: GmnMetricRow) => string; val: (r: GmnMetricRow) => number | null; heat?: 'low' | 'high' };
const HCOLS: Col[] = [
  { key: 'spend', label: 'Spend', fmt: r => fmtUsd(r.spend), val: r => r.spend },
  { key: 'reach', label: 'Reach', fmt: r => fmtInt(r.reach), val: r => r.reach },
  { key: 'impressions', label: 'Impr.', fmt: r => fmtInt(r.impressions), val: r => r.impressions },
  { key: 'linkClicks', label: 'Clicks', fmt: r => fmtInt(r.linkClicks), val: r => r.linkClicks },
  { key: 'ctr', label: 'CTR', fmt: r => fmtPct(r.ctr), val: r => r.ctr, heat: 'high' },
  { key: 'leads', label: 'Leads', fmt: r => fmtInt(r.leads), val: r => r.leads },
  { key: 'cpl', label: 'CPL', fmt: r => fmtUsd(r.cpl), val: r => r.cpl, heat: 'low' },
  { key: 'bookings', label: 'Bookings', fmt: r => fmtInt(r.bookings), val: r => r.bookings },
  { key: 'cpb', label: 'CPB', fmt: r => fmtUsd(r.cpb), val: r => r.cpb, heat: 'low' },
  { key: 'bookRate', label: 'Book rate', fmt: r => fmtPct(METRICS.bookRate.of(r)), val: r => METRICS.bookRate.of(r), heat: 'high' },
];

function HeatTable({ rows, total, month, onOpenLocation }: { rows: GmnMetricRow[]; total: GmnMetricRow; month: string; onOpenLocation?: (l: string) => void }) {
  const [sort, setSort] = useState<{ key: Col['key'] | 'label'; dir: 1 | -1 }>({ key: 'spend', dir: -1 });
  const [q, setQ] = useState('');
  const meds = useMemo(() => Object.fromEntries(HCOLS.filter(c => c.heat).map(c => {
    const xs = rows.map(c.val).filter((v): v is number => v != null);
    return [c.key, { med: median(xs), min: Math.min(...xs), max: Math.max(...xs) }];
  })), [rows]);
  const shown = rows.filter(r => r.label.toLowerCase().includes(q.toLowerCase())).sort((a, b) => {
    if (sort.key === 'label') return sort.dir * a.label.localeCompare(b.label);
    const col = HCOLS.find(c => c.key === sort.key)!;
    return sort.dir * ((col.val(a) ?? -Infinity) - (col.val(b) ?? -Infinity));
  });
  // diverging shade around the median: blue = better, red = worse, gray-neutral near the median
  const shade = (c: Col, v: number | null) => {
    if (!c.heat || v == null) return undefined;
    const m = meds[c.key as string];
    const worse = c.heat === 'low' ? v > m.med : v < m.med;
    const span = worse ? (c.heat === 'low' ? m.max - m.med : m.med - m.min) : (c.heat === 'low' ? m.med - m.min : m.max - m.med);
    const t = span ? Math.min(1, Math.abs(v - m.med) / span) : 0;
    const rgb = worse ? '230,103,103' : '57,135,229';
    return `rgba(${rgb},${(0.12 + 0.5 * t).toFixed(2)})`;
  };
  const csv = () => {
    const head = ['Location', ...HCOLS.map(c => c.label)];
    const lines = [...shown, { ...total, label: 'Total' }].map(r => [r.label, ...HCOLS.map(c => c.val(r) ?? '')].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([[head.join(','), ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gmn-report-${month}-locations.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const th = (key: Col['key'] | 'label', label: string, right = true) => (
    <th className={`px-3 py-2 font-semibold whitespace-nowrap cursor-pointer select-none ${right ? 'text-right' : 'text-left'}`}
      onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'label' ? 1 : -1 }))}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  );
  return (
    <section>
      <SectionTitle
        title="All locations"
        sub="Sort by any column, search, or download. CTR, CPL, CPB and booking rate are shaded against the network median: blue = better, red = worse."
        right={
          <div className="flex items-center gap-2">
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search locations" className="bg-black/30 border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white placeholder:text-slate-500 w-48" />
            <button type="button" onClick={csv} className="text-sm border border-white/20 hover:border-[#E1E000] rounded-lg px-3 py-1.5">Download CSV</button>
          </div>
        }
      />
      <div className="overflow-auto max-h-[640px] rounded-xl border border-white/15">
        <table className="w-full text-sm border-collapse min-w-[1000px]">
          <thead className="sticky top-0 bg-[#1F1E1D] z-10">
            <tr>{th('label', 'Location', false)}{HCOLS.map(c => th(c.key, c.label))}</tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.label} className="border-t border-white/5 hover:bg-white/5">
                <td className="px-3 py-1.5">
                  {onOpenLocation ? <button type="button" onClick={() => onOpenLocation(r.label)} className="text-left hover:text-[#E1E000]">{short(r.label)}</button> : short(r.label)}
                </td>
                {HCOLS.map(c => <td key={c.key} className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap" style={{ background: shade(c, c.val(r)) }}>{c.fmt(r)}</td>)}
              </tr>
            ))}
            <tr className="border-t border-white/30 bg-[#1F1E1D] font-semibold sticky bottom-0">
              <td className="px-3 py-2 text-[#E1E000]">Total</td>
              {HCOLS.map(c => <td key={c.key} className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{c.fmt(total)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
