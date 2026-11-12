import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { loadBookingDetails } from '@/lib/gmnReport';

export const dynamic = 'force-dynamic';

// The entries behind one location's "Bookings" number in a published GMN Marketing Report month
// (?month=YYYY-MM&location=<location row label>; &kind=sps for its SPS numbers instead). Same access rule as the report page: a client user whose
// client has the report switched on, reading only that client's own published snapshots.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'client') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const [client] = await query<{ id: string; show_gmn_report: boolean }>(
    `SELECT c.id, c.show_gmn_report FROM clients c JOIN client_users cu ON cu.client_id = c.id WHERE cu.user_id = $1 LIMIT 1`,
    [session.user.id]
  ).catch(() => []);
  if (!client?.show_gmn_report) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const month = req.nextUrl.searchParams.get('month') || '';
  const location = req.nextUrl.searchParams.get('location') || '';
  const kind = req.nextUrl.searchParams.get('kind') === 'sps' ? 'sps' : 'bookings';
  const rows = await loadBookingDetails(client.id, month, location, kind);
  if (!rows) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'private, max-age=300' } });
}
