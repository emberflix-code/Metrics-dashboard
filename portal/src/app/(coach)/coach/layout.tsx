import { requireCoachSession } from '@/lib/coachAuth';
import { SignOutButton } from '@/app/(admin)/admin/SignOutButton';
import { ChangePasswordButton } from '@/components/ChangePasswordButton';

// Shell for the coach board. Session gate lives here so every page under
// /coach inherits it; middleware.ts additionally redirects client and
// marketer sessions away before they reach this layout.
export default async function CoachLayout({ children }: { children: React.ReactNode }) {
  const { session, isAdmin, coachName } = await requireCoachSession();

  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800 bg-slate-950/90 backdrop-blur sticky top-0 z-40">
        <div className="max-w-[1800px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-3 mr-2">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600/20 text-emerald-300 text-sm font-bold">C</span>
            <div>
              <p className="text-sm font-semibold text-white leading-tight">Coach board{coachName ? ` — ${coachName}` : ''}</p>
              <p className="text-[11px] text-slate-500 leading-tight">{session.user.email}</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {isAdmin && (
              <a href="/admin" className="text-sm text-slate-300 hover:text-white border border-slate-700 hover:border-slate-600 px-3 py-2 rounded-lg transition-colors">
                ← Admin
              </a>
            )}
            <ChangePasswordButton />
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="max-w-[1800px] mx-auto px-4 sm:px-6 py-6">{children}</main>
    </div>
  );
}
