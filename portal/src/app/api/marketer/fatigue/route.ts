import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { detectFatigue } from '@/lib/marketer/fatigue';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export async function GET(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const sp = req.nextUrl.searchParams;
  const until = sp.get('until') || resolveDateRange({ preset: sp.get('preset') || undefined }, '30').until;
  const accountIds = (sp.get('account') || '').split(',').map(s => s.trim().replace(/^act_/i, '')).filter(Boolean);
  const result = await detectFatigue({ until, accountIds: accountIds.length ? accountIds : undefined });
  return NextResponse.json(result, NO_STORE);
}
