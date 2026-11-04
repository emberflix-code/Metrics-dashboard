'use client';

import { useState } from 'react';

// Shown at the top of the client dashboard when an admin or a coach is
// viewing as this client. Clicking Back posts to /api/admin/impersonate/stop
// which swaps the session cookie back and redirects — admins to the client's
// config page (or the coach board, if they came from there), coaches to the
// coach board.
export default function ImpersonationBanner({ adminEmail, clientName, actorRole = 'admin', returnTo }: {
  adminEmail: string; clientName: string; actorRole?: 'admin' | 'coach'; returnTo?: string;
}) {
  const backLabel = actorRole === 'coach' || returnTo === '/coach' ? 'Back to coach board' : 'Back to client config';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReturn() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/impersonate/stop', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Failed to return');
        setLoading(false);
        return;
      }
      window.location.href = json.redirect || (actorRole === 'coach' ? '/coach' : '/admin');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to return');
      setLoading(false);
    }
  }

  return (
    <div className="w-full bg-amber-500/10 border-b border-amber-500/40 text-amber-200">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3">
        <div className="text-xs sm:text-sm">
          <span className="font-semibold">Viewing as {clientName}</span>
          <span className="ml-2 text-amber-300/70">(signed in as {adminEmail})</span>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-rose-300">{error}</span>}
          <button
            type="button"
            onClick={handleReturn}
            disabled={loading}
            className="px-3 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded-md disabled:opacity-50"
          >
            {loading ? 'Returning…' : backLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
