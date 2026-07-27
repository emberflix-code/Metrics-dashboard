'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  clientName: string;
  currentLocationId: string;
  currentLeadsTag: string;
  hasToken: boolean;
  /** When provided, rendered as the trigger (double-click to open) instead of the default "Configure GHL" link. */
  children?: React.ReactNode;
}

export default function GhlConfigModal({ clientId, clientName, currentLocationId, currentLeadsTag, hasToken, children }: Props) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [locationId, setLocationId] = useState(currentLocationId);
  const [leadsTag, setLeadsTag] = useState(currentLeadsTag);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if ((!hasToken && !token.trim()) || !locationId.trim()) {
      setError('Both the Private Integration token and Location ID are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = { ghl_location_id: locationId.trim(), ghl_leads_tag: leadsTag.trim() };
      if (token.trim()) body.ghl_token = token.trim();
      const res = await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || 'Failed to save — try again.');
        setSaving(false);
        return;
      }
      window.location.reload();
    } catch {
      setError('Failed to save — try again.');
      setSaving(false);
    }
  }

  return (
    <>
      {children ? (
        <span
          onDoubleClick={() => setOpen(true)}
          title="Double-click to configure GHL"
          className="cursor-pointer"
        >
          {children}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-xs text-blue-400 hover:text-blue-300 underline decoration-dotted"
        >
          Configure GHL
        </button>
      )}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !saving && setOpen(false)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-white mb-1">Configure GoHighLevel</h3>
            <p className="text-sm text-slate-400 mb-4">{clientName}</p>

            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Private Integration Token
              {hasToken && <span className="ml-1 text-slate-500 font-normal">(leave blank to keep current)</span>}
            </label>
            <textarea
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder={hasToken ? '••••••••  (token is stored — paste a new one to replace)' : 'pit-…'}
              rows={2}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono resize-none mb-3"
            />

            <label className="block text-xs font-medium text-slate-400 mb-1.5">Location ID</label>
            <input
              type="text"
              value={locationId}
              onChange={e => setLocationId(e.target.value)}
              placeholder="ImpeLA9D5A19bjdUsRvq"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono mb-3"
            />

            <label className="block text-xs font-medium text-slate-400 mb-1.5">
              Leads Tag
              <span className="ml-1 text-slate-500 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={leadsTag}
              onChange={e => setLeadsTag(e.target.value)}
              placeholder="e.g. web lead"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono mb-1"
            />
            <p className="text-xs text-slate-500 mb-4">
              A contact counts as a lead when it carries this tag OR has an attributed campaign. Leave blank to count only attributed contacts. Different clients can use different tags (e.g. per-offer tags).
            </p>

            {error && <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-3">{error}</p>}

            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={saving}
                className="px-4 py-2 text-sm text-slate-300 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
