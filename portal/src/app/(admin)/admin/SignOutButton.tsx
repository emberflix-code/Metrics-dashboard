'use client';

import { signOut } from 'next-auth/react';

export function SignOutButton() {
  return (
    <button
      onClick={async () => { await signOut({ redirect: false }); window.location.href = '/login'; }}
      className="text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors"
    >
      Sign out
    </button>
  );
}
