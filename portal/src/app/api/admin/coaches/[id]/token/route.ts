import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { randomBytes } from 'crypto';

// Generate (or rotate) a coach's auto-login link token. Admin-only, scoped to
// role = 'coach'. The link signs the coach straight into their board, so it
// is a password-equivalent: rotating it here invalidates the old link.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const token = randomBytes(32).toString('hex');
  const rows = await query(`UPDATE users SET auto_login_token = $1 WHERE id = $2 AND role = 'coach' RETURNING id`, [token, params.id]);
  if (rows.length === 0) return NextResponse.json({ error: 'Coach not found' }, { status: 404 });
  return NextResponse.json({ token });
}
