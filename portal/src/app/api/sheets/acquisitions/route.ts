import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { fetchAcquisitionRows } from '@/lib/acquisitionSheet';
import { SheetError } from '@/lib/sheets';
import { proratedRetainerForRange } from '@/lib/retainer';

// Powers the CPA KPI card. Returns won-lead counts by day (from the client's
// configured cpa_sheet_id/cpa_sheet_tab) plus the prorated retainer for the
// requested [since, until] range, so the client only needs to add Meta spend
// to get total cost. Gated on show_cpa — same "admin must opt in explicitly"
// pattern as use_sheet_for_leads (see /api/sheets/meta).

interface ClientConfig {
  id: string;
  cpa_sheet_id: string;
  cpa_sheet_tab: string;
  show_cpa: boolean;
  retainer_mode: 'flat' | 'monthly';
  retainer_flat_amount: number;
}

interface RetainerRow {
  month: string; // DATE, serialized as YYYY-MM-DD (always the 1st)
  amount: string; // NUMERIC comes back as string from pg
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const since = url.searchParams.get('since') ?? '';
  const until = url.searchParams.get('until') ?? '';

  const [client] = await query<ClientConfig>(
    `SELECT c.id, c.cpa_sheet_id, c.cpa_sheet_tab, c.show_cpa, c.retainer_mode, c.retainer_flat_amount
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  if (!client?.show_cpa || !client?.cpa_sheet_id || !client?.cpa_sheet_tab) {
    return NextResponse.json({ rows: [], enabled: false, retainer: 0 });
  }

  let retainer = 0;
  if (since && until) {
    let monthlyAmounts: Record<string, number> = {};
    if (client.retainer_mode === 'monthly') {
      const retainerRows = await query<RetainerRow>(
        `SELECT to_char(month, 'YYYY-MM') AS month, amount FROM client_retainers WHERE client_id = $1`,
        [client.id]
      );
      monthlyAmounts = Object.fromEntries(retainerRows.map(r => [r.month, Number(r.amount)]));
    }
    retainer = proratedRetainerForRange(since, until, {
      mode: client.retainer_mode,
      flatAmount: Number(client.retainer_flat_amount),
      monthlyAmounts,
    });
  }

  try {
    const { rows, tabsFetched, failedTabs } = await fetchAcquisitionRows(client.cpa_sheet_id, client.cpa_sheet_tab);
    const clipped = (since && until) ? rows.filter(r => r.day >= since && r.day <= until) : rows;
    return NextResponse.json({ rows: clipped, enabled: true, retainer, tabsFetched, failedTabs });
  } catch (err) {
    if (err instanceof SheetError) {
      console.error('[CPA-SHEET-ERR]', JSON.stringify({ clientCpaSheetTab: client.cpa_sheet_tab, code: err.code, message: err.message }));
      return NextResponse.json({ error: err.message, enabled: true, retainer }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message, enabled: true, retainer }, { status: 500 });
  }
}
