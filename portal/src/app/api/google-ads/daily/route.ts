import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { getGoogleDailyRows } from '@/lib/googleAds';

// The client's Google Ads dashboard data from the Google Ads API cache
// (google_ads_daily). Same row shape as /api/sheets/google plus joins,
// bookings, campaign status and id, so DashboardClient's Google loader reads
// either source. Only for clients with google_data_source = 'api'.

interface ClientConfig {
  google_data_source: string;
  google_ads_customer_ids: string[] | null;
  google_campaign_filter: string;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [client] = await query<ClientConfig>(
    `SELECT c.google_data_source, c.google_ads_customer_ids, c.google_campaign_filter
     FROM clients c
     JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1
     LIMIT 1`,
    [session.user.id]
  );

  if (client?.google_data_source !== 'api' || !client.google_ads_customer_ids?.length) {
    return NextResponse.json({ rows: [] });
  }

  try {
    const { rows, syncedThrough } = await getGoogleDailyRows(client.google_ads_customer_ids, client.google_campaign_filter);
    return NextResponse.json({ rows, syncedThrough });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GOOGLE-ADS-ERR]', JSON.stringify({ step: 'daily', message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
