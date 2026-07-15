import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { syncAccountCreativesOnly } from '@/lib/metaSync';

// Creatives-only "Sync now" — skips entities/insights so creatives gets the
// full run's time budget instead of only whatever's left after those two
// steps run first (see syncAccountCreativesOnly). Per-account, not per-
// client, matching sync-range's pattern — a client can have several ad
// accounts and an admin may only want to catch up one.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [client] = await query<{ ad_account_ids: string[] | null }>('SELECT ad_account_ids FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const accountId = String(body.account_id || '').replace(/^act_/i, '');
  if (!accountId) return NextResponse.json({ error: 'Missing account_id' }, { status: 400 });
  if ((client.ad_account_ids?.length ?? 0) > 0 && !client.ad_account_ids!.includes(accountId)) {
    return NextResponse.json({ error: 'Account not assigned to this client' }, { status: 403 });
  }

  try {
    const result = await syncAccountCreativesOnly(accountId);
    if (result.error) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Creatives sync failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
