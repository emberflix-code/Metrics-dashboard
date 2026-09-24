// Session gate for the marketer area (/marketer pages and /api/marketer/*).
// Admins and marketers both get in; clients never do. Kept separate from
// the per-client scope helpers in lib/meta.ts because a marketer session
// has no client_users row and therefore no single-client scope — the
// marketer module resolves its own agency-wide scope (see marketerScope.ts).
import { getServerSession, type Session } from 'next-auth';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { authOptions } from './auth';
import { query } from './db';

export async function getMarketerSession(): Promise<Session | null> {
  const session = await getServerSession(authOptions);
  if (!session) return null;
  const role = session.user.role;
  if (role !== 'admin' && role !== 'marketer') return null;
  // Sessions are JWTs, so a removed marketer login would otherwise keep
  // working until the token expires. One indexed lookup per request makes
  // "Remove" on the admin settings page take effect immediately (and also
  // drops a token whose role was changed since it was issued).
  const [row] = await query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [session.user.id]);
  if (!row || row.role !== role) return null;
  return session;
}

/** For server pages: redirects to /login when the session isn't admin/marketer. */
export async function requireMarketerSession(): Promise<Session> {
  const session = await getMarketerSession();
  if (!session) redirect('/login');
  return session;
}

/** For API routes. */
export function marketerUnauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
