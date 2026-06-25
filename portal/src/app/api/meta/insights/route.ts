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

    const url = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/insights`);
    url.searchParams.set('fields', sp.get('fields') || 'campaign_name,reach,impressions,spend,inline_link_clicks,actions');
    url.searchParams.set('level', sp.get('level') || 'campaign');
    url.searchParams.set('time_range', sp.get('time_range') || '{}');
    url.searchParams.set('limit', sp.get('limit') || '100');
    if (sp.get('time_increment')) url.searchParams.set('time_increment', sp.get('time_increment')!);
    if (sp.get('action_attribution_windows')) url.searchParams.set('action_attribution_windows', sp.get('action_attribution_windows')!);

    // Meta's /insights endpoint silently drops DELETED + ARCHIVED entities
    // unless we explicitly opt them in. Mirroring Meta BM's "All statuses"
    // mode at every level so spend reconciles with the BM screenshot total.
    const level = sp.get('level') || 'campaign';
    const ALL_STATUSES = ['ACTIVE','PAUSED','DELETED','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO','CAMPAIGN_PAUSED','ARCHIVED','ADSET_PAUSED','IN_PROCESS','WITH_ISSUES'];
    if (level === 'campaign') {
      url.searchParams.set('filtering', JSON.stringify([
        { field: 'campaign.effective_status', operator: 'IN', value: ALL_STATUSES },
        ...(campaignFilter ? [{ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter }] : []),
      ]));
    } else if (level === 'adset') {
      url.searchParams.set('filtering', JSON.stringify([
        { field: 'adset.effective_status', operator: 'IN', value: ALL_STATUSES },
        ...(campaignFilter ? [{ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter }] : []),
      ]));
    } else if (level === 'ad') {
      url.searchParams.set('filtering', JSON.stringify([
        { field: 'ad.effective_status', operator: 'IN', value: ALL_STATUSES },
        ...(campaignFilter ? [{ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter }] : []),
      ]));
    } else if (campaignFilter) {
      url.searchParams.set('filtering', JSON.stringify([
        { field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter },
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
