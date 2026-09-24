'use client';

import { useMemo, useState } from 'react';
import type { ScorecardRow } from '@/lib/marketer/scorecard';
import { fmtInt, fmtPct, fmtSignedPct, fmtUsd } from './format';

type SortKey = 'name' | 'offer' | 'spend' | 'results' | 'cpl' | 'delta' | 'ctr' | 'active' | 'dataThrough';
type Dir = 'asc' | 'desc';

// Delta-vs-peers pill. Thresholds mirror the CPL spike alert's posture:
// red only once a location is clearly worse than its peers, so the table
// doesn't paint every row.
function DeltaPill({ row }: { row: ScorecardRow }) {
  if (!row.judged || row.cplDeltaPct === null || row.peerCpl === null) {
    return <span className="text-slate-600">—</span>;
  }
  const d = row.cplDeltaPct;
  const cls = d > 25
    ? 'text-red-300 border-red-500/30 bg-red-500/10'
    : d > 10
      ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
      : d < -10
        ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
        : 'text-slate-300 border-slate-700 bg-slate-800';
  const scopeLabel = row.peerScope === 'brand+offer' ? 'brand+offer' : row.peerScope === 'brand' ? 'brand' : 'agency';
  return (
    <span
      className={`inline-block text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}`}
      title={`peer median ${fmtUsd(row.peerCpl)} (${scopeLabel}, n=${row.peerCount})`}
    >
      {fmtSignedPct(d)}
    </span>
  );
}

function MapMark({ row }: { row: ScorecardRow }) {
  if (row.geocoded) return <span className="text-emerald-400" title="Geocoded">●</span>;
  if (row.geocodeError) return <span className="text-red-400" title={`Geocode error: ${row.geocodeError}`}>✕</span>;
  if (!row.hasAddress) return <span className="text-slate-500" title="No address on file">○</span>;
  return <span className="text-amber-400" title="Address present, not geocoded yet">○</span>;
}

function SortHeader({ label, k, sort, onSort, className }: {
  label: string; k: SortKey; sort: { key: SortKey; dir: Dir }; onSort: (k: SortKey) => void; className?: string;
}) {
  const active = sort.key === k;
  return (
    <th className={`px-3 py-2 text-left select-none cursor-pointer hover:text-slate-300 whitespace-nowrap ${className ?? ''}`} onClick={() => onSort(k)}>
      {label}{active ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
    </th>
  );
}

// Null-aware comparator: nulls always sink to the bottom regardless of
// direction so "sort by CPL" never puts the no-data rows first.
function cmpNullable(a: number | null, b: number | null, dir: Dir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return dir === 'desc' ? b - a : a - b;
}

export default function ScorecardTable({ rows, totals, agencyMedianCpl }: {
  rows: ScorecardRow[];
  totals: { spend: number; results: number; impressions: number; clicks: number; cpl: number | null; ctr: number | null };
  agencyMedianCpl: number | null;
}) {
  // Default = the server's order (worst delta first, then unjudged by spend).
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: 'delta', dir: 'desc' });

  function onSort(k: SortKey) {
    setSort(prev => (prev.key === k
      ? { key: k, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key: k, dir: k === 'name' || k === 'offer' ? 'asc' : 'desc' }));
  }

  const sorted = useMemo(() => {
    const { key, dir } = sort;
    const s = dir === 'desc' ? -1 : 1;
    const str = (a: string, b: string) => s * a.localeCompare(b);
    const out = rows.slice();
    out.sort((a, b) => {
      switch (key) {
        case 'name': return str(a.name, b.name);
        case 'offer': return str(a.dominantOffer, b.dominantOffer) || b.spend - a.spend;
        case 'spend': return s * (a.spend - b.spend);
        case 'results': return s * (a.results - b.results) || b.spend - a.spend;
        case 'cpl': return cmpNullable(a.cpl, b.cpl, dir) || b.spend - a.spend;
        case 'ctr': return cmpNullable(a.ctr, b.ctr, dir) || b.spend - a.spend;
        case 'active': return s * ((a.activeCampaigns + a.activeAdsets) - (b.activeCampaigns + b.activeAdsets)) || b.spend - a.spend;
        case 'dataThrough': return cmpNullable(a.dataThrough ? Date.parse(a.dataThrough) : null, b.dataThrough ? Date.parse(b.dataThrough) : null, dir);
        case 'delta':
        default: {
          // Judged rows first in both directions; unjudged fall back to spend.
          if (a.judged !== b.judged) return a.judged ? -1 : 1;
          if (!a.judged) return b.spend - a.spend;
          return cmpNullable(a.cplDeltaPct, b.cplDeltaPct, dir) || b.spend - a.spend;
        }
      }
    });
    return out;
  }, [rows, sort]);

  const judgedCount = rows.filter(r => r.judged).length;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Location scorecard</h2>
        <span className="text-[11px] text-slate-500">
          {rows.length} locations · {judgedCount} judged (≥$100 and ≥3 leads) · agency median CPL {fmtUsd(agencyMedianCpl)}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-slate-500">
            <tr className="border-b border-slate-800">
              <SortHeader label="Location" k="name" sort={sort} onSort={onSort} />
              <SortHeader label="Offer" k="offer" sort={sort} onSort={onSort} />
              <SortHeader label="Spend" k="spend" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader label="Leads" k="results" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader label="CPL" k="cpl" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader label="vs peers" k="delta" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader label="CTR" k="ctr" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader label="Active" k="active" sort={sort} onSort={onSort} className="text-right" />
              <SortHeader label="Data through" k="dataThrough" sort={sort} onSort={onSort} />
              <th className="px-3 py-2 text-center">Map</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {sorted.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-8 text-center text-sm text-slate-500">No locations match these filters.</td></tr>
            )}
            {sorted.map(r => {
              const muted = !r.judged;
              const extra = r.offers.length - 1;
              return (
                <tr key={r.clientId} className={`align-top hover:bg-slate-800/40 ${muted ? 'text-slate-500' : 'text-slate-300'}`}>
                  <td className="px-3 py-2 min-w-[200px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <a href={`/marketer/assets?client=${encodeURIComponent(r.clientId)}`} className={`font-medium hover:text-blue-200 ${muted ? 'text-slate-400' : 'text-white'}`} title="Open this location's assets">
                        {r.name}
                      </a>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-700 bg-slate-800 text-slate-300">{r.brand}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                      <span className="truncate">{r.coach || 'no coach'}</span>
                      <a href={`/marketer/targeting?client=${encodeURIComponent(r.clientId)}`} className="text-blue-300/80 hover:text-blue-200">targeting</a>
                    </div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {r.dominantOffer}
                    {extra > 0 && <span className="text-slate-500" title={r.offers.slice(1).join(', ')}> +{extra}</span>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtUsd(r.spend, 0)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtInt(r.results)}</td>
                  <td className={`px-3 py-2 text-right whitespace-nowrap font-medium ${muted ? '' : 'text-white'}`}>{fmtUsd(r.cpl)}</td>
                  <td className="px-3 py-2 text-right"><DeltaPill row={r} /></td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtPct(r.ctr)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap" title="active campaigns / active ad sets">{r.activeCampaigns} / {r.activeAdsets}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="font-mono">{r.dataThrough ?? '—'}</span>
                    {r.syncStale && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full border text-amber-300 border-amber-500/30 bg-amber-500/10">stale</span>}
                  </td>
                  <td className="px-3 py-2 text-center"><MapMark row={r} /></td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot className="border-t border-slate-700 text-slate-200 font-medium">
              <tr>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtUsd(totals.spend, 0)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtInt(totals.results)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtUsd(totals.cpl)}</td>
                <td className="px-3 py-2"></td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{fmtPct(totals.ctr)}</td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
