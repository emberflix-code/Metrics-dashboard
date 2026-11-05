'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { InsightFinding, InsightReport } from '@/lib/insights/engine';

// Pop-up with the client dashboard's written Meta analysis (same rules, see
// lib/insights/engine.ts) for the board's date range.

type Resp = { report?: InsightReport; leadsSource?: string; cachedThrough?: string | null; noMeta?: boolean; error?: string };

const TONE: Record<InsightFinding['tone'], { mark: string; cls: string }> = {
  good: { mark: '✓', cls: 'text-emerald-400' },
  bad: { mark: '!', cls: 'text-red-400' },
  warn: { mark: '!', cls: 'text-amber-400' },
  info: { mark: 'i', cls: 'text-sky-400' },
};

// **bold** → <strong>, everything else escaped (same as the dashboard's _insightMd).
function md(s: string): string {
  const esc = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>');
}

function toMarkdown(name: string, r: InsightReport): string {
  const sp = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p).toFixed(1)}%`;
  const lines = [`# ${name} — Meta insights, ${r.rangeLabel}`, ''];
  lines.push(r.tiles.map(t => `- ${t.label}: ${t.value}${t.delta != null && Number.isFinite(t.delta) ? ` (${sp(t.delta)} vs previous period)` : ''}${t.sub ? ` — ${t.sub}` : ''}`).join('\n'), '');
  for (const s of r.sections) { lines.push(`## ${s.title}`, s.findings.length ? s.findings.map(f => `- ${f.text}`).join('\n') : `_${s.empty || 'Nothing to report.'}_`, ''); }
  lines.push('## Recommendations', r.recommendations.map((t, i) => `${i + 1}. ${t}`).join('\n'), '', '---', r.basis.map(b => `_${b}_`).join('\n'));
  return lines.join('\n');
}

export default function InsightsModal({ client, range, onClose, onOpenDashboard }: {
  client: { id: string; name: string; leadsSource: string };
  range: string;
  onClose: () => void;
  onOpenDashboard: () => void;
}) {
  const [data, setData] = useState<Resp | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setData(null);
    fetch(`/api/coach/clients/${client.id}/insights`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range }) })
      .then(r => r.json()).then(j => { if (live) setData(j); })
      .catch(e => { if (live) setData({ error: String(e) }); });
    return () => { live = false; };
  }, [client.id, range]);

  const r = data?.report;
  async function copy() {
    if (!r) return;
    try { await navigator.clipboard.writeText(toMarkdown(client.name, r)); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked */ }
  }

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[250] bg-black/60 flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-label={`Insights — ${client.name}`} className="bg-slate-950 border border-slate-800 rounded-xl shadow-2xl w-full max-w-[980px] max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white truncate">{client.name} — Meta insights</h2>
            <p className="text-xs text-slate-500">{r ? `${r.rangeLabel} · ${r.days} day${r.days === 1 ? '' : 's'}` : 'Loading…'}{data?.cachedThrough ? ` · data through ${data.cachedThrough}` : ''}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {r && <button type="button" onClick={copy} className="text-xs px-2.5 py-1 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:border-slate-500">{copied ? 'Copied' : 'Copy as text'}</button>}
            <button type="button" onClick={onOpenDashboard} className="text-xs px-2.5 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white">Open dashboard</button>
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none ml-1" aria-label="Close">×</button>
          </div>
        </div>
        <div className="overflow-y-auto px-5 py-4 coach-scroll">
          {!data && <div className="py-10 text-center text-sm text-slate-500"><span className="inline-block h-3 w-3 rounded-full bg-blue-500 animate-pulse mr-2 align-middle" />Analysing…</div>}
          {data?.error && <p className="text-sm text-rose-300">Could not build insights: {data.error}</p>}
          {data?.noMeta && <p className="text-sm text-slate-400">This client has no Meta ads, so there&apos;s no Meta analysis. Use the Ads button to see their Google ads.</p>}
          {r && (
            <>
              {client.leadsSource !== 'meta' && (
                <p className="text-[11px] text-amber-300/90 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2 mb-3">
                  Based on Meta&apos;s own lead count. This client&apos;s dashboard counts leads from {client.leadsSource === 'ghl' ? 'GHL' : 'their leads sheet'}, so its numbers can differ.
                </p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-4">
                {r.tiles.map(t => {
                  const has = t.delta != null && Number.isFinite(t.delta);
                  const up = has && t.delta! > 0, good = t.lowerIsBetter ? !up : up;
                  const flat = has && Math.abs(t.delta!) < 0.05;
                  return (
                    <div key={t.label} className="bg-slate-900/60 border border-slate-800 rounded-lg px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{t.label}</div>
                      <div className="text-base font-bold text-white font-mono mt-0.5">
                        {t.value}
                        {has && <span className={`ml-1.5 font-mono text-[10px] ${flat ? 'text-slate-500' : good ? 'text-emerald-400' : 'text-red-400'}`} title="vs the previous period of the same length">{flat ? '—' : `${up ? '↑' : '↓'}${Math.abs(t.delta!).toFixed(1)}%`}</span>}
                      </div>
                      {t.sub && <div className="text-[10px] text-slate-500 mt-0.5">{t.sub}</div>}
                    </div>
                  );
                })}
              </div>
              {r.sections.map(s => (
                <div key={s.key} className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 mb-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">{s.title}</h4>
                  {s.findings.length ? (
                    <ul className="space-y-1.5">
                      {s.findings.map((f, i) => (
                        <li key={i} className="flex items-start gap-2 text-[13px] leading-relaxed text-slate-300">
                          <span className={`shrink-0 mt-[3px] w-3.5 h-3.5 rounded-full border border-current text-[9px] font-bold flex items-center justify-center ${TONE[f.tone].cls}`}>{TONE[f.tone].mark}</span>
                          <span dangerouslySetInnerHTML={{ __html: md(f.text) }} />
                        </li>
                      ))}
                    </ul>
                  ) : <div className="text-xs text-slate-500">{s.empty || 'Nothing to report.'}</div>}
                  {s.table && <div dangerouslySetInnerHTML={{ __html: s.table }} />}
                </div>
              ))}
              <div className="bg-blue-500/5 border border-blue-500/20 rounded-xl p-4 mb-3">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-blue-300 mb-2">Recommendations</h4>
                <ol className="space-y-1.5 list-decimal list-inside">
                  {r.recommendations.map((t, i) => <li key={i} className="text-[13px] leading-relaxed text-slate-200" dangerouslySetInnerHTML={{ __html: md(t) }} />)}
                </ol>
              </div>
              <div className="text-[11px] text-slate-500 leading-relaxed">
                {r.basis.map((b, i) => <div key={i}>{b}</div>)}
                <div>Compared with the previous period of the same length. Same rules as the Insights tab on the client dashboard.</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
