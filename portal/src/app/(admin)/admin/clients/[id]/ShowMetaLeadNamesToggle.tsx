'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  current: boolean;
  /** clients.leads_source — the toggle only has an effect when this is 'meta'. */
  leadsSource: string;
}

export default function ShowMetaLeadNamesToggle({ clientId, current, leadsSource }: Props) {
  const [enabled, setEnabled] = useState(current);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const isMeta = leadsSource === 'meta';

  async function toggle() {
    const next = !enabled;
    setEnabled(next);
    setStatus('saving');
    try {
      const res = await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ show_meta_lead_names: next }),
      });
      if (!res.ok) { setEnabled(!next); setStatus('error'); return; }
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setEnabled(!next);
      setStatus('error');
    }
  }

  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm text-white font-medium">Show Meta lead names</p>
        <p className="text-xs text-slate-400 mt-0.5">
          Makes the Leads KPI card clickable, listing the people behind the number (name, email, phone) from the Meta instant form. Requires the agency-wide Page token in Settings to have Leads access on the Page that owns the form. Surfaces client contact details in the client-facing dashboard.
        </p>
        {enabled && !isMeta && (
          <p className="text-xs text-amber-400 mt-1.5">
            No effect while Leads source is &ldquo;{leadsSource}&rdquo; — only Meta-attributed leads have an instant form to read names from.
          </p>
        )}
      </div>
      <div className="flex items-center gap-3 ml-6 shrink-0">
        {status === 'saved' && <span className="text-xs text-emerald-400">Saved</span>}
        {status === 'error' && <span className="text-xs text-red-400">Error</span>}
        <button
          type="button"
          onClick={toggle}
          disabled={status === 'saving'}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${enabled ? 'bg-blue-600' : 'bg-slate-600'}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>
    </div>
  );
}
