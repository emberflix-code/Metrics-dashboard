import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { getGoogleBreakdowns } from '@/lib/googleAds';

// Keyword / Promo / Headline / Description breakdowns for the client's Google
// Ads dashboard (google_data_source = 'api'), over ?since=&until= (YYYY-MM-DD).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const since = req.nextUrl.searchParams.get('since') || '';
  const until = req.nextUrl.searchParams.get('until') || '';
  if (!DATE_RE.test(since) || !DATE_RE.test(until)) {
    return NextResponse.json({ error: 'since and until must be YYYY-MM-DD' }, { status: 400 });
  }

  const [client] = await query<{ google_data_source: string; google_ads_customer_ids: string[] | null; google_campaign_filter: string }>(
    `SELECT c.google_data_source, c.google_ads_customer_ids, c.google_campaign_filter
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );
  if (client?.google_data_source !== 'api' || !client.google_ads_customer_ids?.length) {
    return NextResponse.json({ keywords: [], promos: [], headlines: [], descriptions: [] });
  }

  try {
    return NextResponse.json(await getGoogleBreakdowns(client.google_ads_customer_ids, client.google_campaign_filter, since, until));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GOOGLE-ADS-ERR]', JSON.stringify({ step: 'breakdowns', message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
