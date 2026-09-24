'use client';

import { useMemo, useState } from 'react';
import type { ProposalHit } from '@/lib/geoOverlap';
import type { FocusReport } from '@/lib/marketer/targeting';
import { adsManagerAdsetUrl, fmtInt, fmtKm, fmtMi, fmtUsd } from '../_components/format';
import {
  SLIDER_MAX_MI, SLIDER_MIN_MI, SLIDER_STEP_MI, kmToMi, miToKm, snapMi,
  type FocusProposal, type PinProposal,
} from './focusSim';

const PANEL_H = 'max-h-[560px]';

function pct(v: number): string {
  return `${(v - SLIDER_MIN_MI) / (SLIDER_MAX_MI - SLIDER_MIN_MI) * 100}%`;
}

function hitLabel(h: ProposalHit): string {
  const t = h.target;
  return `${t.clientName ?? 'Unattributed'} · ${t.adsetName}`;
}

function ResultStrip({ mi, hits }: { mi: number; hits: ProposalHit[] }) {
  const counted = hits.filter(h => h.counted);
  const siblings = hits.filter(h => !h.counted);
  if (counted.length === 0) {
    return (
      <p className="text-[11px] text-emerald-300 mt-1">
        No overlaps at {mi} mi{siblings.length > 0 ? <span className="text-slate-500"> · {siblings.length} same-campaign sibling{siblings.length === 1 ? '' : 's'} not counted</span> : ''}
      </p>
    );
  }
  return (
    <p className="text-[11px] text-slate-300 mt-1 leading-relaxed">
      At <span className="text-white font-medium">{mi} mi</span> you would overlap:{' '}
      {counted.map((h, i) => (
        <span key={h.target.circleId}>
          {i > 0 && ', '}
          <span className={h.score >= 0.5 ? 'text-red-300' : h.score >= 0.2 ? 'text-amber-300' : 'text-slate-200'} title={`${h.target.campaignName} — ${fmtMi(h.distanceKm)} away`}>
            {hitLabel(h)} {Math.round(h.score * 100)}%
          </span>
          <span className="text-slate-500"> ({h.sameCampaign ? 'same campaign' : 'other'}{h.target.offer ? `, ${h.target.offer}` : ''}, {fmtUsd(h.target.spend, 0)})</span>
        </span>
      ))}
      {siblings.length > 0 && <span className="text-slate-500"> · {siblings.length} same-campaign sibling{siblings.length === 1 ? '' : 's'} not counted</span>}
    </p>
  );
}

function RadiusSlider({ title, subtitle, valueMi, currentMi, safeMi, onChange, hits, accent = 'emerald', trailing }: {
  title: string;
  subtitle?: string;
  valueMi: number;
  currentMi: number | null;
  safeMi: number | null;
  onChange: (mi: number) => void;
  hits: ProposalHit[] | null;
  accent?: 'emerald' | 'pink';
  trailing?: React.ReactNode;
}) {
  const accentCls = accent === 'pink' ? 'accent-pink-400' : 'accent-emerald-400';
  return (
    <div className="px-4 py-3 border-b border-slate-800/60">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-white truncate" title={title}>{title}</div>
          {subtitle && <div className="text-[11px] text-slate-500 truncate" title={subtitle}>{subtitle}</div>}
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm text-white font-medium">{valueMi} mi <span className="text-slate-500 text-xs">({fmtKm(miToKm(valueMi))})</span></div>
          {currentMi !== null && Math.abs(currentMi - valueMi) > 1e-6 && (
            <div className="text-[11px] text-slate-500">now {currentMi.toFixed(1)} mi</div>
          )}
        </div>
      </div>
      <div className="relative mt-2 pb-3">
        <input
          type="range"
          min={SLIDER_MIN_MI}
          max={SLIDER_MAX_MI}
          step={SLIDER_STEP_MI}
          value={valueMi}
          onChange={e => onChange(Number(e.target.value))}
          className={`w-full ${accentCls} cursor-pointer`}
        />
        <div className="absolute left-0 right-0 bottom-0 h-3 pointer-events-none">
          {currentMi !== null && (
            <span className="absolute -translate-x-1/2 top-0 flex flex-col items-center" style={{ left: pct(Math.min(SLIDER_MAX_MI, Math.max(SLIDER_MIN_MI, currentMi))) }} title={`Current radius ${currentMi.toFixed(1)} mi`}>
              <span className="block w-px h-2 bg-slate-300" />
              <span className="text-[9px] text-slate-400 leading-none">now</span>
            </span>
          )}
          {safeMi !== null && (
            <span className="absolute -translate-x-1/2 top-0 flex flex-col items-center" style={{ left: pct(safeMi) }} title={`Largest overlap-free radius: ${safeMi} mi`}>
              <span className="block w-px h-2 bg-emerald-400" />
              <span className="text-[9px] text-emerald-400 leading-none">safe {safeMi}</span>
            </span>
          )}
        </div>
      </div>
      {safeMi === null && hits !== null && (
        <p className="text-[11px] text-slate-500 mt-1">No overlap-free radius: something already sits within {SLIDER_MIN_MI} mi.</p>
      )}
      {hits !== null && <ResultStrip mi={valueMi} hits={hits} />}
      {trailing}
    </div>
  );
}

export default function NeighboursPanel({
  focus, proposals, pin, includeSameCampaign,
  onProposeKm, onProposeAllKm, onReset, onPinRadius, onRemovePin,
  selectedCircleId, onSelectCircle,
}: {
  focus: FocusReport;
  proposals: FocusProposal[];
  pin: PinProposal | null;
  includeSameCampaign: boolean;
  onProposeKm: (circleId: string, km: number) => void;
  onProposeAllKm: (km: number) => void;
  onReset: () => void;
  onPinRadius: (km: number) => void;
  onRemovePin: () => void;
  selectedCircleId: string | null;
  onSelectCircle: (circleId: string) => void;
}) {
  const anyChanged = proposals.some(p => p.changed);
  const uniformMi = useMemo(() => {
    if (proposals.length === 0) return null;
    const first = snapMi(kmToMi(proposals[0].proposedKm));
    return proposals.every(p => snapMi(kmToMi(p.proposedKm)) === first) ? first : null;
  }, [proposals]);
  const [allMi, setAllMi] = useState<number | null>(null);
  const allValue = uniformMi ?? allMi ?? (proposals.length > 0 ? snapMi(proposals.reduce((s, p) => s + kmToMi(p.proposedKm), 0) / proposals.length) : SLIDER_MIN_MI);

  // "All my ad sets" collides with everything any single proposal collides
  // with, so its strip is the union at the shared radius.
  const allHits = useMemo(() => {
    if (uniformMi === null) return null;
    const seen = new Map<string, ProposalHit>();
    for (const p of proposals) for (const h of p.hits) {
      const prev = seen.get(h.target.circleId);
      if (!prev || h.score > prev.score) seen.set(h.target.circleId, h);
    }
    return Array.from(seen.values()).sort((x, y) => y.score - x.score);
  }, [proposals, uniformMi]);
  const allSafe = useMemo(() => {
    const vals = proposals.map(p => p.safeCeilingMi);
    if (vals.length === 0 || vals.some(v => v === null)) return null;
    return Math.min(...(vals as number[]));
  }, [proposals]);

  // Proposed overlap per neighbour = the best any changed proposal does against it.
  const proposedByCircle = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of proposals) for (const h of p.hits) {
      if (!h.counted) continue;
      m.set(h.target.circleId, Math.max(m.get(h.target.circleId) ?? 0, h.score));
    }
    return m;
  }, [proposals]);

  const neighbourCount = focus.neighbours.length;

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden flex flex-col">
      <div className="px-4 py-2.5 border-b border-slate-800 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white truncate">Around {focus.clientName}</h2>
          <p className="text-[11px] text-slate-500">
            {focus.centerSource === 'club' ? 'Ring centred on the club' : focus.centerSource === 'circles' ? 'No geocoded club — ring centred on its ad sets' : 'No club and no circles to centre on'} · {fmtMi(focus.ringKm)} ({fmtKm(focus.ringKm)}) · {neighbourCount} neighbour{neighbourCount === 1 ? '' : 's'}
          </p>
        </div>
        {anyChanged && (
          <button type="button" onClick={onReset} className="text-xs text-slate-300 hover:text-white border border-slate-700 hover:border-slate-500 rounded-lg px-2.5 py-1 transition-colors shrink-0">
            Reset radii
          </button>
        )}
      </div>

      <div className={`${PANEL_H} overflow-auto`}>
        <div className="px-4 pt-3 pb-1 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Your ad sets here ({proposals.length})</p>
          <p className="text-[10px] text-slate-500">simulation only — nothing is written to Meta</p>
        </div>

        {proposals.length === 0 && (
          <p className="px-4 py-3 text-xs text-slate-500">No drawn circles for this client in range (see Data gaps below if it should have some).</p>
        )}

        {proposals.length > 1 && (
          <RadiusSlider
            title="All my ad sets"
            subtitle="Drives every slider below together"
            valueMi={allValue}
            currentMi={null}
            safeMi={allSafe}
            hits={allHits}
            onChange={mi => { setAllMi(mi); onProposeAllKm(miToKm(mi)); }}
          />
        )}

        {proposals.map(p => (
          <RadiusSlider
            key={p.circle.circleId}
            title={p.circle.adsetName}
            subtitle={`${p.circle.campaignName || '—'} · ${p.circle.offer} · ${p.circle.kind}${p.circle.approx ? ' (assumed radius)' : ''} · ${fmtUsd(p.circle.spend, 0)} · CPL ${fmtUsd(p.circle.cpl)}`}
            valueMi={snapMi(kmToMi(p.proposedKm))}
            currentMi={kmToMi(p.currentKm)}
            safeMi={p.safeCeilingMi}
            hits={p.hits}
            onChange={mi => onProposeKm(p.circle.circleId, miToKm(mi))}
            trailing={
              <a href={adsManagerAdsetUrl(p.circle.accountId, p.circle.adsetId)} target="_blank" rel="noopener noreferrer" className="inline-block mt-1 text-[11px] text-blue-300 hover:text-blue-200">
                Apply in Ads Manager ↗
              </a>
            }
          />
        ))}

        {pin && (
          <>
            <div className="px-4 pt-3 pb-1 flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-pink-300">Planned location</p>
              <button type="button" onClick={onRemovePin} className="text-[11px] text-slate-400 hover:text-white">Remove</button>
            </div>
            <RadiusSlider
              title={`Pin at ${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`}
              subtitle="Hypothetical ad set — click the map again or drag the pin to move it"
              valueMi={snapMi(kmToMi(pin.radiusKm))}
              currentMi={null}
              safeMi={pin.safeCeilingMi}
              hits={pin.hits}
              accent="pink"
              onChange={mi => onPinRadius(miToKm(mi))}
            />
          </>
        )}

        <div className="px-4 pt-4 pb-1 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Neighbours ({neighbourCount})</p>
          <p className="text-[10px] text-slate-500">click a row to show it on the map</p>
        </div>

        {neighbourCount === 0 && focus.unmappedNeighbours.length === 0 ? (
          <p className="px-4 py-6 text-xs text-slate-500 text-center">Nothing else runs within {fmtMi(focus.ringKm)} of this club.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-900 z-10">
              <tr className="border-b border-slate-800">
                <th className="px-3 py-2 text-right">Dist.</th>
                <th className="px-3 py-2 text-left">Client / campaign / ad set</th>
                <th className="px-3 py-2 text-left">Offer</th>
                <th className="px-3 py-2 text-right">Radius</th>
                <th className="px-3 py-2 text-right">Spend</th>
                <th className="px-3 py-2 text-right">CPL</th>
                <th className="px-3 py-2 text-right">Overlap</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {focus.neighbours.map(n => {
                const c = n.circle;
                const current = n.overlapWithFocus[0]?.score ?? 0;
                const proposed = anyChanged ? (proposedByCircle.get(c.circleId) ?? 0) : null;
                const selected = selectedCircleId === c.circleId;
                const sameBrand = focus.brand && c.brand === focus.brand;
                return (
                  <tr key={c.circleId} onClick={() => onSelectCircle(c.circleId)} className={`cursor-pointer align-top transition-colors ${selected ? 'bg-blue-500/10' : 'hover:bg-slate-800/40'}`}>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtMi(n.distanceKm)}</td>
                    <td className="px-3 py-2 min-w-0">
                      <div className="text-white truncate max-w-[220px]" title={c.clientName ?? 'Unattributed'}>
                        {c.clientName ?? <span className="text-slate-500">Unattributed</span>}
                        {sameBrand && <span className="ml-1 text-[9px] uppercase text-slate-500">{c.brand}</span>}
                      </div>
                      <div className="text-slate-400 truncate max-w-[220px]" title={c.campaignName}>{c.campaignName || '—'}</div>
                      <div className="text-slate-500 truncate max-w-[220px]" title={c.adsetName}>{c.adsetName}{c.approx ? ' ~' : ''}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{c.offer}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtMi(c.radiusKm)}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtUsd(c.spend, 0)}</td>
                    <td className="px-3 py-2 text-right text-slate-300 whitespace-nowrap">{fmtUsd(c.cpl)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <span className={current >= 0.5 ? 'text-red-300' : current >= 0.2 ? 'text-amber-300' : current > 0 ? 'text-slate-200' : 'text-slate-600'}>{current > 0 ? `${Math.round(current * 100)}%` : '—'}</span>
                      {proposed !== null && Math.round(proposed * 100) !== Math.round(current * 100) && (
                        <span className={`ml-1 ${proposed >= 0.5 ? 'text-red-300' : proposed >= 0.2 ? 'text-amber-300' : proposed > 0 ? 'text-emerald-200' : 'text-emerald-300'}`}>→ {proposed > 0 ? `${Math.round(proposed * 100)}%` : '0%'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <a href={adsManagerAdsetUrl(c.accountId, c.adsetId)} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-blue-300 hover:text-blue-200">↗</a>
                    </td>
                  </tr>
                );
              })}
              {focus.unmappedNeighbours.map(u => (
                <tr key={`${u.accountId}:${u.adsetId}`} className="align-top text-slate-500">
                  <td className="px-3 py-2 text-right whitespace-nowrap">{u.clubDistanceKm === null ? 'here' : `~${fmtMi(u.clubDistanceKm)}`}</td>
                  <td className="px-3 py-2 min-w-0">
                    <div className="truncate max-w-[220px]" title={u.clientName ?? 'Unattributed'}>{u.clientName ?? 'Unattributed'}</div>
                    <div className="truncate max-w-[220px]" title={u.campaignName}>{u.campaignName || '—'}</div>
                    <div className="truncate max-w-[220px]" title={u.adsetName}>{u.adsetName}</div>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap" colSpan={3}>
                    <span className="inline-block text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-full border border-slate-700 bg-slate-800 text-slate-400">can&apos;t assess</span>
                    <span className="ml-1.5">{u.reason}</span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">{fmtUsd(u.spend, 0)}</td>
                  <td className="px-3 py-2 text-right">—</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <a href={adsManagerAdsetUrl(u.accountId, u.adsetId)} target="_blank" rel="noopener noreferrer" className="text-blue-300 hover:text-blue-200">↗</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-slate-800 text-[10px] text-slate-500">
        Overlap % = share of the smaller circle covered by the other. Same-campaign siblings are listed but {includeSameCampaign ? 'counted (toggle on)' : 'not counted until “Include same-campaign pairs” is on'}. “~” marks an assumed radius. {fmtInt(neighbourCount)} neighbours. Radius changes are applied in Ads Manager, not here.
      </div>
    </div>
  );
}
