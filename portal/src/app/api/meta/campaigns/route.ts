import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection, sanitizePaging } from '@/lib/meta';

export async function GET(req: NextRequest) {
  try {
    const { token, accountIds, campaignFilter } = await getClientConnection();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    const url = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/campaigns`);
    url.searchParams.set('fields', sp.get('fields') || 'id,name,effective_status');
    url.searchParams.set('limit', sp.get('limit') || '200');

    // Include DELETED + ARCHIVED. effective_status alone misses truly-deleted
    // campaigns (Meta separates "live status" from "configured status"), so we
    // also filter on configured_status. Most endpoints honor one or the other;
    // including both makes the request robust across both code paths.
    const ALL_STATUSES = ['ACTIVE','PAUSED','DELETED','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO','CAMPAIGN_PAUSED','ARCHIVED','ADSET_PAUSED','IN_PROCESS','WITH_ISSUES'];
    const filters: { field: string; operator: string; value: string | string[] }[] = [
      { field: 'effective_status', operator: 'IN', value: ALL_STATUSES },
    ];
    if (campaignFilter) {
      filters.push({ field: 'name', operator: 'CONTAIN', value: campaignFilter });
    }
    url.searchParams.set('filtering', JSON.stringify(filters));

    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
    const json = await res.json() as { data?: { id?: string; name?: string; effective_status?: string }[]; error?: unknown };
    // Diagnostic: surface what statuses Meta actually returned so we can
    // confirm whether DELETED/ARCHIVED entities are coming through.
    if (Array.isArray(json.data)) {
      const counts: Record<string, number> = {};
      for (const c of json.data) counts[c.effective_status || 'UNKNOWN'] = (counts[c.effective_status || 'UNKNOWN'] || 0) + 1;
      console.log('[CAMPAIGNS-DEBUG]', 'account:', accountId, 'total:', json.data.length, 'by status:', counts);
    } else {
      console.log('[CAMPAIGNS-DEBUG]', 'account:', accountId, 'no data, response:', json);
    }
    return NextResponse.json(sanitizePaging(json), { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
