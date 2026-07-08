import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection, sanitizePaging, isMultiKeywordFilter, matchesCampaignFilter } from '@/lib/meta';

export async function GET(req: NextRequest) {
  try {
    const { tokenForAccount, accountIds, campaignFilter } = await getClientConnection();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });
    const token = tokenForAccount(accountId);

    const url = new URL(`https://graph.facebook.com/v22.0/act_${accountId}/adsets`);
    const requestedFields = sp.get('fields') || 'id,name,effective_status';
    // Meta's CONTAIN only matches one substring — multi-keyword (region/umbrella)
    // filters are applied locally below instead of sent to Meta. That requires
    // campaign.name in the response regardless of what the caller asked for.
    const multiKeyword = isMultiKeywordFilter(campaignFilter);
    const needsCampaignName = multiKeyword && !requestedFields.includes('campaign');
    url.searchParams.set('fields', needsCampaignName ? `${requestedFields},campaign{name}` : requestedFields);
    url.searchParams.set('limit', sp.get('limit') || '200');

    // See campaigns route for rationale — explicitly include DELETED + ARCHIVED
    // so adsets with spend in the selected range stay visible in the table.
    const ALL_STATUSES = ['ACTIVE','PAUSED','DELETED','PENDING_REVIEW','DISAPPROVED','PREAPPROVED','PENDING_BILLING_INFO','CAMPAIGN_PAUSED','ARCHIVED','ADSET_PAUSED','IN_PROCESS','WITH_ISSUES'];
    const filters: { field: string; operator: string; value: string | string[] }[] = [
      { field: 'effective_status', operator: 'IN', value: ALL_STATUSES },
    ];
    if (campaignFilter && !multiKeyword) {
      filters.push({ field: 'campaign.name', operator: 'CONTAIN', value: campaignFilter });
    }
    url.searchParams.set('filtering', JSON.stringify(filters));

    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
    const json = await res.json();
    if (multiKeyword && Array.isArray(json?.data)) {
      json.data = json.data.filter((a: { campaign?: { name?: string } }) => matchesCampaignFilter(a.campaign?.name || '', campaignFilter));
      if (needsCampaignName) {
        for (const row of json.data) delete row.campaign;
      }
    }
    return NextResponse.json(sanitizePaging(json), { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
