import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { fetchMetaKpiSheetRows, MetaKpiSheetRow } from '@/lib/metaKpiSheet';
import { SheetError } from '@/lib/sheets';

// Reads the client's "Meta KPI sheet" (Campaign Type, Offer, Location Name,
// State, Landing Page, Bookings, Joins — fields Meta's API doesn't carry).
//
// The sheet is organized as ONE TAB PER MONTH (client_meta_kpi_sheet_tabs:
// one admin-entered {month, tab_name} row per calendar month), not one tab
// covering all time — so a request spanning multiple months may need
// several tab fetches. For any month with no configured tab, or whose live
// fetch fails, this falls back to meta_kpi_sheet_cache (populated by the
// normal "Sync now" flow — see metaSync.ts's syncMetaKpiSheetCache) so the
// dashboard shows the last-synced data instead of a gap.
//
// `since`/`until` are optional — when omitted, every month this client has
// EITHER a configured tab OR any cached rows is returned. DashboardClient
// uses this omitted-range form specifically to populate the filter-bar
// dropdown options with all-time distinct values (see a70fbbe), and the
// date-scoped form for the KPI card totals.

interface ClientConfig {
  meta_kpi_sheet_id: string;
  show_meta_kpi_sheet: boolean;
}

function monthsInRange(since: string, until: string): string[] {
  const months: string[] = [];
  const [sy, sm] = since.split('-').map(Number);
  const [ey, em] = until.split('-').map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [client, clientRow] = await Promise.all([
    query<ClientConfig>(
      `SELECT c.meta_kpi_sheet_id, c.show_meta_kpi_sheet
       FROM clients c
       JOIN client_users cu ON cu.client_id = c.id
       WHERE cu.user_id = $1
       LIMIT 1`,
      [session.user.id]
    ).then(r => r[0]),
    query<{ id: string }>(
      `SELECT c.id FROM clients c JOIN client_users cu ON cu.client_id = c.id WHERE cu.user_id = $1 LIMIT 1`,
      [session.user.id]
    ).then(r => r[0]),
  ]);
  const clientId = clientRow?.id;

  // Gate: only proceed when the admin has explicitly opted this client in.
  // Without this, any client with meta_kpi_sheet_id populated would
  // silently start showing Bookings/Joins cards — the whole reason those
  // cards are pushed conditionally in renderCards() rather than
  // always-present-but-empty.
  if (!client?.show_meta_kpi_sheet || !client?.meta_kpi_sheet_id || !clientId) {
    return NextResponse.json({ rows: [], enabled: false });
  }

  const sp = req.nextUrl.searchParams;
  const since = sp.get('since');
  const until = sp.get('until');

  const tabRows = await query<{ month: string; tab_name: string }>(
    `SELECT to_char(month, 'YYYY-MM-DD') AS month, tab_name FROM client_meta_kpi_sheet_tabs WHERE client_id = $1`,
    [clientId]
  );
  const tabByMonth = new Map(tabRows.map(r => [r.month.slice(0, 7), r.tab_name]));

  // No explicit range: cover every month with a configured tab OR any
  // cached data (used by the filter-bar's all-time dropdown population —
  // see the module comment above).
  let months: string[];
  if (since && until) {
    months = monthsInRange(since, until);
  } else {
    const cachedMonths = await query<{ month: string }>(
      `SELECT DISTINCT to_char(date_trunc('month', day), 'YYYY-MM-DD') AS month FROM meta_kpi_sheet_cache WHERE client_id = $1`,
      [clientId]
    );
    months = Array.from(new Set([...tabRows.map(r => r.month), ...cachedMonths.map(r => r.month)]));
  }

  const rows: MetaKpiSheetRow[] = [];
  let anyError: string | null = null;

  for (const month of months) {
    const tabName = tabByMonth.get(month.slice(0, 7));
    let monthRows: MetaKpiSheetRow[] | null = null;

    if (tabName) {
      try {
        const result = await fetchMetaKpiSheetRows(client.meta_kpi_sheet_id, tabName);
        monthRows = result.rows;
      } catch (err) {
        const message = err instanceof SheetError ? err.message : (err instanceof Error ? err.message : 'Unknown error');
        console.error('[SHEET-ERR]', JSON.stringify({ clientId, month, tab: tabName, code: err instanceof SheetError ? err.code : undefined, message }));
        if (!anyError) anyError = message;
      }
    }

    // Fall back to cache when there's no tab configured for this month, or
    // the live fetch above failed.
    if (monthRows === null) {
      const monthStart = month;
      const [y, m] = month.split('-').map(Number);
      const nextMonth = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
      const cached = await query<{
        day: string; campaign: string; spend: string; results: number; bookings: number; joins: number;
        campaign_type: string; offer: string; location_name: string; state: string; landing_page: string;
      }>(
        `SELECT day::text AS day, campaign, spend::text AS spend, results, bookings, joins,
                campaign_type, offer, location_name, state, landing_page
         FROM meta_kpi_sheet_cache
         WHERE client_id = $1 AND day >= $2::date AND day < $3::date`,
        [clientId, monthStart, nextMonth]
      );
      monthRows = cached.map(r => ({
        campaign: r.campaign,
        day: r.day,
        spend: Number(r.spend),
        results: r.results,
        bookings: r.bookings,
        joins: r.joins,
        campaignType: r.campaign_type,
        offer: r.offer,
        locationName: r.location_name,
        state: r.state,
        landingPage: r.landing_page,
      }));
    }

    rows.push(...monthRows);
  }

  return NextResponse.json({ rows, enabled: true, ...(anyError ? { partialError: anyError } : {}) });
}
