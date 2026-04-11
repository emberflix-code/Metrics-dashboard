import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection, sanitizePaging } from '@/lib/meta';

export async function GET(req: NextRequest) {
  try {
    const { token, accountIds, campaignFilter } = await getClientConnection();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    const url = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/ads`);
    url.searchParams.set('fields', sp.get('fields') || 'id,name,effective_status');
    url.searchParams.set('limit', sp.get('limit') || '200');

    if (campaignFilter) {
      url.searchParams.set('filtering', JSON.stringify([
        { field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter }
      ]));
    }

    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
    const json = await res.json();
    return NextResponse.json(sanitizePaging(json), { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
