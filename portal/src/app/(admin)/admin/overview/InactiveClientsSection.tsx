'use client';

import { useState } from 'react';
import ActiveToggle from '../clients/[id]/ActiveToggle';

interface InactiveClient {
  id: string;
  name: string;
}

// Deliberately metrics-free — inactive clients are excluded from the Meta/GHL
// fetch pipeline above (see page.tsx's inactiveClients query comment), so
// this is just a name + reactivate toggle, collapsed by default since it's
// not the primary thing an admin opens this page to see.
export default function InactiveClientsSection({ clients }: { clients: InactiveClient[] }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4 bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-slate-800/30 transition-colors"
      >
        <svg
          className={`w-3.5 h-3.5 text-slate-400 transition-transform shrink-0 ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
        <span className="font-semibold text-slate-300 text-sm">Inactive Clients</span>
        <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full bg-slate-700/50 text-slate-400">
          {clients.length}
        </span>
        <span className="text-xs text-slate-500 ml-auto">Hidden from Agency Overview metrics — dashboard &amp; login still work</span>
      </button>
      {open && (
        <div className="border-t border-slate-800">
          <table className="w-full text-sm">
            <tbody>
              {clients.map(c => (
                <tr key={c.id} className="border-b border-slate-800/50 last:border-b-0 hover:bg-slate-800/20">
                  <td className="px-4 py-2.5 text-slate-300">{c.name}</td>
                  <td className="px-4 py-2.5 w-24">
                    <ActiveToggle clientId={c.id} current={false} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
