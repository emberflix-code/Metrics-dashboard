'use client';

import { useEffect, useState } from 'react';

interface BmConnection {
  id: string;
  label: string;
  account_ids: string[];
  accounts_json: { id: string; name?: string }[];
  sort_order: number;
}

interface MetaAdAccount {
  id: string;
  name: string;
  account_id: string;
}

export default function BmConnectionsManager() {
  const [connections, setConnections] = useState<BmConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);

  async function reload() {
    const res = await fetch('/api/admin/bm-connections');
    const j = await res.json();
    setConnections(j.connections || []);
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

  if (loading) return <p className="text-sm text-slate-400">Loading connections…</p>;

  return (
    <div className="space-y-4">
      {connections.length === 0 && (
        <p className="text-sm text-slate-400">No BM connections yet. Add one below to start.</p>
      )}

      {connections.map(c => (
        <ConnectionCard key={c.id} connection={c} onChange={reload} canDelete={connections.length > 1} />
      ))}

      {!showAdd ? (
        <button
          onClick={() => setShowAdd(true)}
          className="w-full text-sm font-semibold text-blue-400 hover:text-blue-300 border border-dashed border-slate-700 hover:border-slate-600 rounded-xl py-3 transition-colors"
        >+ Add another Business Manager</button>
      ) : (
        <AddConnectionForm onSaved={() => { setShowAdd(false); reload(); }} onCancel={() => setShowAdd(false)} />
      )}
    </div>
  );
}

function ConnectionCard({ connection, onChange, canDelete }: { connection: BmConnection; onChange: () => void; canDelete: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(connection.label);
  const [newToken, setNewToken] = useState('');
  const [accounts, setAccounts] = useState<MetaAdAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(connection.account_ids));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const nameById = new Map<string, string>();
  for (const a of connection.accounts_json || []) nameById.set(a.id, a.name || '');

  async function fetchAccounts() {
    if (!newToken.trim()) { setMsg('Enter a token to fetch accounts'); return; }
    setBusy(true); setMsg('');
    try {
      const res = await fetch(`https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id&access_token=${encodeURIComponent(newToken.trim())}&limit=100`);
      const data = await res.json();
      if (data.error) { setMsg(data.error.message); setBusy(false); return; }
      const list: MetaAdAccount[] = data.data ?? [];
      setAccounts(list);
      setSelected(new Set(list.map(a => a.account_id)));
    } catch { setMsg('Failed to reach Meta'); }
    setBusy(false);
  }

  async function save() {
    setBusy(true); setMsg('');
    const body: Record<string, unknown> = { label: label.trim() };
    if (newToken.trim()) body.access_token = newToken.trim();
    // Always send the current selection — if the admin didn't refetch, we keep what's currently selected.
    body.ad_account_ids = Array.from(selected);
    body.ad_accounts = Array.from(selected).map(id => ({
      id,
      name: accounts.find(a => a.account_id === id)?.name || nameById.get(id) || '',
    }));
    const res = await fetch(`/api/admin/bm-connections/${connection.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg(j.error || 'Save failed'); return; }
    setEditing(false); setNewToken(''); setAccounts([]);
    onChange();
  }

  async function remove() {
    if (!confirm(`Delete BM connection "${connection.label}"? Clients scoped to its accounts will lose access.`)) return;
    setBusy(true);
    const res = await fetch(`/api/admin/bm-connections/${connection.id}`, { method: 'DELETE' });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg(j.error || 'Delete failed'); return; }
    onChange();
  }

  return (
    <div className="bg-slate-800/40 border border-slate-700 rounded-xl">
      <div className="flex items-center justify-between p-4">
        <div>
          <div className="text-sm font-semibold text-white">{connection.label}</div>
          <div className="text-xs text-slate-400 mt-0.5">{connection.account_ids.length} ad account{connection.account_ids.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setExpanded(e => !e)} className="text-xs text-slate-400 hover:text-white border border-slate-700 px-3 py-1 rounded">
            {expanded ? 'Hide' : 'View'}
          </button>
          <button onClick={() => { setEditing(e => !e); setExpanded(true); }} className="text-xs text-blue-400 hover:text-blue-300 border border-slate-700 px-3 py-1 rounded">
            {editing ? 'Cancel' : 'Edit'}
          </button>
          {canDelete && (
            <button onClick={remove} disabled={busy} className="text-xs text-red-400 hover:text-red-300 border border-slate-700 px-3 py-1 rounded disabled:opacity-50">Delete</button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-slate-700 p-4 space-y-3">
          {editing && (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Label</label>
                <input value={label} onChange={e => setLabel(e.target.value)} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                  Replace access token <span className="text-slate-500 normal-case font-normal">(leave blank to keep current)</span>
                </label>
                <textarea value={newToken} onChange={e => setNewToken(e.target.value)} rows={2} placeholder="EAABwzLixnjYBO..." className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono resize-none" />
                <button type="button" onClick={fetchAccounts} disabled={busy || !newToken.trim()} className="mt-2 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 border border-slate-700 px-2.5 py-1 rounded">
                  {busy ? 'Fetching...' : '⟳ Fetch accounts from Meta'}
                </button>
              </div>
            </>
          )}

          <div>
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Accounts</p>
            {accounts.length > 0 ? (
              <div className="bg-slate-900 border border-slate-700 rounded-lg divide-y divide-slate-700/50 max-h-64 overflow-y-auto">
                {accounts.map(acc => (
                  <label key={acc.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-700/30">
                    <input type="checkbox" checked={selected.has(acc.account_id)} onChange={() => {
                      const next = new Set(selected);
                      if (next.has(acc.account_id)) next.delete(acc.account_id); else next.add(acc.account_id);
                      setSelected(next);
                    }} className="accent-blue-500" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{acc.name}</p>
                      <p className="text-xs text-slate-500 font-mono">act_{acc.account_id}</p>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {connection.account_ids.length === 0 ? (
                  <p className="text-xs text-slate-500">No accounts on this connection yet.</p>
                ) : connection.account_ids.map(id => (
                  <span key={id} className="text-xs bg-slate-700 text-slate-300 px-2 py-1 rounded font-mono">
                    {nameById.get(id) || `act_${id}`}
                  </span>
                ))}
              </div>
            )}
          </div>

          {msg && <p className="text-sm text-amber-400">{msg}</p>}
          {editing && (
            <button onClick={save} disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">
              {busy ? 'Saving...' : 'Save changes'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AddConnectionForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<MetaAdAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function fetchAccounts() {
    if (!token.trim()) { setMsg('Enter a token first'); return; }
    setBusy(true); setMsg('');
    try {
      const res = await fetch(`https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id&access_token=${encodeURIComponent(token.trim())}&limit=100`);
      const data = await res.json();
      if (data.error) { setMsg(data.error.message); setBusy(false); return; }
      const list: MetaAdAccount[] = data.data ?? [];
      setAccounts(list);
      setSelected(new Set(list.map(a => a.account_id)));
    } catch { setMsg('Failed to reach Meta'); }
    setBusy(false);
  }

  async function save() {
    if (!label.trim()) { setMsg('Label is required'); return; }
    if (!token.trim()) { setMsg('Token is required'); return; }
    if (selected.size === 0) { setMsg('Select at least one ad account'); return; }
    setBusy(true); setMsg('');
    const ad_accounts = Array.from(selected).map(id => ({ id, name: accounts.find(a => a.account_id === id)?.name || '' }));
    const res = await fetch('/api/admin/bm-connections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label.trim(), access_token: token.trim(), ad_account_ids: Array.from(selected), ad_accounts }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setMsg(j.error || 'Save failed'); return; }
    onSaved();
  }

  return (
    <div className="bg-slate-800/40 border border-slate-700 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Add Business Manager</h3>
        <button onClick={onCancel} className="text-xs text-slate-400 hover:text-white">Cancel</button>
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Label</label>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. BM 2 — New Clients" className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
      </div>
      <div>
        <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Access token</label>
        <textarea value={token} onChange={e => setToken(e.target.value)} rows={2} placeholder="EAABwzLixnjYBO..." className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono resize-none" />
        <button type="button" onClick={fetchAccounts} disabled={busy || !token.trim()} className="mt-2 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 border border-slate-700 px-2.5 py-1 rounded">
          {busy ? 'Fetching...' : '⟳ Fetch accounts from Meta'}
        </button>
      </div>
      {accounts.length > 0 && (
        <div className="bg-slate-900 border border-slate-700 rounded-lg divide-y divide-slate-700/50 max-h-64 overflow-y-auto">
          {accounts.map(acc => (
            <label key={acc.id} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-slate-700/30">
              <input type="checkbox" checked={selected.has(acc.account_id)} onChange={() => {
                const next = new Set(selected);
                if (next.has(acc.account_id)) next.delete(acc.account_id); else next.add(acc.account_id);
                setSelected(next);
              }} className="accent-blue-500" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white truncate">{acc.name}</p>
                <p className="text-xs text-slate-500 font-mono">act_{acc.account_id}</p>
              </div>
            </label>
          ))}
        </div>
      )}
      {msg && <p className="text-sm text-amber-400">{msg}</p>}
      <button onClick={save} disabled={busy} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg">
        {busy ? 'Saving...' : 'Save connection'}
      </button>
    </div>
  );
}
