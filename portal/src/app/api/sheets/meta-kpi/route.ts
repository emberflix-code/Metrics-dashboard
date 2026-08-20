import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { fetchMetaKpiSheetRows } from '@/lib/metaKpiSheet';
import { SheetError } from '@/lib/sheets';

// Reads the client's "Meta KPI sheet" (Campaign Type, Offer, Location Name,
// State, Landing Page, Bookings, Joins — fields Meta's API doesn't carry).
// Filtering by those five dimensions happens client-side in
// DashboardClient.tsx (the row count is small, a few hundred/month at
// most), so this route just returns the full row set once per load rather
// than accepting filter params — same shape as /api/sheets/meta.

interface ClientConfig {
  meta_kpi_sheet_id: string;
  meta_kpi_sheet_tab: string;
  show_meta_kpi_sheet: boolean;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [client] = await query<ClientConfig>(
    `SELECT c.meta_kpi_sheet_id, c.meta_kpi_sheet_tab, c.show_meta_kpi_sheet
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  // Gate: only return rows when the admin has explicitly opted this client
  // in. Without this, any client with the sheet columns populated would
  // silently start showing Bookings/Joins cards the moment they loaded the
  // dashboard — the whole reason those cards are pushed conditionally in
  // renderCards() rather than always present-but-empty.
  if (!client?.show_meta_kpi_sheet || !client?.meta_kpi_sheet_id || !client?.meta_kpi_sheet_tab) {
    return NextResponse.json({ rows: [], enabled: false });
  }

  try {
    const { rows } = await fetchMetaKpiSheetRows(client.meta_kpi_sheet_id, client.meta_kpi_sheet_tab);
    return NextResponse.json({ rows, enabled: true });
  } catch (err) {
    if (err instanceof SheetError) {
      console.error('[SHEET-ERR]', JSON.stringify({ clientMetaKpiSheetTab: client.meta_kpi_sheet_tab, code: err.code, message: err.message }));
      return NextResponse.json({ error: err.message, enabled: true }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, enabled: true }, { status: 500 });
  }
}
