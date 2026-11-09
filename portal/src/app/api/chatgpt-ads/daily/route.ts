import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { getChatgptDashboardData } from '@/lib/chatgptAds';

// The signed-in client's ChatGPT Ads data: ad-level daily rows + campaigns /
// ad groups / ads (with creative text). Cache only, filled by the daily
// scheduler; the page applies the date range client-side.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [client] = await query<{ chatgpt_ads_account_id: string; has_key: boolean }>(
    `SELECT c.chatgpt_ads_account_id, (c.chatgpt_ads_key_enc <> '') AS has_key
     FROM clients c JOIN client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = $1 LIMIT 1`,
    [session.user.id]
  );
  if (!client?.has_key || !client.chatgpt_ads_account_id) return NextResponse.json({ rows: [], levelRows: [], entities: [], syncedThrough: null, timeZone: null });

  try {
    return NextResponse.json(await getChatgptDashboardData(client.chatgpt_ads_account_id));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[CHATGPT-ADS-ERR]', JSON.stringify({ step: 'daily', message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
