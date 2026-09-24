import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { buildScorecard } from '@/lib/marketer/scorecard';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const sp = req.nextUrl.searchParams;
  const range = resolveDateRange({ preset: sp.get('preset') || undefined, since: sp.get('since') || undefined, until: sp.get('until') || undefined }, '30');
  const result = await buildScorecard({ since: range.since, until: range.until, brand: sp.get('brand') || undefined, coach: sp.get('coach') || undefined, live: sp.get('live') === '1' });
  return NextResponse.json(result, NO_STORE);
}
