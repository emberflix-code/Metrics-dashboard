import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { resolveDateRange } from '@/lib/dateRange';
import { buildTargetingReport } from '@/lib/marketer/targeting';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export const dynamic = 'force-dynamic';

function csv(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

// JSON twin of /marketer/targeting — same filters, same report — for
// anything that wants the numbers without the page (scripts, a future
// alerts feed).
export async function GET(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();

  const sp = req.nextUrl.searchParams;
  const range = resolveDateRange({
    preset: sp.get('preset') ?? undefined,
    since: sp.get('since') ?? undefined,
    until: sp.get('until') ?? undefined,
  }, '30');

  const minScoreRaw = Number(sp.get('minScore'));
  const minScore = Number.isFinite(minScoreRaw) && sp.get('minScore') !== null ? Math.max(0, Math.min(1, minScoreRaw)) : 0.05;

  try {
    const report = await buildTargetingReport({
      since: range.since,
      until: range.until,
      clientIds: csv(sp.get('client')),
      brand: sp.get('brand') || undefined,
      accountIds: csv(sp.get('account'))?.map(a => a.replace(/^act_/i, '')),
      minScore,
      includeSameCampaign: sp.get('includeSameCampaign') === '1',
      includeInactive: sp.get('includeInactive') === '1',
    });
    return NextResponse.json({ preset: range.preset, ...report }, NO_STORE);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed' }, { status: 500, ...NO_STORE });
  }
}
