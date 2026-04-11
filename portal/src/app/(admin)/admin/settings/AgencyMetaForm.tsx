'use client';

import { useState } from 'react';

export default function AgencyMetaForm({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setErrorMsg('');

    const ad_account_ids = accounts
      .split(/[\n,]+/)
      .map(s => s.trim().replace(/^act_/i, ''))
      .filter(Boolean);

    if (!token.trim()) { setErrorMsg('Access token is required'); setStatus('error'); return; }
    if (ad_account_ids.length === 0) { setErrorMsg('At least one ad account ID is required'); setStatus('error'); return; }

    try {
      const res = await fetch('/api/admin/settings/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token.trim(), ad_account_ids }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error || 'Failed to save'); setStatus('error'); return; }
      setToken('');
      setAccounts('');
      setStatus('saved');
      setTimeout(() => window.location.reload(), 800);
    } catch {
      setErrorMsg('Network error');
      setStatus('error');
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          Access Token {hasToken && <span className="text-slate-500 normal-case font-normal">(leave blank to keep existing)</span>}
        </label>
        <textarea
          value={token}
          onChange={e => setToken(e.target.value)}
          placeholder="EAABwzLixnjYBO..."
          rows={3}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono resize-none"
        />
        <p className="text-xs text-slate-500 mt-1">
          Get a long-lived system user token from Meta Business Suite → System Users → Generate Token.
          Needs <code className="text-slate-400">ads_read</code> and <code className="text-slate-400">ads_management</code> permissions.
        </p>
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          Ad Account IDs
        </label>
        <textarea
          value={accounts}
          onChange={e => setAccounts(e.target.value)}
          placeholder={"123456789\n987654321"}
          rows={3}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-mono resize-none"
        />
        <p className="text-xs text-slate-500 mt-1">One per line or comma-separated. With or without <code className="text-slate-400">act_</code> prefix.</p>
      </div>

      {errorMsg && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{errorMsg}</p>
      )}
      {status === 'saved' && (
        <p className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">Saved successfully</p>
      )}

      <button
        type="submit"
        disabled={status === 'saving'}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
      >
        {status === 'saving' ? 'Saving...' : hasToken ? 'Update Connection' : 'Save Connection'}
      </button>
    </form>
  );
}
