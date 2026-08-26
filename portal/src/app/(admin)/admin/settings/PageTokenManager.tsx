'use client';

import { useEffect, useState } from 'react';

export default function PageTokenManager() {
  const [connected, setConnected] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function reload() {
    const res = await fetch('/api/admin/settings/page-token');
    const j = await res.json();
    setConnected(!!j.connected);
    setUpdatedAt(j.updated_at ?? null);
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

  async function save() {
    if (!token.trim()) { setMsg('Paste a token first'); return; }
    setBusy(true); setMsg('');
    try {
      const res = await fetch('/api/admin/settings/page-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token.trim() }),
      });
      const j = await res.json();
      if (j.error) { setMsg(j.error); setBusy(false); return; }
      setToken('');
      setMsg('Saved.');
      await reload();
    } catch {
      setMsg('Failed to save.');
    }
    setBusy(false);
  }

  if (loading) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-600'}`} />
        <span className="text-slate-300">{connected ? 'Connected' : 'Not connected'}</span>
        {updatedAt && <span className="text-slate-500">— last updated {new Date(updatedAt).toLocaleString()}</span>}
      </div>
      <p className="text-xs text-slate-500">
        A System User token with Page-level &ldquo;Partial access&rdquo; (Ads + Insights toggled on) for each Page whose ads you want this fallback to cover. Used only to recover a full-resolution image for creatives whose ad exposes nothing but a tiny thumbnail — never used for anything else.
      </p>
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder={connected ? 'Paste a new token to replace it' : 'Paste System User access token'}
          className="flex-1 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
        />
        <button
          onClick={save}
          disabled={busy}
          className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg"
        >{busy ? 'Saving…' : 'Save'}</button>
      </div>
      {msg && <p className="text-xs text-slate-400">{msg}</p>}
    </div>
  );
}