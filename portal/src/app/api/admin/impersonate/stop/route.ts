import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { encode } from 'next-auth/jwt';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

interface UserRow {
  id: string;
  email: string;
  role: 'admin' | 'client';
}

// End impersonation: read impersonatedBy off the current session, verify that
// user still exists as an admin, and mint a fresh admin session token to swap
// back to. If the marker isn't present the caller wasn't impersonating —
// return 400 rather than silently clearing the cookie so we notice bugs.
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const original = session.user.impersonatedBy;
  if (!original?.id) {
    return NextResponse.json({ error: 'Not currently impersonating' }, { status: 400 });
  }

  const [admin] = await query<UserRow>(
    `SELECT id, email, role FROM users WHERE id = $1 LIMIT 1`,
    [original.id]
  );
  if (!admin || admin.role !== 'admin') {
    return NextResponse.json({ error: 'Original admin no longer exists' }, { status: 404 });
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const jwt = await encode({
    token: {
      id: admin.id,
      email: admin.email,
      role: 'admin',
      clientId: null,
    },
    secret,
    maxAge: 30 * 24 * 60 * 60,
  });

  const isProd = (process.env.NEXTAUTH_URL || '').startsWith('https://');
  const cookieName = isProd ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
  const res = NextResponse.json({ ok: true, redirect: '/admin' });
  res.cookies.set(cookieName, jwt, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
