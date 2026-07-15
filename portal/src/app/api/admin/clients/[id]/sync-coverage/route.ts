import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { getMonthlyCoverage } from '@/lib/metaSync';

// Per-account, per-month data coverage for the admin panel's backfill
// timeline — ground truth read from the fact tables (see getMonthlyCoverage
// for why this isn't just the watermark). ?account_id= selects one of the
// client's ad accounts.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [client] = await query<{ ad_account_ids: string[] | null }>('SELECT ad_account_ids FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const accountId = req.nextUrl.searchParams.get('account_id')?.replace(/^act_/i, '');
  if (!accountId) return NextResponse.json({ error: 'Missing account_id' }, { status: 400 });
  if ((client.ad_account_ids?.length ?? 0) > 0 && !client.ad_account_ids!.includes(accountId)) {
    return NextResponse.json({ error: 'Account not assigned to this client' }, { status: 403 });
  }

  try {
    const months = await getMonthlyCoverage(accountId);
    return NextResponse.json({ ok: true, months });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to load coverage';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
