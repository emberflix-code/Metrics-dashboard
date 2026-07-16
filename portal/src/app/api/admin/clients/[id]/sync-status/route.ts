import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { computeBackfillProgress } from '@/lib/metaSync';

// Lightweight polling endpoint for SyncControlForm's auto-refresh — returns
// just the sync-state rows (not the whole client-detail page) so the admin
// panel can show a "Running…" badge flip to "Idle"/"Error" live, without a
// manual reload. Mirrors the same scoping/shape page.tsx builds server-side
// on initial load.
interface BmConnectionRow {
  label: string;
  account_ids: string[];
  accounts_json: { id: string; name?: string }[];
}

interface SyncStateDbRow {
  account_id: string;
  status: 'idle' | 'running' | 'error';
  last_synced_at: string | null;
  backfill_complete: boolean;
  earliest_synced: string | null;
  newest_synced: string | null;
  creatives_backfill_complete: boolean;
  creatives_earliest_synced: string | null;
  creatives_newest_synced: string | null;
  last_error: string | null;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [client] = await query<{ ad_account_ids: string[] | null }>('SELECT ad_account_ids FROM clients WHERE id = $1', [params.id]);
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  let scopedAccountIds = client.ad_account_ids || [];
  if (scopedAccountIds.length === 0) {
    const bmRows = await query<BmConnectionRow>('SELECT account_ids FROM agency_bm_connections');
    scopedAccountIds = Array.from(new Set(bmRows.flatMap(r => r.account_ids || [])));
  }

  const syncRows = scopedAccountIds.length > 0
    ? await query<SyncStateDbRow>(
        `SELECT account_id, status, last_synced_at, backfill_complete, earliest_synced, newest_synced,
                creatives_backfill_complete, creatives_earliest_synced, creatives_newest_synced, last_error
         FROM agency_meta_sync_state
         WHERE account_id = ANY($1)`,
        [scopedAccountIds]
      )
    : [];
  const syncRowByAccountId = new Map(syncRows.map(r => [r.account_id, r] as const));

  const syncStates = scopedAccountIds.map(accountId => {
    const row = syncRowByAccountId.get(accountId);
    const progress = computeBackfillProgress({
      newest_synced: row?.newest_synced ?? null,
      earliest_synced: row?.earliest_synced ?? null,
      backfill_complete: row?.backfill_complete ?? false,
      creatives_newest_synced: row?.creatives_newest_synced ?? null,
      creatives_earliest_synced: row?.creatives_earliest_synced ?? null,
      creatives_backfill_complete: row?.creatives_backfill_complete ?? false,
    });
    return {
      accountId,
      status: row?.status ?? 'idle',
      lastSyncedAt: row?.last_synced_at ?? null,
      backfillComplete: progress.complete,
      earliestSynced: row?.earliest_synced ?? null,
      lastError: row?.last_error ?? null,
      monthsTotal: progress.monthsTotal,
      monthsDone: progress.monthsDone,
    };
  });

  return NextResponse.json({ ok: true, syncStates });
}
