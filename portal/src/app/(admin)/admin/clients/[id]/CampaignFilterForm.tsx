'use client';

import { useState } from 'react';

interface Props {
  clientId: string;
  currentFilter: string;
}

export default function CampaignFilterForm({ clientId, currentFilter }: Props) {
  const [filter, setFilter] = useState(currentFilter);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign_filter: filter }),
      });
      const data = await res.json();
      if (!res.ok) { setErrorMsg(data.error || 'Failed to save'); setStatus('error'); return; }
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 2000);
    } catch {
      setErrorMsg('Network error');
      setStatus('error');
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
          Campaign Name Keyword
        </label>
        <input
          type="text"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="e.g. Acme, [GMN], FitLife"
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
        <p className="text-xs text-slate-500 mt-1">
          Matches anywhere in the campaign name. Example: <code className="text-slate-400">Acme</code> will match{' '}
          <code className="text-slate-400">Acme - Lead Gen Q1</code> and{' '}
          <code className="text-slate-400">[Acme] Retargeting</code>.
        </p>
      </div>

      {errorMsg && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{errorMsg}</p>
      )}
      {status === 'saved' && (
        <p className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">Saved</p>
      )}

      <button
        type="submit"
        disabled={status === 'saving'}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
      >
        {status === 'saving' ? 'Saving...' : 'Save Filter'}
      </button>
    </form>
  );
}
