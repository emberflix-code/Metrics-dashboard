import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { encode } from 'next-auth/jwt';

interface UserRow {
  id: string;
  email: string;
  role: 'admin' | 'client';
  client_id: string | null;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'Missing token' }, { status: 400 });

  const [user] = await query<UserRow>(
    `SELECT u.id, u.email, u.role, cu.client_id
     FROM users u
     LEFT JOIN client_users cu ON cu.user_id = u.id
     WHERE u.auto_login_token = $1 AND u.role IN ('client', 'admin')
     LIMIT 1`,
    [token]
  );

  if (!user) return NextResponse.json({ error: 'Invalid token' }, { status: 401 });

  const secret = process.env.NEXTAUTH_SECRET!;
  const maxAge = 30 * 24 * 60 * 60; // 30 days

  const jwt = await encode({
    token: {
      sub: user.id,
      id: user.id,
      email: user.email,
      role: user.role,
      clientId: user.client_id,
    },
    secret,
    maxAge,
  });

  // Prod (HTTPS): cookie must be SameSite=None; Secure for GHL iframe embed.
  // Dev (HTTP localhost): browsers reject Secure cookies on plain HTTP, so
  // fall back to non-Secure/SameSite=lax when not on HTTPS — matches auth.ts.
  const isProd = (process.env.NEXTAUTH_URL || '').startsWith('https://');
  const cookieName = isProd ? '__Secure-next-auth.session-token' : 'next-auth.session-token';

  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookieName, jwt, {
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    path: '/',
    maxAge,
  });

  return res;
}
