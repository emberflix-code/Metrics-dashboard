import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { endImpersonationAudit, safeReturnTo, setSessionCookie, sessionCookieName } from '@/lib/impersonation';

interface UserRow {
  id: string;
  email: string;
  role: string;
}

// End impersonation: read impersonatedBy off the current session, look the
// original user up in the DB (never trust the token's claim about who they
// were) and mint a fresh session for them — admin back to the client config
// page (or the coach board, if started there), coach back to /coach. If the
// marker isn't present the caller wasn't impersonating — return 400 rather
// than silently clearing the cookie so we notice bugs.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const original = session.user.impersonatedBy;
  if (!original?.id) {
    return NextResponse.json({ error: 'Not currently impersonating' }, { status: 400 });
  }

  const [user] = await query<UserRow>(`SELECT id, email, role FROM users WHERE id = $1 LIMIT 1`, [original.id]);
  if (!process.env.NEXTAUTH_SECRET) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  await endImpersonationAudit(original.auditId);

  if (!user || (user.role !== 'admin' && user.role !== 'coach')) {
    // The original login was removed (or re-roled) meanwhile: just sign out.
    const res = NextResponse.json({ error: 'Original login no longer exists', redirect: '/login' }, { status: 404 });
    res.cookies.set(sessionCookieName(), '', { path: '/', maxAge: 0 });
    return res;
  }

  let redirect: string;
  if (user.role === 'coach') {
    redirect = '/coach';
  } else {
    // Land back on the config page of the client that was being viewed (that's
    // where the "View dashboard" button lives), not the full client list. The
    // UUID check keeps a malformed clientId from ever reaching the URL.
    const viewedClientId = session.user.clientId;
    const fallback = viewedClientId && /^[0-9a-f-]{36}$/i.test(viewedClientId) ? `/admin/clients/${viewedClientId}` : '/admin';
    redirect = safeReturnTo(original.returnTo, fallback);
  }

  const res = NextResponse.json({ ok: true, redirect });
  await setSessionCookie(res, { id: user.id, email: user.email, role: user.role as 'admin' | 'coach', clientId: null }, 30 * 24 * 60 * 60);
  return res;
}
