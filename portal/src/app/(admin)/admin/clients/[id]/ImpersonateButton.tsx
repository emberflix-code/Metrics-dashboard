'use client';

import { useState } from 'react';

export default function ImpersonateButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/impersonate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Failed to start session');
        setLoading(false);
        return;
      }
      // Hard nav so the freshly-set session cookie is what next-auth reads.
      window.location.href = json.redirect || '/dashboard';
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start session');
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {loading ? 'Opening dashboard…' : `View ${clientName}'s dashboard`}
      </button>
      {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
    </div>
  );
}
