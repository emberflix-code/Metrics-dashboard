import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { encode } from 'next-auth/jwt';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

interface ClientUserRow {
  user_id: string;
  email: string;
  client_id: string;
}

// Start impersonation: admin picks a client, we mint a fresh session token as
// that client's user, but stash the admin's id/email inside so the return-to-
// admin flow can restore the original session. Cookie config mirrors authOptions
// so the token round-trips correctly (HTTPS Secure/SameSite=None in prod,
// plain SameSite=Lax in dev).
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Nested impersonation is not supported — an already-impersonating admin
  // must return to admin first.
  if (session.user.impersonatedBy) {
    return NextResponse.json({ error: 'Already impersonating — return to admin first' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const clientId = String(body.clientId || '').trim();
  if (!clientId) return NextResponse.json({ error: 'Missing clientId' }, { status: 400 });

  const [row] = await query<ClientUserRow>(
    `SELECT cu.user_id, u.email, cu.client_id
     FROM client_users cu
     JOIN users u ON u.id = cu.user_id
     WHERE cu.client_id = $1
     LIMIT 1`,
    [clientId]
  );
  if (!row) return NextResponse.json({ error: 'Client user not found' }, { status: 404 });

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const jwt = await encode({
    token: {
      id: row.user_id,
      email: row.email,
      role: 'client',
      clientId: row.client_id,
      impersonatedBy: { id: session.user.id, email: session.user.email || '' },
    },
    secret,
    // 8h — long enough for a real support session, short enough to force a
    // fresh admin sign-in before the day ends.
    maxAge: 8 * 60 * 60,
  });

  const isProd = (process.env.NEXTAUTH_URL || '').startsWith('https://');
  const cookieName = isProd ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
  const res = NextResponse.json({ ok: true, redirect: '/dashboard' });
  res.cookies.set(cookieName, jwt, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: 8 * 60 * 60,
  });
  return res;
}
