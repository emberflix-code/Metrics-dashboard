// Session gate for the coach board (/coach pages and /api/coach/*).
// Coaches and admins get in. A coach only ever sees the clients whose
// clients.coach_name lists their users.coach_name (see coach/scope.ts);
// admins see every client and can filter by coach.
import { getServerSession, type Session } from 'next-auth';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { authOptions } from './auth';
import { query } from './db';

export interface CoachContext {
  session: Session;
  isAdmin: boolean;
  /** users.coach_name for coaches ('' = no clients); always '' for admins. */
  coachName: string;
}

export async function getCoachSession(): Promise<CoachContext | null> {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const role = session.user.role;
  if (role !== 'admin' && role !== 'coach') return null;
  // Same reasoning as marketerAuth: JWT sessions outlive a removed or
  // re-roled login, so re-check the role (and read the coach name, which
  // an admin can change) on every request.
  const [row] = await query<{ role: string; coach_name: string }>(
    `SELECT role, coach_name FROM users WHERE id = $1`,
    [session.user.id]
  );
  if (!row || row.role !== role) return null;
  return { session, isAdmin: role === 'admin', coachName: role === 'coach' ? (row.coach_name || '').trim() : '' };
}

/** For server pages: redirects to /login when the session isn't admin/coach. */
export async function requireCoachSession(): Promise<CoachContext> {
  const ctx = await getCoachSession();
  if (!ctx) redirect('/login');
  return ctx;
}

/** For API routes. */
export function coachUnauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
