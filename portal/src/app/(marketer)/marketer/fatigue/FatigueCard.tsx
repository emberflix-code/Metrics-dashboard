'use client';

import { useState } from 'react';
import type { FatigueRow } from '@/lib/marketer/fatigue';
import { fmtInt, fmtPct, fmtUsd } from '../_components/format';

const REASON_LABEL: Record<FatigueRow['reasons'][number], { label: string; cls: string }> = {
  ctr_decline: { label: 'CTR declining', cls: 'text-red-300 border-red-500/30 bg-red-500/10' },
  high_frequency: { label: 'High frequency', cls: 'text-amber-300 border-amber-500/30 bg-amber-500/10' },
};

// Four weekly CTR bars, pure CSS. Heights are relative to the best week
// so the decline reads at a glance; the last bar is highlighted because
// that's the week the rule fires on.
function CtrBars({ weeks }: { weeks: FatigueRow['weeks'] }) {
  const max = Math.max(0, ...weeks.map(w => w.ctr ?? 0));
  return (
    <div className="flex items-end gap-1 h-10" aria-label="Weekly CTR">
      {weeks.map((w, i) => {
        const h = w.ctr !== null && max > 0 ? Math.max(4, Math.round((w.ctr / max) * 100)) : 0;
        const last = i === weeks.length - 1;
        return (
          <div key={w.week} className="flex-1 flex flex-col items-center justify-end h-full" title={`wk of ${w.week}: CTR ${fmtPct(w.ctr)} · ${fmtUsd(w.spend, 0)} · ${fmtInt(w.results)} leads · CPL ${fmtUsd(w.cpl)}`}>
            {w.ctr === null ? (
              <div className="w-full h-px bg-slate-700" />
            ) : (
              <div className={`w-full rounded-sm ${last ? 'bg-red-400/80' : 'bg-slate-500/70'}`} style={{ height: `${h}%` }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function FatigueCard({ row }: { row: FatigueRow }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = !!row.thumbnailUrl && !thumbFailed;
  const assetsHref = `/marketer/assets?kind=creative&q=${encodeURIComponent(row.assetKey)}`;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
      <a href={assetsHref} className="block relative aspect-video bg-slate-800 border-b border-slate-800" title="Open in Assets">
        {showThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={row.thumbnailUrl!} alt="" loading="lazy" onError={() => setThumbFailed(true)} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-600 text-xs">
            {row.type === 'video' ? 'video · no preview' : 'no preview'}
          </div>
        )}
        <span className="absolute top-2 left-2 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-slate-700 bg-slate-900/80 text-slate-300">{row.type ?? 'asset'}</span>
      </a>

      <div className="p-3 space-y-2 flex-1 flex flex-col">
        <div className="flex flex-wrap gap-1">
          {row.reasons.map(r => (
            <span key={r} className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full border ${REASON_LABEL[r].cls}`}>{REASON_LABEL[r].label}</span>
          ))}
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Spend</div><div className="text-white font-medium">{fmtUsd(row.spend, 0)}</div></div>
          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Leads</div><div className="text-white font-medium">{fmtInt(row.results)} <span className="text-slate-500 font-normal">· {fmtUsd(row.results > 0 ? row.spend / row.results : null)}</span></div></div>
          <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Frequency</div><div className={`font-medium ${row.reasons.includes('high_frequency') ? 'text-amber-300' : 'text-white'}`}>{row.frequency === null ? '—' : row.frequency.toFixed(1)}</div></div>
        </div>

        <div>
          <div className="flex items-baseline justify-between text-[10px] text-slate-500 mb-1">
            <span>CTR, last 4 weeks</span>
            <span>
              best {fmtPct(row.bestCtr)} → last <span className={row.reasons.includes('ctr_decline') ? 'text-red-300' : 'text-slate-300'}>{fmtPct(row.lastCtr)}</span>
              {row.ctrDropPct !== null && <span className="text-slate-500"> (−{Math.round(row.ctrDropPct)}%)</span>}
            </span>
          </div>
          <CtrBars weeks={row.weeks} />
        </div>

        <div className="mt-auto pt-1 flex items-start justify-between gap-2 text-[11px]">
          <div className="min-w-0 text-slate-400 truncate" title={row.clients.join(', ')}>
            {row.clients.length === 0 ? <span className="text-slate-600">unattributed</span> : row.clients.length <= 2 ? row.clients.join(', ') : `${row.clients.slice(0, 2).join(', ')} +${row.clients.length - 2}`}
          </div>
          <div className="shrink-0 whitespace-nowrap">
            <span className={row.activeAds > 0 ? 'text-slate-300' : 'text-slate-600'}>{row.activeAds} active ad{row.activeAds === 1 ? '' : 's'}</span>
            <span className="text-slate-700"> · </span>
            <a href={assetsHref} className="text-blue-300 hover:text-blue-200">Assets →</a>
          </div>
        </div>
      </div>
    </div>
  );
}
