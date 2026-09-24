'use client';

import { useEffect, useState } from 'react';
import type { Alert } from '@/lib/marketer/alerts';
import { ALERT_KIND_LABELS, SEVERITY_PILL_CLS } from './alertKinds';

// One alert row with Dismiss / Snooze / Undo. State is optimistic: the row
// mutes immediately and only reverts if the POST fails, so triaging a long
// list never waits on the network.
function AlertRow({ alert, compact, onUpdate }: { alert: Alert; compact: boolean; onUpdate: (next: Alert) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const muted = alert.dismissed;
  const thumb = typeof alert.metrics.thumbnailUrl === 'string' ? alert.metrics.thumbnailUrl : null;
  const [thumbFailed, setThumbFailed] = useState(false);

  async function post(body: Record<string, unknown>, optimistic: Alert) {
    const prev = alert;
    setBusy(true);
    setError(null);
    onUpdate(optimistic);
    try {
      const res = await fetch('/api/marketer/alerts/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: alert.key, ...body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      onUpdate(prev);
      setError(e instanceof Error ? e.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  const dismiss = () => post({}, { ...alert, dismissed: true, snoozedUntil: null });
  const snooze = () => post({ snoozeDays: 7 }, { ...alert, dismissed: true, snoozedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString() });
  const undo = () => post({ undo: true }, { ...alert, dismissed: false, snoozedUntil: null });

  const btn = 'text-[11px] px-2 py-1 rounded-md border border-slate-700 hover:border-slate-500 text-slate-300 hover:text-white disabled:opacity-50 transition-colors';

  return (
    <li className={`flex gap-3 ${compact ? 'px-3 py-2' : 'px-4 py-3'} ${muted ? 'opacity-50' : ''}`}>
      {thumb && !thumbFailed && (
        <div className="w-12 h-12 shrink-0 rounded-md overflow-hidden bg-slate-800 border border-slate-700">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={thumb} alt="" loading="lazy" onError={() => setThumbFailed(true)} className="w-full h-full object-cover" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`inline-block text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full border ${SEVERITY_PILL_CLS[alert.severity]}`}>{alert.severity}</span>
          <span className="text-[11px] text-slate-400">{ALERT_KIND_LABELS[alert.kind]}</span>
          {alert.clientName && <span className="text-[11px] text-slate-500 truncate">· {alert.clientName}</span>}
          {alert.snoozedUntil && muted && (
            <span className="text-[10px] text-slate-500">snoozed until {alert.snoozedUntil.slice(0, 10)}</span>
          )}
        </div>
        <p className={`text-sm text-white mt-0.5 ${compact ? 'truncate' : ''}`} title={alert.title}>{alert.title}</p>
        {alert.detail && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Collapse' : 'Expand'}
            className={`text-left text-xs text-slate-400 mt-0.5 ${expanded ? '' : 'line-clamp-2'} ${compact ? 'hidden sm:block' : ''}`}
          >
            {alert.detail}
          </button>
        )}
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          {alert.url && (
            <a href={alert.url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-300 hover:text-blue-200">
              Open in Ads Manager ↗
            </a>
          )}
          {muted ? (
            <button type="button" disabled={busy} onClick={undo} className={btn}>Undo</button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={dismiss} className={btn}>Dismiss</button>
              <button type="button" disabled={busy} onClick={snooze} className={btn}>Snooze 7d</button>
            </>
          )}
          {error && <span className="text-[11px] text-red-300">{error}</span>}
        </div>
      </div>
    </li>
  );
}

export default function AlertsList({ alerts, compact = false, onChange }: {
  alerts: Alert[];
  compact?: boolean;
  onChange?: (alerts: Alert[]) => void;
}) {
  const [items, setItems] = useState<Alert[]>(alerts);
  // Server re-render (filter/range change) hands down a new list; adopt it
  // rather than keeping stale optimistic state from the previous view.
  useEffect(() => { setItems(alerts); }, [alerts]);

  function update(next: Alert) {
    setItems(prev => {
      const out = prev.map(a => (a.key === next.key ? next : a));
      onChange?.(out);
      return out;
    });
  }

  if (items.length === 0) {
    return <p className="px-4 py-6 text-sm text-slate-500 text-center">Nothing to show.</p>;
  }
  return (
    <ul className="divide-y divide-slate-800/60">
      {items.map(a => <AlertRow key={a.key} alert={a} compact={compact} onUpdate={update} />)}
    </ul>
  );
}
