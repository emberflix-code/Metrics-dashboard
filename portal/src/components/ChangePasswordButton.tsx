'use client';

import { useState } from 'react';

export function ChangePasswordButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  function reset() {
    setCurrent(''); setNext(''); setConfirm(''); setStatus('idle'); setError('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (next.length < 6) { setError('New password must be at least 6 characters.'); return; }
    if (next !== confirm) { setError('New password and confirmation do not match.'); return; }
    setStatus('saving');
    try {
      const res = await fetch('/api/account/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to change password'); setStatus('error'); return; }
      setStatus('saved');
      setTimeout(() => { setOpen(false); reset(); }, 1200);
    } catch {
      setError('Network error');
      setStatus('error');
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { reset(); setOpen(true); }}
        className={className ?? 'text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors'}
      >
        Change password
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
          onClick={() => { if (status !== 'saving') { setOpen(false); reset(); } }}
        >
          <div
            className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-xl shadow-2xl p-6"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-white mb-1">Change password</h2>
            <p className="text-xs text-slate-400 mb-5">Enter your current password and choose a new one.</p>

            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Current password</label>
                <input
                  type="password"
                  value={current}
                  onChange={e => setCurrent(e.target.value)}
                  autoFocus
                  required
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">New password</label>
                <input
                  type="password"
                  value={next}
                  onChange={e => setNext(e.target.value)}
                  required
                  minLength={6}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">Confirm new password</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  minLength={6}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              {error && (
                <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
              )}
              {status === 'saved' && (
                <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">Password updated.</p>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={status === 'saving'}
                  onClick={() => { setOpen(false); reset(); }}
                  className="text-sm text-slate-400 hover:text-white px-3 py-2 rounded-lg disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={status === 'saving'}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
                >
                  {status === 'saving' ? 'Saving…' : 'Update password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
