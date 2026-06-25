import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection, sanitizePaging } from '@/lib/meta';

export async function GET(req: NextRequest) {
  try {
    const { tokenForAccount, accountIds, campaignFilter } = await getClientConnection();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });
    const token = tokenForAccount(accountId);

    const url = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/ads`);
    url.searchParams.set('fields', sp.get('fields') || 'id,name,effective_status');
    url.searchParams.set('limit', sp.get('limit') || '200');

    // See campaigns route for rationale — explicitly include DELETED + ARCHIVED
    // so ads with spend in the selected range stay visible in the table.
    const ALL_STATUSES = ['ACTIVE','PAUSED','DELETED','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO','CAMPAIGN_PAUSED','ARCHIVED','ADSET_PAUSED','IN_PROCESS','WITH_ISSUES'];
    const filters: { field: string; operator: string; value: string | string[] }[] = [
      { field: 'effective_status', operator: 'IN', value: ALL_STATUSES },
    ];
    if (campaignFilter) {
      filters.push({ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter });
    }
    url.searchParams.set('filtering', JSON.stringify(filters));

    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
    const json = await res.json();
    return NextResponse.json(sanitizePaging(json), { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
