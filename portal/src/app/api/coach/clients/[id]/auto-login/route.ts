import { NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { assertCoachOwnsClient } from '@/lib/coach/scope';
import { query } from '@/lib/db';

// The client's existing auto-login link, for the board's "Copy link" button.
// Read-only on purpose: coaches can never generate or rotate a token (that
// would break the link already embedded in the client's GHL menu).
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  if (!(await assertCoachOwnsClient(ctx, params.id))) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const [row] = await query<{ auto_login_token: string | null }>(
    `SELECT u.auto_login_token FROM client_users cu JOIN users u ON u.id = cu.user_id
     WHERE cu.client_id = $1 AND u.auto_login_token IS NOT NULL LIMIT 1`,
    [params.id]
  );
  const origin = (process.env.NEXTAUTH_URL || 'https://gym-members-now.info').replace(/\/$/, '');
  return NextResponse.json(
    { url: row?.auto_login_token ? `${origin}/auto-login?token=${row.auto_login_token}` : null },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
