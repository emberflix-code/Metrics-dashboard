import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { syncClientAccounts } from '@/lib/metaSync';

// Manual "Sync now" trigger for the DB-backed dashboard cache. Runs the sync
// in-process and awaits it — Railway has no serverless timeout, so a
// multi-minute first-sync request is safe. No queue, no separate worker;
// syncClientAccounts() is a plain trigger-agnostic function a future cron
// could call the same way.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [client] = await query('SELECT id FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  try {
    const results = await syncClientAccounts(params.id);
    return NextResponse.json({ ok: true, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Sync failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
