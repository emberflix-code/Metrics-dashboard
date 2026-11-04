import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { listCoachNames } from '@/lib/coach/scope';
import bcrypt from 'bcryptjs';

// GMN coach logins (users.role = 'coach'). Admin-only. A coach sees only the
// clients whose clients.coach_name lists users.coach_name (see coach/scope.ts),
// so the name must match the GMN Coach column exactly (case-insensitive).
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COACH_MATCH = `EXISTS (SELECT 1 FROM unnest(string_to_array(c.coach_name, ',')) AS n WHERE lower(btrim(n)) = lower(btrim(u.coach_name)))`;

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  return session && session.user.role === 'admin' ? session : null;
}

export async function GET() {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [coaches, names] = await Promise.all([
    query<{ id: string; email: string; coach_name: string; created_at: string; client_count: string }>(
      `SELECT u.id, u.email, u.coach_name, u.created_at,
              (SELECT COUNT(*) FROM clients c WHERE c.active AND u.coach_name <> '' AND ${COACH_MATCH})::text AS client_count
       FROM users u WHERE u.role = 'coach' ORDER BY u.created_at DESC`
    ),
    listCoachNames(),
  ]);
  return NextResponse.json({ coaches: coaches.map(c => ({ ...c, client_count: Number(c.client_count) })), coachNames: names }, NO_STORE);
}

export async function POST(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const email = String(body?.email || '').toLowerCase().trim();
  const password = String(body?.password || '');
  const coachName = String(body?.coachName || '').trim();
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: 'Password must be at least 8 characters' }, { status: 400 });
  if (!coachName) return NextResponse.json({ error: 'Coach name is required (as it appears in the GMN Coach column)' }, { status: 400 });

  // Never silently convert an existing client/admin/marketer login into a coach.
  const [existing] = await query<{ role: string }>(`SELECT role FROM users WHERE email = $1`, [email]);
  if (existing) return NextResponse.json({ error: `That email already has a ${existing.role} login` }, { status: 409 });

  const hash = await bcrypt.hash(password, 12);
  const [row] = await query<{ id: string; email: string; coach_name: string; created_at: string }>(
    `INSERT INTO users (email, password_hash, role, coach_name) VALUES ($1, $2, 'coach', $3) RETURNING id, email, coach_name, created_at`,
    [email, hash, coachName]
  );
  return NextResponse.json({ ok: true, coach: row }, { status: 201 });
}
