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
     WHERE u.auto_login_token = $1 AND u.role = 'client'
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

  const res = NextResponse.json({ ok: true });
  res.cookies.set('__Secure-next-auth.session-token', jwt, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge,
  });

  return res;
}
