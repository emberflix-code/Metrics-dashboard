import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import bcrypt from 'bcryptjs';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { name, email, password } = await req.json();
  if (!name || !email || !password) {
    return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 });
  }

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length > 0) {
    return NextResponse.json({ error: 'A user with that email already exists' }, { status: 409 });
  }

  const hash = await bcrypt.hash(password, 12);

  // Create client, user, and link them in one transaction
  const [client] = await query<{ id: string }>(`
    WITH new_client AS (
      INSERT INTO clients (name) VALUES ($1) RETURNING id
    ),
    new_user AS (
      INSERT INTO users (email, password_hash, role) VALUES ($2, $3, 'client') RETURNING id
    )
    INSERT INTO client_users (client_id, user_id)
    SELECT new_client.id, new_user.id FROM new_client, new_user
    RETURNING client_id AS id
  `, [name, email, hash]);

  // Alloy locations are aggregated into the "Alloy Ops" umbrella client via
  // its sheet_tab pipe-separated list (see lib/sheets.ts) rather than a
  // parent/child schema relationship, so a new Alloy client is invisible to
  // that dashboard until someone manually appends its sheet tab there.
  let alloyOpsId: string | null = null;
  if (/alloy/i.test(name) && !/alloy ops/i.test(name)) {
    const [alloyOps] = await query<{ id: string }>(
      `SELECT id FROM clients WHERE name ILIKE 'Alloy Ops' AND id != $1 LIMIT 1`,
      [client.id]
    );
    alloyOpsId = alloyOps?.id ?? null;
  }

  return NextResponse.json({ id: client.id, alloyOpsId }, { status: 201 });
}
