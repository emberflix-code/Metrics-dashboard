'use client';

import { useMemo, useState } from 'react';
import { pairKey, severityRank, type AdsetCircle, type OverlapPair, type OffClubFlag, type Severity } from '@/lib/geoOverlap';
import type { BroadAdset } from '@/lib/marketer/targeting';
import { adsManagerAdsetUrl, fmtInt, fmtKm, fmtMi, fmtUsd } from '../_components/format';

type Tab = 'overlaps' | 'offclub' | 'broad';
type SortKey = 'severity' | 'score' | 'spend' | 'distance';

const PANEL_H = 'max-h-[560px]';

function SeverityPill({ s }: { s: Severity }) {
  const cls = s === 'high'
    ? 'text-red-300 border-red-500/30 bg-red-500/10'
    : s === 'medium'
      ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
      : 'text-slate-300 border-slate-700 bg-slate-800';
  return <span className={`inline-block text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full border ${cls}`}>{s}</span>;
}

function Side({ c }: { c: AdsetCircle }) {
  return (
    <div className="min-w-0 max-w-[220px]">
      <div className="font-medium text-white truncate" title={c.clientName ?? 'Unattributed'}>{c.clientName ?? <span className="text-slate-500">Unattributed</span>}</div>
      <div className="text-slate-400 truncate" title={c.campaignName}>{c.campaignName || '—'}</div>
      <div className="text-slate-300 truncate" title={c.adsetName}>{c.adsetName}</div>
      <div className="text-slate-500 truncate">
        <span className="text-slate-400">{c.offer}</span> · {fmtMi(c.radiusKm)} ({fmtKm(c.radiusKm)}){c.approx ? '~' : ''} · {fmtUsd(c.spend, 0)} · CPL {fmtUsd(c.cpl)}
      </div>
    </div>
  );
}

function SortHeader({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: { key: SortKey; dir: 'asc' | 'desc' }; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort.key === k;
  return (
    <th className={`px-3 py-2 text-left select-none cursor-pointer hover:text-slate-300 ${className ?? ''}`} onClick={() => onSort(k)}>
      {label}{active ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
    </th>
  );
}

export default function OverlapTable({ pairs, offClub, broad, selectedPairKey, onSelectPair }: {
  pairs: OverlapPair[];
  offClub: OffClubFlag[];
  broad: BroadAdset[];
  selectedPairKey: string | null;
  onSelectPair: (key: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('overlaps');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'severity', dir: 'desc' });

  function onSort(k: SortKey) {
    setSort(prev => (prev.key === k ? { key: k, dir: prev.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: k === 'distance' ? 'asc' : 'desc' }));
  }

  const sortedPairs = useMemo(() => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    const cmp: Record<SortKey, (x: OverlapPair, y: OverlapPair) => number> = {
      severity: (x, y) => severityRank(x.severity) - severityRank(y.severity) || x.score - y.score || x.combinedSpend - y.combinedSpend,
      score: (x, y) => x.score - y.score || x.combinedSpend - y.combinedSpend,
      spend: (x, y) => x.combinedSpend - y.combinedSpend || x.score - y.score,
      distance: (x, y) => x.distanceKm - y.distanceKm || y.score - x.score,
    };
    return pairs.slice().sort((x, y) => dir * cmp[sort.key](x, y));
  }, [pairs, sort]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overlaps', label: `Overlaps (${pairs.length})` },
    { key: 'offclub', label: `Off-club (${offClub.length})` },
    { key: 'broad', label: `Broad (${broad.length})` },
  ];

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
      <div className="px-2 pt-2 border-b border-slate-800 flex items-center gap-1">
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs rounded-t-lg border-b-2 transition-colors ${tab === t.key ? 'text-white border-blue-500 bg-slate-800/60' : 'text-slate-400 border-transparent hover:text-white'}`}
          >
            {t.label}
          </button>
        ))}
        {tab === 'overlaps' && <span className="ml-auto text-[11px] text-slate-500 pr-2">click a row to highlight it on the map</span>}
      </div>

      <div className={`${PANEL_H} overflow-auto`}>
        {tab === 'overlaps' && (
          pairs.length === 0 ? (
            <p className="px-4 py-8 text-sm text-slate-500 text-center">No overlapping ad sets at this threshold.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900 z-10">
                <tr className="border-b border-slate-800">
                  <SortHeader label="Sev." k="severity" sort={sort} onSort={onSort} />
                  <th className="px-3 py-2 text-left">A</th>
                  <th className="px-3 py-2 text-left">B</th>
                  <SortHeader label="Dist." k="distance" sort={sort} onSort={onSort} className="text-right" />
                  <SortHeader label="Overlap" k="score" sort={sort} onSort={onSort} className="text-right" />
                  <SortHeader label="Spend" k="spend" sort={sort} onSort={onSort} className="text-right" />
                  <th className="px-3 py-2 text-left">Flags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {sortedPairs.map(p => {
                  const key = pairKey(p);
                  const selected = key === selectedPairKey;
                  return (
                    <tr
                      key={key}
                      onClick={() => onSelectPair(key)}
                      className={`cursor-pointer align-top transition-colors ${selected ? 'bg-blue-500/10' : 'hover:bg-slate-800/40'}`}
                    >
                      <td className="px-3 py-2"><SeverityPill s={p.severity} /></td>
                      <td className="px-3 py-2"><Side c={p.a} /></td>
                      <td className="px-3 py-2"><Side c={p.b} /></td>
                      <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtMi(p.distanceKm)}</td>
                      <td className="px-3 py-2 text-right text-white font-medium whitespace-nowrap">{Math.round(p.score * 100)}%</td>
                      <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtUsd(p.combinedSpend, 0)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-0.5 text-[10px]">
                          {p.sameClient && <span className="text-slate-400">same client</span>}
                          {p.sameCampaign && <span className="text-slate-400">same campaign</span>}
                          {p.sameOffer ? <span className="text-slate-400">same offer</span> : <span className="text-amber-300/80">different offers</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )
        )}

        {tab === 'offclub' && (
          offClub.length === 0 ? (
            <p className="px-4 py-8 text-sm text-slate-500 text-center">Every circle sits on its club.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900 z-10">
                <tr className="border-b border-slate-800">
                  <th className="px-3 py-2 text-left">Ad set</th>
                  <th className="px-3 py-2 text-left">Client</th>
                  <th className="px-3 py-2 text-right">From club</th>
                  <th className="px-3 py-2 text-right">Radius</th>
                  <th className="px-3 py-2 text-right">Spend</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {offClub.map(f => (
                  <tr key={f.adset.circleId} className="align-top hover:bg-slate-800/40">
                    <td className="px-3 py-2 min-w-0">
                      <div className="text-white truncate max-w-[220px]" title={f.adset.adsetName}>{f.adset.adsetName}</div>
                      <div className="text-slate-500 truncate max-w-[220px]" title={f.adset.campaignName}>{f.adset.campaignName}</div>
                      <div className="text-slate-500">{f.adset.kind}{f.adset.approx ? ' (approx.)' : ''}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-300 truncate max-w-[160px]" title={f.adset.clientName ?? ''}>{f.adset.clientName ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-amber-300 whitespace-nowrap">{fmtMi(f.distanceKm)}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtMi(f.adset.radiusKm)}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtUsd(f.adset.spend, 0)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <a href={adsManagerAdsetUrl(f.adset.accountId, f.adset.adsetId)} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200">Ads Manager ↗</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === 'broad' && (
          broad.length === 0 ? (
            <p className="px-4 py-8 text-sm text-slate-500 text-center">No region- or country-level ad sets in range.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900 z-10">
                <tr className="border-b border-slate-800">
                  <th className="px-3 py-2 text-left">Ad set</th>
                  <th className="px-3 py-2 text-left">Campaign</th>
                  <th className="px-3 py-2 text-left">Client</th>
                  <th className="px-3 py-2 text-left">Targets</th>
                  <th className="px-3 py-2 text-right">Spend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {broad.map(b => (
                  <tr key={`${b.accountId}:${b.adsetId}`} className="align-top hover:bg-slate-800/40">
                    <td className="px-3 py-2">
                      <a href={adsManagerAdsetUrl(b.accountId, b.adsetId)} target="_blank" rel="noopener noreferrer" className="text-white hover:text-blue-200 truncate block max-w-[200px]" title={b.adsetName}>{b.adsetName}</a>
                    </td>
                    <td className="px-3 py-2 text-slate-400 truncate max-w-[200px]" title={b.campaignName}>{b.campaignName || '—'}</td>
                    <td className="px-3 py-2 text-slate-300 truncate max-w-[140px]" title={b.clientName ?? ''}>{b.clientName ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-400">{b.kinds.join(', ')}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtUsd(b.spend, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
      {tab === 'overlaps' && pairs.length > 0 && (
        <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-500">
          Overlap % = share of the smaller circle covered by the other. Same-client pairs are demoted one tier. “~” marks an assumed radius. {fmtInt(pairs.length)} pairs.
        </div>
      )}
    </div>
  );
}
