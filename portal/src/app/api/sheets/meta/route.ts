import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { fetchSheetRows, SheetError } from '@/lib/sheets';

// Reads the client's Meta-side leads from the sheet tab configured at
// `clients.sheet_tab`. Used by the Meta dashboard when `use_sheet_for_leads`
// is on so the KPI Leads card reflects canonical sheet counts rather than
// Meta's pixel events. The tab spec can be a literal name or a `<prefix> *`
// to aggregate every tab matching that prefix (see lib/sheets.ts).

interface ClientConfig {
  sheet_id: string;
  sheet_tab: string;
  use_sheet_for_leads: boolean;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [client] = await query<ClientConfig>(
    `SELECT c.sheet_id, c.sheet_tab, c.use_sheet_for_leads
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  // Gate: only return rows when the admin has explicitly opted this client in.
  // Without the gate, every client with a `sheet_tab` populated would silently
  // switch lead sources the moment they loaded the dashboard.
  if (!client?.use_sheet_for_leads || !client?.sheet_id || !client?.sheet_tab) {
    return NextResponse.json({ rows: [], enabled: false });
  }

  try {
    const { rows, mode, tabsFetched, failedTabs } = await fetchSheetRows(client.sheet_id, client.sheet_tab);
    return NextResponse.json({ rows, enabled: true, mode, tabsFetched, failedTabs });
  } catch (err) {
    if (err instanceof SheetError) {
      return NextResponse.json({ error: err.message, enabled: true }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, enabled: true }, { status: 500 });
  }
}
