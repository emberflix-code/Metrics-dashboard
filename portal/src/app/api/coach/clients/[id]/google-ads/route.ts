import { NextRequest, NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { assertCoachOwnsClient } from '@/lib/coach/scope';
import { resolveRequestRange } from '@/lib/coach/dateRange';
import { getGoogleAds } from '@/lib/googleAds';
import { query } from '@/lib/db';

// Google ads (text + numbers for the board's date range) of one of the
// coach's clients, for the board's Ads drawer. Cache only (google_ads_*).
// Clients still on the Google sheet tab have no ad-level data.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  if (!(await assertCoachOwnsClient(ctx, params.id))) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const { since, until } = resolveRequestRange(body?.range);

  const [c] = await query<{ google_data_source: string; google_ads_customer_ids: string[] | null; google_campaign_filter: string; google_sheet_tab: string }>(
    `SELECT google_data_source, google_ads_customer_ids, google_campaign_filter, google_sheet_tab FROM clients WHERE id = $1`, [params.id]);
  if (c?.google_data_source !== 'api' || !c.google_ads_customer_ids?.length) {
    return NextResponse.json({ since, until, ads: [], assets: {}, source: c?.google_sheet_tab ? 'sheet' : 'none' }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const out = await getGoogleAds(c.google_ads_customer_ids, c.google_campaign_filter, since, until);
    return NextResponse.json({ since, until, source: 'api', ...out }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[COACH-GOOGLE-ADS-ERR]', JSON.stringify({ clientId: params.id, message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
