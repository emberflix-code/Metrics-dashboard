import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import bcrypt from 'bcryptjs';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'admin' ? session : null;
}

// Scoped to role = 'marketer' in every statement so this route can never
// touch an admin or client login by id.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const password = String(body?.password || '');
  if (password.length < 6) return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });
  const hash = await bcrypt.hash(password, 12);
  const rows = await query<{ id: string }>(
    `UPDATE users SET password_hash = $1 WHERE id = $2 AND role = 'marketer' RETURNING id`,
    [hash, params.id]
  );
  if (rows.length === 0) return NextResponse.json({ error: 'Marketer not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await query<{ id: string }>(
    `DELETE FROM users WHERE id = $1 AND role = 'marketer' RETURNING id`,
    [params.id]
  );
  if (rows.length === 0) return NextResponse.json({ error: 'Marketer not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
