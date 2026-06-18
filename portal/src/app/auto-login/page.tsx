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
        if (r.ok) router.replace('/dashboard');
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
