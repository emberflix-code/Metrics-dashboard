'use client';

import { useState, useRef } from 'react';

interface Lead {
  name: string;
  email: string;
  day: string;
}

interface Props {
  clientId: string;
  clientName: string;
  since: string;
  until: string;
  count: number;
}

// A double-click on this element is meant to bubble up to the parent
// GhlConfigModal's onDoubleClick (see page.tsx) instead of opening this leads
// list — so a plain click is delayed briefly to see if a second click
// follows before actually opening. Standard single-vs-double-click
// disambiguation, since a double-click is unavoidably preceded by one
// "click" event firing first.
const CLICK_DELAY_MS = 250;

export default function GhlLeadsListModal({ clientId, clientName, since, until, count }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function loadAndOpen() {
    setOpen(true);
    if (leads !== null) return; // already fetched this mount
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/clients/${clientId}/ghl-leads?since=${since}&until=${until}`);
      const data = await res.json();
      if (!res.ok) { setError(data?.error || 'Failed to load leads.'); return; }
      setLeads(data.leads);
    } catch {
      setError('Failed to load leads.');
    } finally {
      setLoading(false);
    }
  }

  function handleClick() {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => { loadAndOpen(); }, CLICK_DELAY_MS);
  }

  function handleDoubleClick() {
    if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
    // Intentionally do not stopPropagation — let it bubble to the parent
    // GhlConfigModal's onDoubleClick.
  }

  return (
    <>
      <span
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        title="Click to see lead names, double-click to configure GHL"
        className="cursor-pointer"
      >
        {count.toLocaleString()}
      </span>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setOpen(false)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-white mb-1">Leads</h3>
            <p className="text-sm text-slate-400 mb-4">{clientName} · {since} to {until}</p>

            <div className="overflow-y-auto flex-1 -mx-2 px-2">
              {loading && <p className="text-sm text-slate-500">Loading…</p>}
              {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
              {leads && leads.length === 0 && !loading && <p className="text-sm text-slate-500">No leads in this range.</p>}
              {leads && leads.length > 0 && (
                <table className="w-full text-sm">
                  <tbody>
                    {leads.map((lead, i) => (
                      <tr key={i} className="border-b border-slate-800/50">
                        <td className="py-2 pr-3 text-white">{lead.name}</td>
                        <td className="py-2 pr-3 text-slate-400 truncate max-w-[140px]">{lead.email}</td>
                        <td className="py-2 text-right text-slate-500 font-mono whitespace-nowrap">{lead.day}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-end mt-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-4 py-2 text-sm text-slate-300 hover:text-white"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
