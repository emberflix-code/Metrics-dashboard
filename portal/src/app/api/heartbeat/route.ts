import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';

// Presence ping for the admin Monitoring page's Live badge — see the
// client_heartbeats/client_heartbeat_events comment in lib/db.ts for the
// two-table rationale. Called every ~30s by DashboardClient.tsx while its
// tab is open and visible (not while backgrounded — see the visibilitychange
// gating there), so an admin-impersonation view intentionally pings under
// the CLIENT being impersonated's own id (same as every other client-scoped
// route), not the admin's.
//
// Retention: rather than a separate cron, each heartbeat piggybacks a cheap
// delete of its own history older than 7 days — self-pruning with no extra
// moving parts, safe to run on every ping since it's a single indexed
// DELETE ... WHERE seen_at < $1 with no rows to scan for a normal-sized table.
const HISTORY_RETENTION_DAYS = 7;

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const path = typeof body?.path === 'string' ? body.path.slice(0, 200) : '';

  const [row] = await query<{ client_id: string }>(
    `SELECT client_id FROM client_users WHERE user_id = $1 LIMIT 1`,
    [session.user.id]
  );
  if (!row) return NextResponse.json({ error: 'No client for this session' }, { status: 404 });

  await query(
    `INSERT INTO client_heartbeats (client_id, last_seen_at, last_path)
     VALUES ($1, NOW(), $2)
     ON CONFLICT (client_id) DO UPDATE SET last_seen_at = NOW(), last_path = $2`,
    [row.client_id, path]
  );
  await query(
    `INSERT INTO client_heartbeat_events (client_id, path) VALUES ($1, $2)`,
    [row.client_id, path]
  );
  await query(
    `DELETE FROM client_heartbeat_events WHERE client_id = $1 AND seen_at < NOW() - INTERVAL '${HISTORY_RETENTION_DAYS} days'`,
    [row.client_id]
  );

  return NextResponse.json({ ok: true });
}
