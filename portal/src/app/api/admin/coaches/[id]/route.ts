import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import bcrypt from 'bcryptjs';

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'admin' ? session : null;
}

// Scoped to role = 'coach' in every statement so this route can never touch
// an admin, marketer or client login by id. PATCH takes { password?, coachName? }.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (body?.password !== undefined) {
    const password = String(body.password);
    if (password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
    const hash = await bcrypt.hash(password, 12);
    const rows = await query(`UPDATE users SET password_hash = $1 WHERE id = $2 AND role = 'coach' RETURNING id`, [hash, params.id]);
    if (rows.length === 0) return NextResponse.json({ error: 'Coach not found' }, { status: 404 });
  }
  if (body?.coachName !== undefined) {
    const coachName = String(body.coachName).trim();
    if (!coachName) return NextResponse.json({ error: 'Coach name is required' }, { status: 400 });
    const rows = await query(`UPDATE users SET coach_name = $1 WHERE id = $2 AND role = 'coach' RETURNING id`, [coachName, params.id]);
    if (rows.length === 0) return NextResponse.json({ error: 'Coach not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await query(`DELETE FROM users WHERE id = $1 AND role = 'coach' RETURNING id`, [params.id]);
  if (rows.length === 0) return NextResponse.json({ error: 'Coach not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
