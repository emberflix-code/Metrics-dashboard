import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import bcrypt from 'bcryptjs';

// Marketing-specialist accounts (users.role = 'marketer'). Admin-only.
// They have no client_users row: a marketer sees every active client.
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'admin' ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const rows = await query<{ id: string; email: string; created_at: string }>(
    `SELECT id, email, created_at FROM users WHERE role = 'marketer' ORDER BY created_at DESC`
  );
  return NextResponse.json({ marketers: rows }, NO_STORE);
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const email = String(body?.email || '').toLowerCase().trim();
  const password = String(body?.password || '');
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  if (password.length < 6) return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 });

  // Never silently convert an existing client/admin login into a marketer.
  const [existing] = await query<{ role: string }>(`SELECT role FROM users WHERE email = $1`, [email]);
  if (existing) {
    return NextResponse.json({ error: `That email already has a ${existing.role} login` }, { status: 409 });
  }

  const hash = await bcrypt.hash(password, 12);
  const [row] = await query<{ id: string; email: string; created_at: string }>(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'marketer') RETURNING id, email, created_at`,
    [email, hash]
  );
  return NextResponse.json({ ok: true, marketer: row }, { status: 201 });
}
