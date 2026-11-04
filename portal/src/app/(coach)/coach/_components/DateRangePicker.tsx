'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  COACH_RANGE_PRESETS, MIN_DAY, boardYesterday, formatRangeLabel, parseDay, fmtDay, resolveBoardRange,
} from '@/lib/coach/dateRange';

// Same picker as the client dashboard: presets on the left, two months side
// by side, click a start day then an end day, Update applies. Today and
// future days can't be picked (data is complete only after the day ends).

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function DateRangePicker({ value, onChange }: { value: string; onChange: (spec: string) => void }) {
  const current = resolveBoardRange(value) || resolveBoardRange('last_7d')!;
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 h-9 rounded-lg border border-slate-700 bg-slate-900 hover:border-slate-500 px-3 text-sm text-white">
        <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" strokeWidth={2} /><path strokeWidth={2} strokeLinecap="round" d="M3 10h18M8 3v4M16 3v4" />
        </svg>
        <span className="font-medium">{current.preset === 'custom' ? 'Custom' : current.label}</span>
        <span className="text-slate-400 text-xs hidden sm:inline">{formatRangeLabel(current.since, current.until)}</span>
        <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && <PickerModal initial={current} onClose={() => setOpen(false)} onApply={spec => { setOpen(false); if (spec !== value) onChange(spec); }} />}
    </>
  );
}

function PickerModal({ initial, onClose, onApply }: {
  initial: { preset: string; since: string; until: string };
  onClose: () => void;
  onApply: (spec: string) => void;
}) {
  const yesterday = useMemo(() => boardYesterday(), []);
  const [preset, setPreset] = useState(initial.preset);
  const [since, setSince] = useState(initial.since);
  const [until, setUntil] = useState(initial.until);
  const [selecting, setSelecting] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  // Left calendar = month before the range end, so the end month shows on the right.
  const [left, setLeft] = useState(() => {
    const d = parseDay(initial.until);
    return d.getUTCMonth() === 0 ? { y: d.getUTCFullYear() - 1, m: 11 } : { y: d.getUTCFullYear(), m: d.getUTCMonth() - 1 };
  });
  const right = left.m === 11 ? { y: left.y + 1, m: 0 } : { y: left.y, m: left.m + 1 };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function pickPreset(key: string) {
    const r = resolveBoardRange(key);
    if (!r) return;
    setPreset(key); setSince(r.since); setUntil(r.until); setSelecting(false); setHover(null);
    const d = parseDay(r.until);
    setLeft(d.getUTCMonth() === 0 ? { y: d.getUTCFullYear() - 1, m: 11 } : { y: d.getUTCFullYear(), m: d.getUTCMonth() - 1 });
  }

  function clickDay(ds: string) {
    if (!selecting) { setSince(ds); setUntil(ds); setSelecting(true); setPreset('custom'); return; }
    if (ds < since) { setUntil(since); setSince(ds); } else setUntil(ds);
    setSelecting(false); setHover(null);
  }

  function apply() {
    if (selecting) { onApply(`custom:${since}:${since}`); return; }
    onApply(preset === 'custom' ? `custom:${since}:${until}` : preset);
  }

  const shift = (n: number) => setLeft(l => { const t = l.y * 12 + l.m + n; return { y: Math.floor(t / 12), m: t % 12 }; });
  const minY = Number(MIN_DAY.slice(0, 4));
  const maxY = Number(yesterday.slice(0, 4));
  const years = Array.from({ length: maxY - minY + 2 }, (_, i) => minY + i);

  // Range shown while choosing the end day follows the mouse.
  const lo = selecting && hover ? (hover < since ? hover : since) : since;
  const hi = selecting && hover ? (hover < since ? since : hover) : until;

  function month(y: number, m: number, onPick: (y: number, m: number) => void) {
    const first = new Date(Date.UTC(y, m, 1));
    const daysIn = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells: (string | null)[] = [...Array(first.getUTCDay()).fill(null)];
    for (let d = 1; d <= daysIn; d++) cells.push(fmtDay(new Date(Date.UTC(y, m, d))));
    return (
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-center gap-1 mb-2">
          <select value={m} onChange={e => onPick(y, Number(e.target.value))} className="bg-transparent text-sm font-semibold text-white focus:outline-none cursor-pointer">
            {MONTHS.map((n, i) => <option key={n} value={i} className="bg-slate-900">{n}</option>)}
          </select>
          <select value={y} onChange={e => onPick(Number(e.target.value), m)} className="bg-transparent text-sm font-semibold text-white focus:outline-none cursor-pointer">
            {years.map(yy => <option key={yy} value={yy} className="bg-slate-900">{yy}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-7 text-[10px] uppercase tracking-wider text-slate-500 mb-1">
          {DAYS.map(d => <div key={d} className="text-center py-1">{d.slice(0, 2)}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-y-0.5" onMouseLeave={() => setHover(null)}>
          {cells.map((ds, i) => {
            if (!ds) return <div key={`b${i}`} />;
            const disabled = ds > yesterday || ds < MIN_DAY;
            const isEdge = ds === lo || ds === hi;
            const inRange = ds > lo && ds < hi;
            return (
              <button key={ds} type="button" disabled={disabled}
                onClick={() => clickDay(ds)} onMouseEnter={() => selecting && setHover(ds)}
                className={`h-8 text-xs tabular-nums transition-colors ${disabled ? 'text-slate-700 cursor-not-allowed'
                  : isEdge ? 'bg-blue-600 text-white font-semibold rounded-md'
                  : inRange ? 'bg-blue-500/20 text-blue-100'
                  : 'text-slate-200 hover:bg-slate-800 rounded-md'}`}>
                {Number(ds.slice(8))}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label="Choose date range" className="bg-slate-950 border border-slate-800 rounded-xl shadow-2xl flex flex-col sm:flex-row overflow-hidden w-full max-w-[820px] max-h-[92vh]">
        <div className="sm:w-48 shrink-0 border-b sm:border-b-0 sm:border-r border-slate-800 py-2 overflow-y-auto flex sm:block gap-1 sm:gap-0 px-2 sm:px-0">
          {COACH_RANGE_PRESETS.map(p => (
            <button key={p.key} type="button" onClick={() => pickPreset(p.key)}
              className={`whitespace-nowrap sm:w-full text-left px-4 py-2 text-sm rounded sm:rounded-none ${preset === p.key ? 'bg-blue-600/15 text-blue-200 sm:border-l-2 sm:border-blue-500' : 'text-slate-300 hover:bg-slate-900 sm:border-l-2 sm:border-transparent'}`}>
              {p.label}
            </button>
          ))}
          <div className={`whitespace-nowrap sm:w-full px-4 py-2 text-sm ${preset === 'custom' ? 'text-blue-200' : 'text-slate-600'}`}>Custom</div>
        </div>
        <div className="flex-1 min-w-0 p-5 flex flex-col gap-4 overflow-y-auto">
          <div className="flex items-start gap-2">
            <button type="button" onClick={() => shift(-1)} className="h-8 w-8 shrink-0 rounded-md text-slate-300 hover:bg-slate-800 text-lg" aria-label="Previous month">‹</button>
            {month(left.y, left.m, (y, m) => setLeft({ y, m }))}
            <div className="w-px self-stretch bg-slate-800 hidden md:block" />
            <div className="hidden md:flex flex-1 min-w-0">{month(right.y, right.m, (y, m) => setLeft(m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }))}</div>
            <button type="button" onClick={() => shift(1)} className="h-8 w-8 shrink-0 rounded-md text-slate-300 hover:bg-slate-800 text-lg" aria-label="Next month">›</button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-200">{since}</span>
            <span className="text-slate-500">–</span>
            <span className="font-mono rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-200">{selecting ? '…' : until}</span>
            {selecting && <span className="text-slate-500">Pick the end day</span>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-800 pt-4">
            <p className="text-[11px] text-slate-500">Dates are US Eastern time. Today isn&apos;t included.</p>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} className="px-4 py-1.5 rounded-lg border border-slate-700 text-sm font-semibold text-slate-300 hover:text-white">Cancel</button>
              <button type="button" onClick={apply} className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-sm font-semibold text-white">Update</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
