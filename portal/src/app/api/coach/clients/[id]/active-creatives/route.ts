import { NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { assertCoachOwnsClient } from '@/lib/coach/scope';
import { loadActiveCreatives } from '@/lib/coach/activeCreatives';
import { isGoogleOnlyClient } from '@/lib/meta';
import { query } from '@/lib/db';

// The client's currently running Meta ads, grouped by creative (cache only).
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  if (!(await assertCoachOwnsClient(ctx, params.id))) return NextResponse.json({ error: 'Client not found' }, { status: 404 });

  const [c] = await query<{ ad_account_ids: string[] | null; campaign_filter: string; google_data_source: string }>(
    `SELECT ad_account_ids, campaign_filter, google_data_source FROM clients WHERE id = $1`, [params.id]);
  if (!c || isGoogleOnlyClient({ ad_account_ids: c.ad_account_ids, google_data_source: c.google_data_source }) || !c.ad_account_ids?.length) {
    return NextResponse.json({ creatives: [], activeAds: 0, adsWithoutCopy: 0, creativesWithoutThumbnail: 0, copySyncedAt: null, noMeta: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    return NextResponse.json(await loadActiveCreatives(c.ad_account_ids, c.campaign_filter || ''), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[COACH-ACTIVE-CREATIVES-ERR]', JSON.stringify({ clientId: params.id, message }));
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
