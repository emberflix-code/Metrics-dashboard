import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import bcrypt from 'bcryptjs';

interface UserRow {
  password_hash: string;
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { current_password, new_password } = await req.json();
  if (typeof current_password !== 'string' || typeof new_password !== 'string') {
    return NextResponse.json({ error: 'current_password and new_password are required' }, { status: 400 });
  }
  if (new_password.length < 6) {
    return NextResponse.json({ error: 'New password must be at least 6 characters.' }, { status: 400 });
  }

  const [user] = await query<UserRow>('SELECT password_hash FROM users WHERE id = $1', [session.user.id]);
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });

  const hash = await bcrypt.hash(new_password, 12);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, session.user.id]);

  return NextResponse.json({ ok: true });
}
