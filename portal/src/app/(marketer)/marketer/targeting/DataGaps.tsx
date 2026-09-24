'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { TargetingReport } from '@/lib/marketer/targeting';
import { adsManagerAdsetUrl, fmtUsd } from '../_components/format';

type Action = 'geocode' | 'attribution' | 'targeting';

const ACTIONS: Record<Action, { label: string; url: string; body: Record<string, unknown>; hint: string }> = {
  geocode: { label: 'Geocode clubs', url: '/api/admin/geocode', body: {}, hint: 'Resolves clients.location_address to a pin for every club not yet geocoded.' },
  attribution: { label: 'Refresh attribution', url: '/api/admin/marketer/refresh-attribution', body: {}, hint: 'Recomputes campaign → client mapping from each client\'s campaign filter.' },
  targeting: { label: 'Backfill targeting', url: '/api/admin/marketer/backfill', body: { step: 'targeting' }, hint: 'Fetches ad set targeting specs from Meta and resolves city/zip keys to coordinates.' },
};

// Everything the report could NOT place, with the buttons that fix it.
// Results are shown raw (JSON) — these are operator actions, not client UI.
export default function DataGaps({ unmapped, broadCount, adsetsWithoutTargeting }: {
  unmapped: TargetingReport['unmapped'];
  broadCount: number;
  adsetsWithoutTargeting: number;
}) {
  const router = useRouter();
  const [running, setRunning] = useState<Action | null>(null);
  const [result, setResult] = useState<{ action: Action; ok: boolean; text: string } | null>(null);
  const [showAllCoords, setShowAllCoords] = useState(false);

  async function run(action: Action) {
    if (running) return;
    setRunning(action);
    setResult(null);
    const spec = ACTIONS[action];
    try {
      const res = await fetch(spec.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec.body) });
      const text = await res.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON — show as-is */ }
      setResult({ action, ok: res.ok, text: res.ok ? pretty : `HTTP ${res.status}\n${pretty}` });
      if (res.ok) router.refresh();
    } catch (err) {
      setResult({ action, ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(null);
    }
  }

  const coords = showAllCoords ? unmapped.adsetsWithoutCoordinates : unmapped.adsetsWithoutCoordinates.slice(0, 15);
  const totalGaps = unmapped.clientsWithoutGeocode.length + unmapped.adsetsWithoutCoordinates.length + adsetsWithoutTargeting;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Data gaps</h2>
          <p className="text-xs text-slate-500">
            {totalGaps === 0 ? 'Every club and ad set in range is placed on the map.' : 'What the report could not place, and why.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(ACTIONS) as Action[]).map(a => (
            <button
              key={a}
              type="button"
              title={ACTIONS[a].hint}
              disabled={running !== null}
              onClick={() => run(a)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 hover:border-slate-500 text-slate-200 hover:text-white bg-slate-800/60 disabled:opacity-50 transition-colors"
            >
              {running === a ? 'Running…' : ACTIONS[a].label}
            </button>
          ))}
        </div>
      </div>

      {result && (
        <div className={`px-4 py-3 border-b border-slate-800 ${result.ok ? 'bg-emerald-500/5' : 'bg-red-500/5'}`}>
          <div className={`text-xs font-semibold mb-1 ${result.ok ? 'text-emerald-300' : 'text-red-300'}`}>
            {ACTIONS[result.action].label}: {result.ok ? 'done' : 'failed'}
          </div>
          <pre className="text-[11px] text-slate-300 whitespace-pre-wrap break-all max-h-48 overflow-auto font-mono">{result.text}</pre>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-slate-800">
        <div className="px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Clubs without a pin</p>
          <p className="text-lg font-semibold text-white mt-0.5">{unmapped.clientsWithoutGeocode.length}</p>
          {unmapped.clientsWithoutGeocode.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {unmapped.clientsWithoutGeocode.map(c => (
                <li key={c.clientId} className="flex flex-col">
                  <span className="text-slate-200">{c.name}</span>
                  <span className="text-slate-500 truncate" title={c.address}>{c.address || 'no address on the client'}{c.error ? ` · ${c.error}` : c.address ? ' · not geocoded yet' : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Ad sets without coordinates</p>
          <p className="text-lg font-semibold text-white mt-0.5">{unmapped.adsetsWithoutCoordinates.length}</p>
          <p className="text-xs text-slate-500">City/zip targeting whose key has not resolved through the geocoder yet.</p>
          {coords.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {coords.map(a => (
                <li key={`${a.accountId}:${a.adsetId}`} className="flex items-baseline justify-between gap-2">
                  <a href={adsManagerAdsetUrl(a.accountId, a.adsetId)} target="_blank" rel="noopener noreferrer" className="text-slate-200 hover:text-blue-200 truncate" title={`${a.adsetName} — ${a.campaignName}`}>{a.adsetName}</a>
                  <span className="text-slate-500 shrink-0">{fmtUsd(a.spend, 0)}</span>
                </li>
              ))}
            </ul>
          )}
          {unmapped.adsetsWithoutCoordinates.length > 15 && (
            <button type="button" onClick={() => setShowAllCoords(v => !v)} className="mt-2 text-xs text-blue-300 hover:text-blue-200">
              {showAllCoords ? 'Show fewer' : `Show all ${unmapped.adsetsWithoutCoordinates.length}`}
            </button>
          )}
        </div>

        <div className="px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Not drawable</p>
          <dl className="mt-1 text-xs space-y-1">
            <div className="flex justify-between gap-2"><dt className="text-slate-400">Ad sets with no targeting fetched</dt><dd className="text-white">{adsetsWithoutTargeting}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-slate-400">Region / country only (“Broad” tab)</dt><dd className="text-white">{broadCount}</dd></div>
          </dl>
          {adsetsWithoutTargeting > 0 && <p className="mt-2 text-xs text-slate-500">Run “Backfill targeting” to fetch the missing specs.</p>}
        </div>
      </div>
    </div>
  );
}
