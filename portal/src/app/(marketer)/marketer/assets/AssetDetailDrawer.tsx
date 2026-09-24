'use client';

import { useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import type { AssetDetail, AssetKind } from '@/lib/marketer/assetLibrary';
import { adsManagerAdUrl, adsManagerCampaignUrl, fmtInt, fmtPct, fmtUsd } from '../_components/format';
import { Preview } from './AssetLibrary';

// Chart.js is loaded from the CDN (same build the client dashboard uses) and
// attached to window — no npm package, so only the slice we touch is typed.
interface ChartInstance { destroy(): void }
interface TooltipCtx { parsed: { y: number | null }; dataset: { label?: string; yAxisID?: string }; dataIndex: number }
type ChartCtor = new (canvas: HTMLCanvasElement, config: Record<string, unknown>) => ChartInstance;
declare const Chart: ChartCtor;
const hasChartGlobal = () => typeof window !== 'undefined' && typeof (window as unknown as { Chart?: unknown }).Chart !== 'undefined';
const CHART_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';

const KIND_LABEL: Record<AssetKind, string> = { creative: 'Creative', body: 'Primary text', title: 'Headline', description: 'Description' };
const COPY_KIND_LABEL: Record<'body' | 'title' | 'description', string> = { body: 'Primary text', title: 'Headline', description: 'Description' };

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-base font-semibold text-white mt-0.5">{value}</p>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === 'ACTIVE' ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
    : status === 'PAUSED' || status === 'CAMPAIGN_PAUSED' || status === 'ADSET_PAUSED' ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
    : 'text-slate-400 border-slate-700 bg-slate-800';
  return <span className={`text-[10px] px-1.5 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>{status.toLowerCase().replace(/_/g, ' ')}</span>;
}

const thCls = 'text-left px-2 py-1.5 text-[10px] uppercase tracking-wider text-slate-500 font-semibold';
const thNum = `${thCls} text-right`;
const tdCls = 'px-2 py-1.5 text-slate-300 align-top';
const tdNum = `${tdCls} text-right tabular-nums`;

export default function AssetDetailDrawer({ kind, assetKey, range, includeInactive = false, onClose }: {
  kind: AssetKind;
  assetKey: string;
  range: { preset: string; since: string; until: string };
  /** Mirrors the table's "include inactive clients" toggle so the detail resolves the same scope. */
  includeInactive?: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartReady, setChartReady] = useState<boolean>(hasChartGlobal);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<ChartInstance | null>(null);

  // Esc closes; body scroll is locked while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  useEffect(() => {
    const ctrl = new AbortController();
    setData(null);
    setError(null);
    const qs = new URLSearchParams({ preset: range.preset });
    if (range.preset === 'custom') { qs.set('since', range.since); qs.set('until', range.until); }
    if (includeInactive) qs.set('inactive', '1');
    fetch(`/api/marketer/assets/${kind}/${encodeURIComponent(assetKey)}?${qs}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(async r => {
        if (r.status === 404) throw new Error('No data for this asset in the selected range.');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<AssetDetail>;
      })
      .then(setData)
      .catch(err => { if (err?.name !== 'AbortError') setError(err?.message || 'Failed to load'); });
    return () => ctrl.abort();
  }, [kind, assetKey, range.preset, range.since, range.until, includeInactive]);

  // Weekly CPL (left axis) + CTR (right axis). Rebuilt whenever the data or
  // the library arrives; destroyed on unmount so the canvas isn't reused.
  useEffect(() => {
    if (!chartReady || !data || !canvasRef.current || typeof Chart === 'undefined') return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    const weeks = data.weekly;
    if (weeks.length === 0) return;
    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels: weeks.map(w => w.week),
        datasets: [
          { label: 'CPL', data: weeks.map(w => w.cpl), yAxisID: 'y', borderColor: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.15)', tension: 0.3, spanGaps: true, pointRadius: 3 },
          { label: 'CTR %', data: weeks.map(w => w.ctr), yAxisID: 'y1', borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.15)', tension: 0.3, spanGaps: true, pointRadius: 3, borderDash: [4, 3] },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#94a3b8', boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx: TooltipCtx) => {
                const v = ctx.parsed.y;
                if (v === null || v === undefined) return `${ctx.dataset.label}: —`;
                return ctx.dataset.yAxisID === 'y' ? `CPL: ${fmtUsd(v)}` : `CTR: ${fmtPct(v)}`;
              },
              afterBody: (items: TooltipCtx[]) => {
                const w = weeks[items[0]?.dataIndex ?? -1];
                return w ? [`Spend ${fmtUsd(w.spend, 0)} · Leads ${fmtInt(w.results)} · Impr ${fmtInt(w.impressions)}`] : [];
              },
            },
          },
        },
        scales: {
          x: { ticks: { color: '#64748b', maxRotation: 0, autoSkip: true }, grid: { color: 'rgba(148,163,184,0.08)' } },
          y: { position: 'left', ticks: { color: '#60a5fa', callback: (v: number) => fmtUsd(Number(v), 0) }, grid: { color: 'rgba(148,163,184,0.08)' } },
          y1: { position: 'right', ticks: { color: '#34d399', callback: (v: number) => `${Number(v).toFixed(1)}%` }, grid: { drawOnChartArea: false } },
        },
      },
    });
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [chartReady, data]);

  const row = data?.row;
  const isCreative = kind === 'creative';

  return (
    <>
      <Script src={CHART_SRC} strategy="afterInteractive" onLoad={() => setChartReady(true)} onReady={() => setChartReady(true)} />
      <div className="fixed inset-0 z-50 flex justify-end">
        <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
        <aside className="relative h-full w-full max-w-2xl bg-slate-900 border-l border-slate-800 shadow-2xl overflow-y-auto" role="dialog" aria-modal="true">
          <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-800 px-5 py-3 flex items-center gap-3">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-wider text-slate-500">{KIND_LABEL[kind]}</p>
              <p className="text-sm font-mono text-slate-300 truncate" title={assetKey}>{assetKey}</p>
            </div>
            <span className="ml-auto text-xs text-slate-500 font-mono whitespace-nowrap">{range.since} → {range.until}</span>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none px-2" aria-label="Close">✕</button>
          </div>

          <div className="px-5 py-4 space-y-6">
            {error && <p className="text-sm text-red-300 border border-red-500/30 bg-red-500/10 rounded-lg px-3 py-2">{error}</p>}
            {!data && !error && <p className="text-sm text-slate-500">Loading…</p>}

            {data && row && (
              <>
                {/* Hero: preview or full text */}
                <div className="flex gap-4">
                  {isCreative ? (
                    <Preview row={row} size={224} />
                  ) : (
                    <div className="flex-1 bg-slate-800/60 border border-slate-700/60 rounded-lg p-3">
                      <p className="text-sm text-slate-100 whitespace-pre-line">{row.text ?? <span className="font-mono text-slate-500">{row.key}</span>}</p>
                    </div>
                  )}
                  <div className="flex-1 min-w-0 space-y-1 text-xs text-slate-400">
                    {isCreative && <p><span className="text-slate-500">Type</span> {row.type ?? '—'}</p>}
                    {isCreative && <p><span className="text-slate-500">Theme</span> {row.theme ?? '—'} <span className="text-slate-600">·</span> <span className="text-slate-500">UGC</span> {row.ugcStatus ?? '—'}</p>}
                    {!isCreative && row.isStaticOnly && <p className="text-amber-300">Static ads only — metrics are each ad&apos;s own row (no per-variant breakdown).</p>}
                    <p><span className="text-slate-500">Ads</span> <span className="text-emerald-300">{row.activeAdCount} active</span> / {row.adCount}</p>
                    <p><span className="text-slate-500">Campaigns</span> {row.campaignCount} <span className="text-slate-600">·</span> <span className="text-slate-500">Clients</span> {row.clientCount}</p>
                    <p><span className="text-slate-500">Accounts</span> <span className="font-mono">{row.accountIds.join(', ')}</span></p>
                    <p><span className="text-slate-500">Ran</span> {row.firstDate} → {row.lastDate}</p>
                    {row.offers.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {row.offers.map(o => <span key={o} className="text-[11px] px-2 py-0.5 rounded-full border text-blue-300 border-blue-500/30 bg-blue-500/10">{o}</span>)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Metric tiles */}
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  <Tile label="Spend" value={fmtUsd(row.spend)} />
                  <Tile label="Leads" value={fmtInt(row.results)} />
                  <Tile label="CPL" value={fmtUsd(row.cpl)} />
                  <Tile label="CTR" value={fmtPct(row.ctr)} />
                  <Tile label="CPM" value={fmtUsd(row.cpm)} />
                  <Tile label="Impressions" value={fmtInt(row.impressions)} />
                  <Tile label="Reach" value={fmtInt(row.reach)} />
                  <Tile label="Link clicks" value={fmtInt(row.linkClicks)} />
                </div>

                {/* Weekly trend */}
                <Section title="Weekly trend (CPL · CTR)">
                  {data.weekly.length === 0
                    ? <p className="text-xs text-slate-500">No weekly data.</p>
                    : <div className="h-56 bg-slate-800/40 border border-slate-700/60 rounded-lg p-2"><canvas ref={canvasRef} /></div>}
                  {!chartReady && data.weekly.length > 0 && <p className="text-[11px] text-slate-500">Loading chart…</p>}
                </Section>

                {/* By campaign */}
                <Section title={`By campaign (${data.byCampaign.length})`}>
                  <div className="overflow-x-auto border border-slate-800 rounded-lg">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b border-slate-800"><th className={thCls}>Campaign</th><th className={thCls}>Client</th><th className={thCls}>Offer</th><th className={thNum}>Spend</th><th className={thNum}>Leads</th><th className={thNum}>CPL</th></tr></thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {data.byCampaign.map(c => (
                          <tr key={`${c.accountId}:${c.campaignId}`} className="hover:bg-slate-800/30">
                            <td className={tdCls}>
                              {c.campaignId
                                ? <a href={adsManagerCampaignUrl(c.accountId, c.campaignId)} target="_blank" rel="noreferrer" className="text-slate-200 hover:text-blue-300">{c.campaignName || c.campaignId}</a>
                                : <span>{c.campaignName || '—'}</span>}
                            </td>
                            <td className={tdCls}>{c.clientName ?? <span className="text-slate-600">—</span>}</td>
                            <td className={tdCls}>{c.offer}</td>
                            <td className={tdNum}>{fmtUsd(c.spend)}</td>
                            <td className={tdNum}>{fmtInt(c.results)}</td>
                            <td className={`${tdNum} text-white`}>{fmtUsd(c.cpl)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Section title="By client">
                    <table className="w-full text-xs border border-slate-800 rounded-lg overflow-hidden">
                      <thead><tr className="border-b border-slate-800"><th className={thCls}>Client</th><th className={thNum}>Spend</th><th className={thNum}>Leads</th><th className={thNum}>CPL</th></tr></thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {data.byClient.map(c => (
                          <tr key={c.clientId || 'none'}><td className={tdCls}>{c.clientName}</td><td className={tdNum}>{fmtUsd(c.spend)}</td><td className={tdNum}>{fmtInt(c.results)}</td><td className={`${tdNum} text-white`}>{fmtUsd(c.cpl)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </Section>
                  <Section title="By offer">
                    <table className="w-full text-xs border border-slate-800 rounded-lg overflow-hidden">
                      <thead><tr className="border-b border-slate-800"><th className={thCls}>Offer</th><th className={thNum}>Spend</th><th className={thNum}>Leads</th><th className={thNum}>CPL</th></tr></thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {data.byOffer.map(o => (
                          <tr key={o.offer}><td className={tdCls}>{o.offer}</td><td className={tdNum}>{fmtUsd(o.spend)}</td><td className={tdNum}>{fmtInt(o.results)}</td><td className={`${tdNum} text-white`}>{fmtUsd(o.cpl)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </Section>
                </div>

                {/* Paired copy / creatives */}
                {isCreative && data.pairedCopy && (
                  <Section title={`Copy used with this creative (${data.pairedCopy.length})`}>
                    {data.pairedCopy.length === 0 && <p className="text-xs text-slate-500">No copy captured yet for the ads using this asset.</p>}
                    <ul className="space-y-1.5">
                      {data.pairedCopy.map(c => (
                        <li key={`${c.kind}:${c.hash}`} className="flex gap-2 text-xs">
                          <span className="shrink-0 w-24 text-slate-500">{COPY_KIND_LABEL[c.kind]}</span>
                          <span className="text-slate-200 whitespace-pre-line line-clamp-3 flex-1">{c.text}</span>
                          <span className="shrink-0 text-slate-500">{c.adCount} ad{c.adCount === 1 ? '' : 's'}</span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                {!isCreative && data.pairedCreatives && (
                  <Section title={`Creatives used with this copy (${data.pairedCreatives.length})`}>
                    {data.pairedCreatives.length === 0 && <p className="text-xs text-slate-500">No mapped creatives for the ads carrying this copy.</p>}
                    <div className="flex flex-wrap gap-2">
                      {data.pairedCreatives.map(c => (
                        <div key={c.assetKey} className="flex flex-col items-center gap-1" title={c.assetKey}>
                          <Preview row={{ key: c.assetKey, type: c.type, thumbnailUrl: c.thumbnailUrl }} size={80} />
                          <span className="text-[10px] text-slate-500">{c.adCount} ad{c.adCount === 1 ? '' : 's'}</span>
                        </div>
                      ))}
                    </div>
                  </Section>
                )}

                {/* Links + CTAs */}
                {((data.linkUrls && data.linkUrls.length > 0) || (data.ctaTypes && data.ctaTypes.length > 0)) && (
                  <Section title="Destinations">
                    {data.ctaTypes && data.ctaTypes.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {data.ctaTypes.map(c => <span key={c} className="text-[11px] px-2 py-0.5 rounded-full border text-slate-300 border-slate-700 bg-slate-800">{c.replace(/_/g, ' ')}</span>)}
                      </div>
                    )}
                    {data.linkUrls && data.linkUrls.length > 0 && (
                      <ul className="space-y-0.5">
                        {data.linkUrls.map(u => (
                          <li key={u} className="text-xs truncate"><a href={u} target="_blank" rel="noreferrer" className="text-blue-300 hover:text-blue-200">{u}</a></li>
                        ))}
                      </ul>
                    )}
                  </Section>
                )}

                {/* Ads */}
                <Section title={`Ads (${data.ads.length}${data.ads.length >= 200 ? '+' : ''})`}>
                  <div className="overflow-x-auto border border-slate-800 rounded-lg">
                    <table className="w-full text-xs">
                      <thead><tr className="border-b border-slate-800"><th className={thCls}>Ad</th><th className={thCls}>Campaign</th><th className={thCls}>Status</th><th className={thNum}>Spend</th><th className={thNum}>Leads</th></tr></thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {data.ads.map(a => (
                          <tr key={`${a.accountId}:${a.adId}`} className="hover:bg-slate-800/30">
                            <td className={tdCls}>
                              <a href={adsManagerAdUrl(a.accountId, a.adId)} target="_blank" rel="noreferrer" className="text-slate-200 hover:text-blue-300">{a.adName || a.adId}</a>
                              <span className="block font-mono text-[10px] text-slate-600">{a.adId}</span>
                            </td>
                            <td className={`${tdCls} max-w-[220px] truncate`} title={a.campaignName}>{a.campaignName || '—'}</td>
                            <td className={tdCls}><StatusPill status={a.status} /></td>
                            <td className={tdNum}>{fmtUsd(a.spend)}</td>
                            <td className={tdNum}>{fmtInt(a.results)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Section>
              </>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
