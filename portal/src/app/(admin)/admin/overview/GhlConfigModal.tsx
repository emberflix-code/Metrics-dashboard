'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  clientName: string;
  currentLocationId: string;
}

export default function GhlConfigModal({ clientId, clientName, currentLocationId }: Props) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [locationId, setLocationId] = useState(currentLocationId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!token.trim() || !locationId.trim()) {
      setError('Both the Private Integration token and Location ID are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ghl_token: token.trim(), ghl_location_id: locationId.trim() }),
      });
      if (!res.ok) { setError('Failed to save — try again.'); setSaving(false); return; }
      window.location.reload();
    } catch {
      setError('Failed to save — try again.');
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-blue-400 hover:text-blue-300 underline decoration-dotted"
      >
        Configure GHL
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => !saving && setOpen(false)}>
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-white mb-1">Configure GoHighLevel</h3>
            <p className="text-sm text-slate-400 mb-4">{clientName}</p>

            <label className="block text-xs font-medium text-slate-400 mb-1.5">Private Integration Token</label>
            <textarea
              value={token}
              onChange={e => setToken(e.target.value)}
              placeholder="pit-…"
              rows={2}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono resize-none mb-3"
            />

            <label className="block text-xs font-medium text-slate-400 mb-1.5">Location ID</label>
            <input
              type="text"
              value={locationId}
              onChange={e => setLocationId(e.target.value)}
              placeholder="ImpeLA9D5A19bjdUsRvq"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono mb-1"
            />
            <p className="text-xs text-slate-500 mb-4">
              Generate the token in GHL Settings → Private Integrations (needs at least <span className="font-mono text-slate-400">contacts.readonly</span>). Full configuration, including the Bookings KPI toggle, is on the client&apos;s manage page.
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
