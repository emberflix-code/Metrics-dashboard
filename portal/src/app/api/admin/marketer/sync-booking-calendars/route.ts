import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { syncBookingCalendars } from '@/lib/bookingCalendars';

// Re-reads the marketing team's booking-calendar sheet and maps each row to
// a client (lib/bookingCalendars.ts). `?dry=1` reports matches without
// writing. Also runs daily from the sync scheduler.
export async function POST(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const dry = req.nextUrl.searchParams.get('dry') === '1';
  try {
    const report = await syncBookingCalendars({ dry });
    return NextResponse.json({ ok: true, dry, ...report }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 502 });
  }
}
