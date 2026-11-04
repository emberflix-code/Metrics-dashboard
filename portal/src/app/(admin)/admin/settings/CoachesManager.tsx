'use client';

import { useEffect, useState } from 'react';

interface Coach { id: string; email: string; coach_name: string; created_at: string; client_count: number; auto_login_token: string | null }

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';

// Admin UI for GMN coach logins (role = 'coach'): list, add, rename, reset
// password, remove. The coach name links the login to clients — it must
// match the GMN Coach column (picked from the names already on clients).
export default function CoachesManager() {
  const [list, setList] = useState<Coach[] | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [coachName, setCoachName] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editFor, setEditFor] = useState<{ id: string; field: 'password' | 'name' } | null>(null);
  const [editValue, setEditValue] = useState('');

  async function load() {
    try {
      const res = await fetch('/api/admin/coaches');
      const data = await res.json();
      setList(res.ok ? data.coaches : []);
      setNames(res.ok ? data.coachNames : []);
    } catch { setList([]); }
  }
  useEffect(() => { load(); }, []);

  function flash(msg: string) { setNotice(msg); setTimeout(() => setNotice(''), 4000); }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setStatus('saving');
    try {
      const res = await fetch('/api/admin/coaches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, coachName }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to add'); return; }
      setEmail(''); setPassword(''); setCoachName('');
      flash(`Added ${data.coach.email}. They sign in at /login and land on the coach board.`);
      await load();
    } catch { setError('Network error'); }
    finally { setStatus('idle'); }
  }

  async function saveEdit(id: string) {
    if (!editFor) return;
    setError('');
    if (editFor.field === 'password' && editValue.length < 8) { setError('Password must be at least 8 characters.'); return; }
    const res = await fetch(`/api/admin/coaches/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editFor.field === 'password' ? { password: editValue } : { coachName: editValue }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Failed to save'); return; }
    setEditFor(null); setEditValue('');
    flash(editFor.field === 'password' ? 'Password updated.' : 'Coach name updated.');
    await load();
  }

  // Auto-login link = signs the coach straight into their board (no password),
  // so treat it like a password: Rotate invalidates the old link.
  const linkFor = (token: string) => `${window.location.origin}/auto-login?token=${token}`;
  async function copyLink(c: Coach) {
    if (!c.auto_login_token) return;
    await navigator.clipboard.writeText(linkFor(c.auto_login_token)).catch(() => {});
    flash(`Copied ${c.email}'s auto-login link.`);
  }
  async function generateLink(c: Coach) {
    if (c.auto_login_token && !window.confirm(`Rotate ${c.email}'s auto-login link? The old link stops working.`)) return;
    const res = await fetch(`/api/admin/coaches/${c.id}/token`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Failed to generate link'); return; }
    await navigator.clipboard.writeText(linkFor(data.token)).catch(() => {});
    flash(`New auto-login link for ${c.email} copied to the clipboard.`);
    await load();
  }

  async function remove(c: Coach) {
    if (!window.confirm(`Remove coach login ${c.email}? They will be signed out and unable to log in.`)) return;
    const res = await fetch(`/api/admin/coaches/${c.id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to remove'); return; }
    flash(`Removed ${c.email}.`);
    await load();
  }

  const nameMatches = coachName.trim() !== '' && names.some(n => n.toLowerCase() === coachName.trim().toLowerCase());

  return (
    <div className="space-y-5">
      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="coach@gym-members-now.com" required className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Coach name <span className="text-slate-500">(as in GMN Coach)</span></label>
          <input list="coach-names" value={coachName} onChange={e => setCoachName(e.target.value)} placeholder="Brad Meyer" required className={inputCls} />
          <datalist id="coach-names">{names.map(n => <option key={n} value={n} />)}</datalist>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" minLength={8} required className={inputCls} />
        </div>
        <button type="submit" disabled={status === 'saving'}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
          {status === 'saving' ? 'Adding…' : '+ Add coach'}
        </button>
      </form>
      {coachName.trim() !== '' && !nameMatches && (
        <p className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
          No client lists &ldquo;{coachName.trim()}&rdquo; as GMN Coach yet — this coach would see an empty board. Pick a name from the list to match exactly.
        </p>
      )}

      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
      {notice && <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{notice}</p>}

      <div className="border border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-slate-500 bg-slate-900/60">
            <tr>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Coach name</th>
              <th className="text-right px-3 py-2">Active clients</th>
              <th className="text-left px-3 py-2">Auto-login link</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {list === null && <tr><td colSpan={5} className="px-3 py-3 text-slate-500">Loading…</td></tr>}
            {list?.length === 0 && <tr><td colSpan={5} className="px-3 py-3 text-slate-500">No coaches yet.</td></tr>}
            {list?.map(c => (
              <tr key={c.id} className="align-top">
                <td className="px-3 py-2 text-white font-mono text-xs">{c.email}</td>
                <td className="px-3 py-2 text-slate-300 text-xs">{c.coach_name || <span className="text-amber-300">not set</span>}</td>
                <td className={`px-3 py-2 text-right text-xs font-mono ${c.client_count === 0 ? 'text-amber-300' : 'text-slate-300'}`}>{c.client_count}</td>
                <td className="px-3 py-2 text-xs whitespace-nowrap">
                  {c.auto_login_token ? (
                    <span className="flex items-center gap-2">
                      <button type="button" onClick={() => copyLink(c)} className="px-2 py-1 rounded-md border border-slate-700 text-slate-200 hover:border-slate-500">Copy link</button>
                      <button type="button" onClick={() => generateLink(c)} className="text-slate-400 hover:text-white">Rotate</button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => generateLink(c)} className="px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white">Generate link</button>
                  )}
                </td>
                <td className="px-3 py-2">
                  {editFor?.id === c.id ? (
                    <div className="flex items-center gap-2 justify-end">
                      <input type={editFor.field === 'password' ? 'password' : 'text'} list={editFor.field === 'name' ? 'coach-names' : undefined}
                        autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                        placeholder={editFor.field === 'password' ? 'New password' : 'Coach name'}
                        className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white w-44 focus:outline-none focus:border-blue-500" />
                      <button type="button" onClick={() => saveEdit(c.id)} className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg">Save</button>
                      <button type="button" onClick={() => { setEditFor(null); setEditValue(''); }} className="text-xs px-2 py-1 text-slate-400 hover:text-white">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 justify-end">
                      <button type="button" onClick={() => { setEditFor({ id: c.id, field: 'name' }); setEditValue(c.coach_name); setError(''); }} className="text-xs text-slate-300 hover:text-white">Rename</button>
                      <button type="button" onClick={() => { setEditFor({ id: c.id, field: 'password' }); setEditValue(''); setError(''); }} className="text-xs text-slate-300 hover:text-white">Reset password</button>
                      <button type="button" onClick={() => remove(c)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
