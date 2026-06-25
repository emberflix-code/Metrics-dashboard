'use client';

import { useState } from 'react';

interface AgencyAccount {
  id: string;
  name: string;
  bmLabel?: string;
}

interface Props {
  clientId: string;
  agencyAccounts: AgencyAccount[];
  currentAccountIds: string[];
}

export default function AdAccountSelector({ clientId, agencyAccounts, currentAccountIds }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set(currentAccountIds));
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  async function handleSave() {
    setStatus('saving');
    setErrorMsg('');
    try {
      const res = await fetch(`/api/admin/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ad_account_ids: Array.from(selected) }),
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

  if (agencyAccounts.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No ad accounts configured yet. Add them in{' '}
        <a href="/admin/settings" className="text-blue-400 hover:text-blue-300 underline">Agency Settings</a>.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="bg-slate-800 border border-slate-700 rounded-lg divide-y divide-slate-700/50">
        <div className="px-3 py-2 flex items-center justify-between">
          <span className="text-xs text-slate-400">{selected.size} of {agencyAccounts.length} selected</span>
          <div className="flex gap-3">
            <button type="button" onClick={() => setSelected(new Set(agencyAccounts.map(a => a.id)))} className="text-xs text-blue-400 hover:text-blue-300">All</button>
            <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-slate-400 hover:text-white">None</button>
          </div>
        </div>
        {(() => {
          // Group accounts by BM label so admins can see which BM owns each.
          const groups: Record<string, AgencyAccount[]> = {};
          for (const acc of agencyAccounts) {
            const key = acc.bmLabel || 'Default';
            (groups[key] ||= []).push(acc);
          }
          return Object.entries(groups).map(([bmLabel, accs]) => (
            <div key={bmLabel}>
              {Object.keys(groups).length > 1 && (
                <div className="px-3 py-1.5 bg-slate-800/60 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{bmLabel}</div>
              )}
              {accs.map(acc => (
                <label key={acc.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-slate-700/30 border-t border-slate-700/50 first:border-t-0">
                  <input
                    type="checkbox"
                    checked={selected.has(acc.id)}
                    onChange={() => toggle(acc.id)}
                    className="accent-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    {acc.name && <p className="text-sm text-white">{acc.name}</p>}
                    <p className={`font-mono ${acc.name ? 'text-xs text-slate-400' : 'text-sm text-slate-200'}`}>act_{acc.id}</p>
                  </div>
                </label>
              ))}
            </div>
          ));
        })()}
      </div>

      {errorMsg && (
        <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{errorMsg}</p>
      )}
      {status === 'saved' && (
        <p className="text-sm text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">Saved</p>
      )}

      <button
        onClick={handleSave}
        disabled={status === 'saving'}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
      >
        {status === 'saving' ? 'Saving...' : 'Save Ad Accounts'}
      </button>
    </div>
  );
}
