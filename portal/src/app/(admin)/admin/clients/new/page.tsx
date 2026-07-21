'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function NewClientPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [alloyReminder, setAlloyReminder] = useState<{ clientId: string; alloyOpsId: string | null } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Something went wrong'); return; }
      if (/alloy/i.test(form.name) && !/alloy ops/i.test(form.name)) {
        setAlloyReminder({ clientId: data.id, alloyOpsId: data.alloyOpsId ?? null });
        return;
      }
      router.push(`/admin/clients/${data.id}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-lg mx-auto">
        <div className="mb-6">
          <a href="/admin" className="text-sm text-slate-400 hover:text-white">← Back to admin</a>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
          <h1 className="text-lg font-bold text-white mb-1">New Client</h1>
          <p className="text-sm text-slate-400 mb-6">Creates a client record and a login account.</p>

          {alloyReminder ? (
            <div className="p-4 bg-amber-500/10 border border-amber-500/20 rounded-xl text-sm text-amber-300">
              <strong>Client created.</strong> This looks like an Alloy location — Alloy Ops aggregates
              leads across all Alloy locations from a pipe-separated tab list, not automatically.{' '}
              {alloyReminder.alloyOpsId ? (
                <a
                  href={`/admin/clients/${alloyReminder.alloyOpsId}`}
                  className="underline hover:text-amber-200"
                >
                  Add this location&apos;s sheet tab to Alloy Ops now
                </a>
              ) : (
                <span>Remember to add this location&apos;s sheet tab to the Alloy Ops client config.</span>
              )}{' '}
              or{' '}
              <button
                type="button"
                onClick={() => router.push(`/admin/clients/${alloyReminder.clientId}`)}
                className="underline hover:text-amber-200"
              >
                continue to the new client
              </button>
              .
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                  Client / Business Name
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Acme Fitness"
                  required
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                  Login Email
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  placeholder="client@example.com"
                  required
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  value={form.password}
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                  placeholder="Minimum 8 characters"
                  minLength={8}
                  required
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>

              {error && (
                <p className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-lg transition-colors"
              >
                {loading ? 'Creating...' : 'Create Client'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
