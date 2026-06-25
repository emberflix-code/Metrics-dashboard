import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { fetchSheetRows, SheetError } from '@/lib/sheets';

// Reads the client's Google Ads dashboard data from `clients.google_sheet_tab`.
// Same shape as /api/sheets/meta but no `use_sheet_for_leads` gate — the
// Google sub-dashboard is always sheet-driven when a tab is configured.
// The tab spec can be a literal name or `<prefix> *` to aggregate.

interface ClientConfig {
  sheet_id: string;
  google_sheet_tab: string;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [client] = await query<ClientConfig>(
    `SELECT c.sheet_id, c.google_sheet_tab
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  if (!client?.sheet_id || !client?.google_sheet_tab) {
    return NextResponse.json({ rows: [] });
  }

  try {
    const { rows, mode, tabsFetched, failedTabs } = await fetchSheetRows(client.sheet_id, client.google_sheet_tab);
    return NextResponse.json({ rows, mode, tabsFetched, failedTabs });
  } catch (err) {
    if (err instanceof SheetError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
