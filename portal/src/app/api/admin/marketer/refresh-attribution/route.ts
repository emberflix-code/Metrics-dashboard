import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { refreshCampaignAttribution } from '@/lib/marketerScope';

// Recomputes marketer_campaign_client (campaign -> client attribution) for
// one account or all scoped accounts. Normally unnecessary — it runs after
// every entity sync and on client scope edits — but useful right after
// deploying the marketer module or after bulk client edits.
export async function POST(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const body = await req.json().catch(() => ({}));
  const accountId = body?.accountId ? String(body.accountId).replace(/^act_/i, '') : undefined;
  try {
    const result = await refreshCampaignAttribution(accountId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500 });
  }
}
