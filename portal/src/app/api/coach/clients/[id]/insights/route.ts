import { NextRequest, NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { assertCoachOwnsClient } from '@/lib/coach/scope';
import { resolveRequestRange } from '@/lib/coach/dateRange';
import { buildInsightReport } from '@/lib/insights/engine';
import { buildClientInsightInput } from '@/lib/insights/serverInputs';
import { isGoogleOnlyClient } from '@/lib/meta';
import { query } from '@/lib/db';

// Written Meta analysis of one of the coach's clients for the board's date
// range — same rules as the client dashboard's Insights tab, from the cache.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  if (!(await assertCoachOwnsClient(ctx, params.id))) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { since, until } = resolveRequestRange(body?.range);

  const [c] = await query<{ ad_account_ids: string[] | null; campaign_filter: string; google_data_source: string; leads_source: string }>(
    `SELECT ad_account_ids, campaign_filter, google_data_source, leads_source FROM clients WHERE id = $1`, [params.id]);
  if (!c || isGoogleOnlyClient({ ad_account_ids: c.ad_account_ids, google_data_source: c.google_data_source })) {
    return NextResponse.json({ noMeta: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const input = await buildClientInsightInput(
      { adAccountIds: c.ad_account_ids || [], campaignFilter: c.campaign_filter || '', googleDataSource: c.google_data_source }, since, until);
    const report = buildInsightReport(input);
    const syncRow = await query<{ d: string | null }>(
      `SELECT to_char(MIN(last_success_until), 'YYYY-MM-DD') AS d FROM agency_meta_sync_state WHERE account_id = ANY($1)`,
      [Array.from(new Set(input.rows.map(r => String(r.id).split('|')[0])))]).catch(() => []);
    return NextResponse.json({ report, leadsSource: c.leads_source || 'meta', cachedThrough: syncRow[0]?.d || null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[COACH-INSIGHTS-ERR]', JSON.stringify({ clientId: params.id, message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
