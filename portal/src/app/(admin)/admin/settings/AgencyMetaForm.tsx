'use client';

import { useState } from 'react';

interface AdAccount {
  id: string;
  name: string;
  account_id: string;
}

export default function AgencyMetaForm({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<AdAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleFetchAccounts() {
    if (!token.trim()) { setFetchError('Enter an access token first'); return; }
    setFetching(true);
    setFetchError('');
    setAccounts([]);
    setSelected(new Set());
    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id&access_token=${encodeURIComponent(token.trim())}&limit=100`
      );
      const data = await res.json();
      if (data.error) { setFetchError(data.error.message); setFetching(false); return; }
      const list: AdAccount[] = data.data ?? [];
      setAccounts(list);
      setSelected(new Set(list.map((a: AdAccount) => a.account_id)));
    } catch {
      setFetchError('Failed to reach Meta API');
    }
    setFetching(false);
  }

  function toggleAccount(accountId: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(accountId) ? next.delete(accountId) : next.add(accountId);
      return next;
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setErrorMsg('');

    if (!token.trim() && !hasToken) { setErrorMsg('Access token is required'); setStatus('error'); return; }
    if (selected.size === 0 && accounts.length > 0) { setErrorMsg('Select at least one ad account'); setStatus('error'); return; }

    const ad_account_ids = accounts.length > 0
      ? Array.from(selected)
      : [];

    if (!token.trim() && ad_account_ids.length === 0) {
      setErrorMsg('Fetch and select at least one ad account');
      setStatus('error');
      return;
    }

    try {
      const res = await fetch('/api/admin/settings/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token.trim(), ad_account_ids }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error || 'Failed to save'); setStatus('error'); return; }
      setToken('');
      setAccounts([]);
      setSelected(new Set());
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
        <div className="flex items-center justify-between mb-1.5">
          <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider">
            Ad Accounts
          </label>
          <button
            type="button"
            onClick={handleFetchAccounts}
            disabled={fetching}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 border border-slate-700 hover:border-slate-600 px-2.5 py-1 rounded-lg transition-colors"
          >
            {fetching ? 'Fetching...' : '⟳ Fetch from Meta'}
          </button>
        </div>

        {fetchError && (
          <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 mb-2">{fetchError}</p>
        )}

        {accounts.length > 0 && (
          <div className="bg-slate-800 border border-slate-700 rounded-lg divide-y divide-slate-700/50">
            <div className="px-3 py-2 flex items-center justify-between">
              <span className="text-xs text-slate-400">{accounts.length} account{accounts.length !== 1 ? 's' : ''} found</span>
              <div className="flex gap-3">
                <button type="button" onClick={() => setSelected(new Set(accounts.map(a => a.account_id)))} className="text-xs text-blue-400 hover:text-blue-300">Select all</button>
                <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-slate-400 hover:text-white">Clear</button>
              </div>
            </div>
            {accounts.map(acc => (
              <label key={acc.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-700/30">
                <input
                  type="checkbox"
                  checked={selected.has(acc.account_id)}
                  onChange={() => toggleAccount(acc.account_id)}
                  className="accent-blue-500"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{acc.name}</p>
                  <p className="text-xs text-slate-400 font-mono">act_{acc.account_id}</p>
                </div>
              </label>
            ))}
          </div>
        )}

        {accounts.length === 0 && (
          <p className="text-xs text-slate-500">Paste your token above and click <span className="text-slate-400">Fetch from Meta</span> to auto-load your ad accounts.</p>
        )}
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
