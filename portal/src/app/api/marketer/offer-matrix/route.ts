import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveLiveRange } from '@/lib/marketer/campaignStats';
import { buildOfferMatrix } from '@/lib/marketer/offerMatrix';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const sp = req.nextUrl.searchParams;
  // Live mode extends the range through today (see resolveLiveRange).
  const { live, ...range } = resolveLiveRange(
    { preset: sp.get('preset') || undefined, since: sp.get('since') || undefined, until: sp.get('until') || undefined },
    sp.get('live') === '1'
  );
  const groupBy = sp.get('groupBy') === 'brand' ? 'brand' : 'client';
  const minSpend = Math.max(0, Number(sp.get('minSpend')) || 0);
  const result = await buildOfferMatrix({ since: range.since, until: range.until, brand: sp.get('brand') || undefined, groupBy, minSpend, live });
  return NextResponse.json(result, NO_STORE);
}
