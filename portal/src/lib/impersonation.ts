// "View as client" plumbing shared by admin impersonation (client config
// page) and coach impersonation (coach board): mint the client session
// cookie with an impersonatedBy marker, and keep an audit trail.
// Cookie config mirrors authOptions so the token round-trips (HTTPS
// Secure/SameSite=None in prod for the GHL iframe, plain Lax in dev).
import { NextResponse } from 'next/server';
import { encode, type JWT } from 'next-auth/jwt';
import { query } from './db';
import type { ImpersonatedBy } from '@/types/next-auth';

export function sessionCookieName(): string {
  return (process.env.NEXTAUTH_URL || '').startsWith('https://') ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
}

export async function setSessionCookie(res: NextResponse, token: JWT, maxAgeSeconds: number): Promise<void> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error('Server misconfigured');
  const jwt = await encode({ token, secret, maxAge: maxAgeSeconds });
  const isProd = (process.env.NEXTAUTH_URL || '').startsWith('https://');
  res.cookies.set(sessionCookieName(), jwt, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export interface ClientLoginRow { user_id: string; email: string; client_id: string; client_name: string }

/** The client's (first) login — impersonation signs in as this user. */
export async function clientLogin(clientId: string): Promise<ClientLoginRow | null> {
  const [row] = await query<ClientLoginRow>(
    `SELECT cu.user_id, u.email, cu.client_id, c.name AS client_name
     FROM client_users cu JOIN users u ON u.id = cu.user_id JOIN clients c ON c.id = cu.client_id
     WHERE cu.client_id = $1
     LIMIT 1`,
    [clientId]
  );
  return row ?? null;
}

export async function startImpersonationAudit(opts: {
  actorId: string; actorEmail: string; actorRole: 'admin' | 'coach'; clientId: string; clientName: string;
  source: 'admin_config' | 'coach_board'; ip?: string | null; userAgent?: string | null;
}): Promise<number | undefined> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO impersonation_audit (actor_id, actor_email, actor_role, client_id, client_name, source, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [opts.actorId, opts.actorEmail, opts.actorRole, opts.clientId, opts.clientName, opts.source,
      opts.ip ?? null, (opts.userAgent ?? '').slice(0, 300) || null]
  ).catch(() => [] as { id: string }[]);
  return row ? Number(row.id) : undefined;
}

export async function endImpersonationAudit(auditId: number | undefined): Promise<void> {
  if (!auditId) return;
  await query(`UPDATE impersonation_audit SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`, [auditId]).catch(() => {});
}

/** Session cookie for viewing a client's dashboard, marked with who started it. */
export async function setImpersonationCookie(res: NextResponse, login: ClientLoginRow, by: ImpersonatedBy, maxAgeSeconds: number): Promise<void> {
  await setSessionCookie(res, {
    id: login.user_id,
    email: login.email,
    role: 'client',
    clientId: login.client_id,
    impersonatedBy: by,
  } as JWT, maxAgeSeconds);
}

/** Only these "Back" destinations are honoured, whatever the token says. */
export function safeReturnTo(returnTo: string | undefined, fallback: string): string {
  if (!returnTo) return fallback;
  if (returnTo === '/coach' || returnTo === '/admin') return returnTo;
  if (/^\/admin\/clients\/[0-9a-f-]{36}$/i.test(returnTo)) return returnTo;
  return fallback;
}
