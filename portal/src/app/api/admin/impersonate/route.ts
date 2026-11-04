import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { clientLogin, setImpersonationCookie, startImpersonationAudit } from '@/lib/impersonation';

// Start impersonation: admin picks a client, we mint a fresh session token as
// that client's user, but stash the admin's id/email inside so the return-to-
// admin flow can restore the original session (see lib/impersonation.ts).
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Nested impersonation is not supported — an already-impersonating admin
  // must return to admin first.
  if (session.user.impersonatedBy) {
    return NextResponse.json({ error: 'Already impersonating — return to admin first' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const clientId = String(body.clientId || '').trim();
  if (!clientId) return NextResponse.json({ error: 'Missing clientId' }, { status: 400 });
  // Started from the coach board → "Back" returns there; otherwise to the client config page.
  const returnTo = body.from === 'coach_board' ? '/coach' : `/admin/clients/${clientId}`;

  const login = await clientLogin(clientId);
  if (!login) return NextResponse.json({ error: 'Client user not found' }, { status: 404 });
  if (!process.env.NEXTAUTH_SECRET) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const auditId = await startImpersonationAudit({
    actorId: session.user.id, actorEmail: session.user.email || '', actorRole: 'admin',
    clientId, clientName: login.client_name, source: body.from === 'coach_board' ? 'coach_board' : 'admin_config',
    ip: req.headers.get('x-forwarded-for'), userAgent: req.headers.get('user-agent'),
  });
  const res = NextResponse.json({ ok: true, redirect: body.redirect === '/dashboard/google' ? '/dashboard/google' : '/dashboard' });
  // 8h — long enough for a real support session, short enough to force a
  // fresh admin sign-in before the day ends.
  await setImpersonationCookie(res, login, { id: session.user.id, email: session.user.email || '', role: 'admin', returnTo, auditId }, 8 * 60 * 60);
  return res;
}
