import { redirect } from 'next/navigation';
import { query } from '@/lib/db';
import { encode } from 'next-auth/jwt';
import { cookies } from 'next/headers';

interface UserRow {
  id: string;
  email: string;
  role: 'admin' | 'client';
  client_id: string | null;
}

export default async function AutoLoginPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams.token;
  if (!token) redirect('/login');

  const [user] = await query<UserRow>(
    `SELECT u.id, u.email, u.role, cu.client_id
     FROM users u
     LEFT JOIN client_users cu ON cu.user_id = u.id
     WHERE u.auto_login_token = $1 AND u.role = 'client'
     LIMIT 1`,
    [token]
  );

  if (!user) redirect('/login');

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

  const cookieStore = cookies();
  cookieStore.set('__Secure-next-auth.session-token', jwt, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge,
  });

  redirect('/dashboard');
}
