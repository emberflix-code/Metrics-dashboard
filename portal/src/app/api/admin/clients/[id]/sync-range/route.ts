import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { syncAccountRange } from '@/lib/metaSync';

// On-demand backfill for an admin-specified date range — lets an admin fill
// a specific gap visible in the coverage timeline without waiting for the
// normal sequential (recent-first) backfill to reach it. See
// syncAccountRange's own comment for why this doesn't touch the watermark.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [client] = await query<{ ad_account_ids: string[] | null }>('SELECT ad_account_ids FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const accountId = String(body.account_id || '').replace(/^act_/i, '');
  const since = String(body.since || '');
  const until = String(body.until || '');
  if (!accountId) return NextResponse.json({ error: 'Missing account_id' }, { status: 400 });
  if ((client.ad_account_ids?.length ?? 0) > 0 && !client.ad_account_ids!.includes(accountId)) {
    return NextResponse.json({ error: 'Account not assigned to this client' }, { status: 403 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) {
    return NextResponse.json({ error: 'since/until must be YYYY-MM-DD with since <= until' }, { status: 400 });
  }
  // Defaults to insights-only (matches the original behavior) — pass
  // { creatives: true } to also (or only) sync DCO assets/breakdown for
  // this range.
  const types = {
    insights: body.types?.insights !== false,
    creatives: !!body.types?.creatives,
  };

  try {
    const result = await syncAccountRange(accountId, since, until, types);
    if (result.error) return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    return NextResponse.json({ ok: true, daysSynced: result.daysSynced });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Range sync failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
