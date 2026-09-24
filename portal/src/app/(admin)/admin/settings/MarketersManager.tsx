'use client';

import { useEffect, useState } from 'react';

interface Marketer { id: string; email: string; created_at: string }

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';

// Admin UI for marketing-specialist logins (role = 'marketer'): list, add,
// reset password, remove. Mirrors the client-side patterns used by the
// other settings managers (fetch + optimistic status text).
export default function MarketersManager() {
  const [list, setList] = useState<Marketer[] | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  async function load() {
    try {
      const res = await fetch('/api/admin/marketers');
      const data = await res.json();
      setList(res.ok ? data.marketers : []);
    } catch { setList([]); }
  }
  useEffect(() => { load(); }, []);

  function flash(msg: string) { setNotice(msg); setTimeout(() => setNotice(''), 3000); }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setStatus('saving');
    try {
      const res = await fetch('/api/admin/marketers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to add'); return; }
      setEmail(''); setPassword('');
      flash(`Added ${data.marketer.email}. They can sign in at /login and will land on /marketer.`);
      await load();
    } catch { setError('Network error'); }
    finally { setStatus('idle'); }
  }

  async function reset(id: string) {
    setError('');
    if (resetPassword.length < 6) { setError('Password must be at least 6 characters.'); return; }
    const res = await fetch(`/api/admin/marketers/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: resetPassword }),
    });
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Failed to reset'); return; }
    setResetFor(null); setResetPassword('');
    flash('Password updated.');
  }

  async function remove(m: Marketer) {
    if (!window.confirm(`Remove marketer login ${m.email}? They will be signed out and unable to log in.`)) return;
    const res = await fetch(`/api/admin/marketers/${m.id}`, { method: 'DELETE' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d.error || 'Failed to remove'); return; }
    flash(`Removed ${m.email}.`);
    await load();
  }

  return (
    <div className="space-y-5">
      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="specialist@agency.com" required className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1.5">Password</label>
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters" minLength={6} required className={inputCls} />
        </div>
        <button type="submit" disabled={status === 'saving'}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors">
          {status === 'saving' ? 'Adding…' : '+ Add specialist'}
        </button>
      </form>

      {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>}
      {notice && <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">{notice}</p>}

      <div className="border border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wider text-slate-500 bg-slate-900/60">
            <tr>
              <th className="text-left px-3 py-2">Email</th>
              <th className="text-left px-3 py-2">Added</th>
              <th className="text-right px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {list === null && <tr><td colSpan={3} className="px-3 py-3 text-slate-500">Loading…</td></tr>}
            {list?.length === 0 && <tr><td colSpan={3} className="px-3 py-3 text-slate-500">No marketing specialists yet.</td></tr>}
            {list?.map(m => (
              <tr key={m.id} className="align-top">
                <td className="px-3 py-2 text-white font-mono text-xs">{m.email}</td>
                <td className="px-3 py-2 text-slate-400 text-xs">{new Date(m.created_at).toLocaleDateString()}</td>
                <td className="px-3 py-2">
                  {resetFor === m.id ? (
                    <div className="flex items-center gap-2 justify-end">
                      <input type="password" autoFocus value={resetPassword} onChange={e => setResetPassword(e.target.value)}
                        placeholder="New password" minLength={6} className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white w-40 focus:outline-none focus:border-blue-500" />
                      <button type="button" onClick={() => reset(m.id)} className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg">Save</button>
                      <button type="button" onClick={() => { setResetFor(null); setResetPassword(''); }} className="text-xs px-2 py-1 text-slate-400 hover:text-white">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 justify-end">
                      <button type="button" onClick={() => { setResetFor(m.id); setError(''); }} className="text-xs text-slate-300 hover:text-white">Reset password</button>
                      <button type="button" onClick={() => remove(m)} className="text-xs text-red-400 hover:text-red-300">Remove</button>
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
