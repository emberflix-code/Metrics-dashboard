import { NextRequest, NextResponse } from 'next/server';
import { getClientDbScope, matchesCampaignFilter } from '@/lib/meta';
import { query } from '@/lib/db';

// DB-backed mirror of /api/meta/adsets — see db/campaigns/route.ts for the
// shared rationale.
export async function GET(req: NextRequest) {
  try {
    const { accountIds, campaignFilter } = await getClientDbScope();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    const rows = await query<{ entity_id: string; name: string; effective_status: string; campaign_name: string }>(
      `SELECT entity_id, name, effective_status, campaign_name FROM meta_entities WHERE account_id = $1 AND level = 'adset'`,
      [accountId]
    );

    const data = rows
      .filter(r => matchesCampaignFilter(r.campaign_name || '', campaignFilter))
      .map(r => ({ id: r.entity_id, name: r.name, effective_status: r.effective_status }));

    return NextResponse.json({ data, paging: null });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
