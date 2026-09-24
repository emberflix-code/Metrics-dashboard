import { NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { loadMarketerScope } from '@/lib/marketerScope';
import { query } from '@/lib/db';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

// Offer tokens in use across every scoped account, with how many campaigns
// and (primary-attributed) clients carry each — feeds the marketer filter
// dropdowns. Manual overrides win over the parsed token.
export async function GET() {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();

  const scope = await loadMarketerScope();
  if (scope.accountIds.length === 0) return NextResponse.json({ offers: [] }, NO_STORE);

  const rows = await query<{ offer: string; campaign_count: string; client_count: string }>(
    `SELECT COALESCE(o.offer, e.offer_token, 'Unknown') AS offer,
            COUNT(*)::text AS campaign_count,
            COUNT(DISTINCT m.client_id)::text AS client_count
     FROM meta_entities e
     LEFT JOIN campaign_offer_overrides o ON o.account_id = e.account_id AND o.campaign_id = e.entity_id
     LEFT JOIN marketer_campaign_client m ON m.account_id = e.account_id AND m.campaign_id = e.entity_id AND m.is_primary
     WHERE e.level = 'campaign' AND e.account_id = ANY($1)
     GROUP BY 1
     ORDER BY COUNT(*) DESC, 1 ASC`,
    [scope.accountIds]
  );

  return NextResponse.json({
    offers: rows.map(r => ({ token: r.offer, campaignCount: Number(r.campaign_count), clientCount: Number(r.client_count) })),
  }, NO_STORE);
}
