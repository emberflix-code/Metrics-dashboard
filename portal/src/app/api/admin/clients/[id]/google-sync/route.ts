import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { syncGoogleAdsCustomer } from '@/lib/googleAds';

// Admin "Sync Google Ads now" — runs the same sync the daily scheduler runs,
// for this client's Google Ads accounts, so a newly configured client doesn't
// wait for the next 6 AM ET run. Read-only against Google.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [client] = await query<{ google_ads_customer_ids: string[] | null }>(
    'SELECT google_ads_customer_ids FROM clients WHERE id = $1',
    [params.id]
  );
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });
  if (!client.google_ads_customer_ids?.length) {
    return NextResponse.json({ error: 'No Google Ads account IDs configured for this client.' }, { status: 400 });
  }

  const results = [];
  for (const customerId of client.google_ads_customer_ids) {
    results.push(await syncGoogleAdsCustomer(customerId));
  }
  return NextResponse.json({ results });
}
