'use client';

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { glossaryFor } from '@/lib/glossary';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the term is visible on the page as a whole word (plural "s" allowed, any case —
 *  table headers are shown in CSS uppercase). */
function termOnPage(term: string, text: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(term)}s?(?=[^A-Za-z0-9]|$)`, 'i').test(text);
}

// "?" button that opens a searchable list of the abbreviations used on the dashboard.
// onlyOnPage: list only the terms visible on the page when it's opened (client dashboards).
export default function GlossaryButton({ audience, className, onlyOnPage = false }: { audience: 'client' | 'coach'; className?: string; onlyOnPage?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pageText, setPageText] = useState<string | null>(null);
  const sections = useMemo(() => {
    const all = glossaryFor(audience);
    if (!onlyOnPage || pageText === null) return all;
    return all
      .map(s => ({ ...s, entries: s.entries.filter(e => termOnPage(e.term, pageText)) }))
      .filter(s => s.entries.length > 0);
  }, [audience, onlyOnPage, pageText]);

  function openPopup() {
    setQ('');
    // Read what's on screen before the pop-up itself is added (innerText = visible text only).
    if (onlyOnPage) setPageText(document.body.innerText || '');
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const term = q.trim().toLowerCase();
  const shown = sections
    .map(s => ({ ...s, entries: s.entries.filter(e => !term || `${e.term} ${e.meaning} ${e.how || ''}`.toLowerCase().includes(term)) }))
    .filter(s => s.entries.length > 0);

  return (
    <>
      <button type="button" onClick={openPopup} title="What do the abbreviations mean?" aria-label="Abbreviations"
        className={className || 'text-xs bg-slate-800/50 hover:bg-slate-800 text-slate-300 border border-slate-600 px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5'}>
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" strokeWidth={2} />
          <path strokeWidth={2} strokeLinecap="round" d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01" />
        </svg>
        <span>Abbreviations</span>
      </button>
      {/* Portal to <body>: a header with backdrop-blur would otherwise trap a fixed pop-up inside it. */}
      {open && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-4" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div role="dialog" aria-label="Abbreviations" className="bg-slate-950 border border-slate-800 rounded-xl shadow-2xl w-full max-w-[640px] max-h-[85vh] flex flex-col text-left">
            <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-slate-800">
              <h2 className="text-base font-semibold text-white">Abbreviations</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-white text-xl leading-none" aria-label="Close">×</button>
            </div>
            <div className="px-5 pt-3">
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search, e.g. CPL"
                className="w-full h-9 bg-slate-900 border border-slate-700 rounded-lg px-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500" />
            </div>
            <div className="overflow-y-auto px-5 py-3 space-y-5">
              {shown.length === 0 && (
                <p className="text-sm text-slate-500 py-6 text-center">
                  {term ? <>Nothing matches “{q}”.</> : 'No abbreviations on this page yet. Open it again once the numbers have loaded.'}
                </p>
              )}
              {onlyOnPage && shown.length > 0 && !term && <p className="text-[11px] text-slate-500 -mt-1">Abbreviations shown on this page.</p>}
              {shown.map(s => (
                <div key={s.title}>
                  <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">{s.title}</p>
                  <dl className="divide-y divide-slate-800/70">
                    {s.entries.map(e => (
                      <div key={e.term} className="grid grid-cols-[110px_1fr] gap-3 py-2">
                        <dt className="font-mono text-sm font-semibold text-blue-300">{e.term}</dt>
                        <dd className="text-sm text-slate-200">
                          {e.meaning}
                          {e.how && <span className="block text-xs text-slate-500 mt-0.5">{e.how}</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
