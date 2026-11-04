import { NextRequest, NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { assertCoachOwnsClient } from '@/lib/coach/scope';
import { query } from '@/lib/db';
import { isGoogleOnlyClient } from '@/lib/meta';
import { clientLogin, setImpersonationCookie, startImpersonationAudit } from '@/lib/impersonation';

// Coach board "View dashboard": open one of the coach's own clients as that
// client. Same mechanics as admin impersonation (lib/impersonation.ts) but
// scoped to the coach's clients, audited, shorter-lived, and marked
// role:'coach' so the dashboard never shows admin-only views to a coach.
// Admins can use it too (from the board), with their usual 8h session.
export async function POST(req: NextRequest) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  if (ctx.session.user.impersonatedBy) {
    return NextResponse.json({ error: 'Already viewing a client — go back first' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const clientId = String(body.clientId || '').trim();
  // 404 (not 403) outside the coach's scope so ids of other coaches' clients aren't confirmed.
  if (!(await assertCoachOwnsClient(ctx, clientId))) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const [client] = await query<{ active: boolean; ad_account_ids: string[] | null; google_data_source: string }>(
    `SELECT active, ad_account_ids, google_data_source FROM clients WHERE id = $1`, [clientId]);
  if (!client || (!client.active && !ctx.isAdmin)) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const login = await clientLogin(clientId);
  if (!login) return NextResponse.json({ error: 'This client has no login yet' }, { status: 404 });
  if (!process.env.NEXTAUTH_SECRET) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const role = ctx.isAdmin ? 'admin' : 'coach';
  const user = ctx.session.user;
  const auditId = await startImpersonationAudit({
    actorId: user.id, actorEmail: user.email || '', actorRole: role, clientId, clientName: login.client_name,
    source: 'coach_board', ip: req.headers.get('x-forwarded-for'), userAgent: req.headers.get('user-agent'),
  });

  const res = NextResponse.json({ ok: true, redirect: isGoogleOnlyClient(client) ? '/dashboard/google' : '/dashboard' });
  await setImpersonationCookie(res, login, { id: user.id, email: user.email || '', role, returnTo: '/coach', auditId },
    (ctx.isAdmin ? 8 : 4) * 60 * 60);
  return res;
}
