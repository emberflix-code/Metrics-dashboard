import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { query } from '@/lib/db';

// Dismiss (permanent), snooze (N days), or undo a dismissal of one alert
// key. Keys are stable per finding (see lib/marketer/alerts.ts) so a
// dismissal survives recomputation.
export async function POST(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const body = await req.json().catch(() => ({}));
  const key = String(body?.key || '').trim();
  if (!key || key.length > 500) return NextResponse.json({ error: 'key is required' }, { status: 400 });

  if (body?.undo) {
    await query(`DELETE FROM marketer_alert_dismissals WHERE alert_key = $1`, [key]);
    return NextResponse.json({ ok: true, dismissed: false });
  }
  const snoozeDays = Number(body?.snoozeDays);
  const snoozeUntil = Number.isFinite(snoozeDays) && snoozeDays > 0
    ? new Date(Date.now() + Math.min(90, snoozeDays) * 86_400_000).toISOString()
    : null;
  await query(
    `INSERT INTO marketer_alert_dismissals (alert_key, dismissed_by, dismissed_at, snooze_until)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (alert_key) DO UPDATE SET dismissed_by = EXCLUDED.dismissed_by, dismissed_at = now(), snooze_until = EXCLUDED.snooze_until`,
    [key, session.user.id, snoozeUntil]
  );
  return NextResponse.json({ ok: true, dismissed: true, snoozeUntil });
}
