import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { randomBytes } from 'crypto';

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const token = randomBytes(32).toString('hex');

  const rows = await query<{ id: string }>(
    `UPDATE users SET auto_login_token = $1
     WHERE id IN (SELECT user_id FROM client_users WHERE client_id = $2)
     RETURNING id`,
    [token, params.id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  }

  return NextResponse.json({ token });
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [row] = await query<{ auto_login_token: string | null }>(
    `SELECT u.auto_login_token
     FROM users u
     JOIN client_users cu ON cu.user_id = u.id
     WHERE cu.client_id = $1`,
    [params.id]
  );

  if (!row) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  return NextResponse.json({ token: row.auto_login_token ?? null });
}
