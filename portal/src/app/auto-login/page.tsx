'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function AutoLoginInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get('token');

  useEffect(() => {
    if (!token) { router.replace('/login'); return; }
    fetch(`/api/auto-login?token=${encodeURIComponent(token)}`)
      .then(r => {
        // Forward the token as _al so the dashboard's Refresh button can
        // clear cookies and re-enter through this same flow without the
        // client needing to re-click their GHL menu link — see the Refresh
        // button in DashboardClient.tsx for where this gets used.
        if (r.ok) router.replace(`/dashboard?_al=${encodeURIComponent(token)}`);
        else router.replace('/login');
      })
      .catch(() => router.replace('/login'));
  }, [token, router]);

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="text-slate-400 text-sm">Signing you in…</div>
    </div>
  );
}

export default function AutoLoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-sm">Loading…</div>
      </div>
    }>
      <AutoLoginInner />
    </Suspense>
  );
}
