'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import type { MatrixCell, OfferMatrix } from '@/lib/marketer/offerMatrix';
import { fmtInt, fmtUsd } from '../_components/format';

const inputCls = 'bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500';

// Five quantile buckets over the judged CPLs on screen. Quantiles (not a
// fixed dollar scale) because CPL ranges differ wildly by brand and the
// goal is "which cells stand out in THIS view", low CPL = good.
const BUCKET_CLS = [
  'bg-emerald-500/25 text-emerald-100',
  'bg-emerald-500/10 text-emerald-200',
  'bg-amber-500/10 text-amber-100',
  'bg-amber-500/25 text-amber-100',
  'bg-red-500/25 text-red-100',
];

function buildScale(cpls: number[]): (cpl: number) => number {
  const sorted = cpls.slice().sort((a, b) => a - b);
  if (sorted.length === 0) return () => 2;
  const cuts = [0.2, 0.4, 0.6, 0.8].map(q => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return (cpl: number) => {
    let i = 0;
    while (i < cuts.length && cpl > cuts[i]) i++;
    return i;
  };
}

function Cell({ cell, href, bucket }: { cell: MatrixCell | undefined; href: string | null; bucket: number | null }) {
  if (!cell || cell.spend <= 0) {
    return <td className="px-2 py-1.5 text-center text-slate-700">·</td>;
  }
  const inner = cell.judged && cell.cpl !== null ? (
    <>
      <div className="font-semibold text-sm leading-tight">{fmtUsd(cell.cpl)}</div>
      <div className="text-[10px] opacity-80 leading-tight">{fmtUsd(cell.spend, 0)} · {fmtInt(cell.results)}</div>
    </>
  ) : (
    // Below the $100 / 3-lead sample: show only spend so nobody reads a
    // CPL off two leads.
    <>
      <div className="text-sm leading-tight text-slate-500">{fmtUsd(cell.spend, 0)}</div>
      <div className="text-[10px] leading-tight text-slate-600">{fmtInt(cell.results)} lead{cell.results === 1 ? '' : 's'}</div>
    </>
  );
  const bg = cell.judged && bucket !== null ? BUCKET_CLS[bucket] : 'bg-slate-800/40';
  const title = `${cell.campaigns} campaign${cell.campaigns === 1 ? '' : 's'} · ${fmtUsd(cell.spend, 0)} · ${fmtInt(cell.results)} leads${cell.judged ? '' : ' · below minimum sample'}`;
  return (
    <td className="p-0.5">
      {href ? (
        <a href={href} title={title} className={`block rounded-md px-2 py-1.5 text-right hover:ring-1 hover:ring-blue-400/60 ${bg}`}>{inner}</a>
      ) : (
        <div title={title} className={`rounded-md px-2 py-1.5 text-right ${bg}`}>{inner}</div>
      )}
    </td>
  );
}

export default function OfferMatrixView({ matrix, brands, current }: {
  matrix: OfferMatrix;
  brands: string[];
  current: { brand: string; groupBy: 'client' | 'brand'; minSpend: number };
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

  const scale = useMemo(() => {
    const cpls: number[] = [];
    for (const r of matrix.rows) for (const c of Object.values(r.cells)) if (c.judged && c.cpl !== null) cpls.push(c.cpl);
    return buildScale(cpls);
  }, [matrix.rows]);

  const footerTotal = useMemo(() => {
    const t = { spend: 0, results: 0 };
    for (const o of matrix.offers) { t.spend += o.spend; t.results += o.results; }
    return { ...t, cpl: t.results > 0 ? t.spend / t.results : null };
  }, [matrix.offers]);

  const cellHref = (clientId: string | null, token: string) =>
    clientId ? `/marketer/assets?kind=creative&client=${encodeURIComponent(clientId)}&offer=${encodeURIComponent(token)}` : null;

  return (
    <div className="space-y-4">
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Rows</label>
          <div className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
            {(['client', 'brand'] as const).map(g => (
              <button
                key={g}
                type="button"
                onClick={() => navigate(p => setOrDelete(p, 'groupBy', g === 'client' ? '' : g))}
                className={`px-3 py-2 text-sm transition-colors ${current.groupBy === g ? 'bg-slate-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}
              >
                {g === 'client' ? 'Per location' : 'Per brand'}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Brand</label>
          <select value={current.brand} onChange={e => navigate(p => setOrDelete(p, 'brand', e.target.value))} className={inputCls}>
            <option value="">All brands</option>
            {brands.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">Min. row spend</label>
          <select value={String(current.minSpend)} onChange={e => navigate(p => setOrDelete(p, 'minSpend', e.target.value === '0' ? '' : e.target.value))} className={inputCls}>
            {[0, 100, 500, 1000, 5000].map(v => <option key={v} value={String(v)}>{v === 0 ? 'Any' : `≥ ${fmtUsd(v, 0)}`}</option>)}
            {![0, 100, 500, 1000, 5000].includes(current.minSpend) && <option value={String(current.minSpend)}>{`≥ ${fmtUsd(current.minSpend, 0)}`}</option>}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-500 pb-2">
          <span>CPL</span>
          {BUCKET_CLS.map((c, i) => <span key={i} className={`inline-block w-5 h-3 rounded-sm ${c.split(' ')[0]}`} />)}
          <span>low → high (quantiles of judged cells)</span>
        </div>
      </div>

      {matrix.rows.length === 0 || matrix.offers.length === 0 ? (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-10 text-center text-sm text-slate-500">
          No attributed campaign spend in this range for these filters.
        </div>
      ) : (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="text-xs border-separate border-spacing-0 min-w-full">
              <thead>
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-900 text-left px-3 py-2 text-[10px] uppercase tracking-wider text-slate-500 border-b border-r border-slate-800 min-w-[220px]">
                    {matrix.groupBy === 'brand' ? 'Brand' : 'Location'}
                  </th>
                  {matrix.offers.map(o => (
                    <th key={o.token} className="px-2 py-2 text-right align-bottom border-b border-slate-800 min-w-[104px]">
                      <div className="text-white font-semibold whitespace-nowrap" title={o.token}>{o.token}</div>
                      <div className="text-[10px] font-normal text-slate-500 whitespace-nowrap" title="Median of judged per-location CPLs">med {fmtUsd(o.medianCpl)}</div>
                      <div className="text-[10px] font-normal text-slate-600 whitespace-nowrap">{o.clients} client{o.clients === 1 ? '' : 's'}</div>
                    </th>
                  ))}
                  <th className="px-2 py-2 text-right align-bottom border-b border-l border-slate-800 min-w-[104px]">
                    <div className="text-slate-300 font-semibold">All offers</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map(r => {
                  const rowHref = r.clientId ? `/marketer/assets?client=${encodeURIComponent(r.clientId)}` : null;
                  return (
                    <tr key={r.key} className="hover:bg-slate-800/20">
                      <td className="sticky left-0 z-10 bg-slate-900 px-3 py-1.5 border-b border-r border-slate-800/60 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {rowHref ? (
                            <a href={rowHref} className="text-white hover:text-blue-200 font-medium truncate max-w-[180px]" title={r.label}>{r.label}</a>
                          ) : (
                            <span className="text-white font-medium truncate max-w-[180px]" title={r.label}>{r.label}</span>
                          )}
                          {matrix.groupBy === 'client' && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-700 bg-slate-800 text-slate-300">{r.brand}</span>
                          )}
                        </div>
                      </td>
                      {matrix.offers.map(o => {
                        const cell = r.cells[o.token];
                        const bucket = cell && cell.judged && cell.cpl !== null ? scale(cell.cpl) : null;
                        return <Cell key={o.token} cell={cell} href={cellHref(r.clientId, o.token)} bucket={bucket} />;
                      })}
                      <td className="px-2 py-1.5 text-right border-l border-slate-800 whitespace-nowrap">
                        <div className={`font-semibold text-sm leading-tight ${r.total.judged ? 'text-white' : 'text-slate-500'}`}>{r.total.judged ? fmtUsd(r.total.cpl) : '—'}</div>
                        <div className="text-[10px] text-slate-500 leading-tight">{fmtUsd(r.total.spend, 0)} · {fmtInt(r.total.results)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="text-slate-200">
                  <td className="sticky left-0 z-10 bg-slate-900 px-3 py-2 border-t border-r border-slate-700 font-medium">Per offer</td>
                  {matrix.offers.map(o => (
                    <td key={o.token} className="px-2 py-2 text-right border-t border-slate-700 whitespace-nowrap">
                      <div className="font-semibold text-sm leading-tight">{fmtUsd(o.cpl)}</div>
                      <div className="text-[10px] text-slate-500 leading-tight">{fmtUsd(o.spend, 0)} · {fmtInt(o.results)}</div>
                      <div className="text-[10px] text-slate-600 leading-tight">median {fmtUsd(o.medianCpl)}</div>
                    </td>
                  ))}
                  <td className="px-2 py-2 text-right border-t border-l border-slate-700 whitespace-nowrap">
                    <div className="font-semibold text-sm leading-tight">{fmtUsd(footerTotal.cpl)}</div>
                    <div className="text-[10px] text-slate-500 leading-tight">{fmtUsd(footerTotal.spend, 0)} · {fmtInt(footerTotal.results)}</div>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-500">
            Cell = CPL over spend · leads for that offer. Greyed cells are below the $100 / 3-lead minimum and show spend only. Column medians are over judged per-location cells regardless of row grouping.
            {matrix.groupBy === 'client' ? ' Click a cell to open that location’s creatives for the offer.' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
