import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { buildAlerts, type AlertKind } from '@/lib/marketer/alerts';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };
const csv = (v: string | null) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

export async function GET(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const sp = req.nextUrl.searchParams;
  const until = sp.get('until') || resolveDateRange({ preset: sp.get('preset') || undefined, since: sp.get('since') || undefined, until: sp.get('until') || undefined }, '30').until;
  const kinds = csv(sp.get('kinds')) as AlertKind[];
  const result = await buildAlerts({
    until,
    includeDismissed: sp.get('includeDismissed') === '1',
    kinds: kinds.length ? kinds : undefined,
    clientIds: csv(sp.get('client')),
    brand: sp.get('brand') || undefined,
  });
  return NextResponse.json(result, NO_STORE);
}
