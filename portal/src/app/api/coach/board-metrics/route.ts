import { NextRequest, NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { loadCoachClients } from '@/lib/coach/scope';
import { computeBoardMetrics, cachedThrough } from '@/lib/coach/metrics';
import { CHEAP_METRIC_KEYS, RANGE_KEYS } from '@/lib/coach/columns';
import { resolveDateRange } from '@/lib/dateRange';

// Numbers for the coach board, fetched after the page renders and only for
// the metric columns currently visible. Cache-only (lib/coach/metrics.ts).
// The client list always comes from the session — ids are never accepted
// from the request.
export async function POST(req: NextRequest) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  const body = await req.json().catch(() => ({}));
  const preset = RANGE_KEYS.includes(String(body.range)) ? String(body.range) : '7';
  const { since, until } = resolveDateRange({ preset }, '7');
  const keys = Array.isArray(body.keys) ? body.keys.filter((k: unknown) => typeof k === 'string' && CHEAP_METRIC_KEYS.includes(k as string)) : [];

  const clients = await loadCoachClients(ctx, { adminCoachFilter: typeof body.coachFilter === 'string' ? body.coachFilter : '' });
  const [rows, through] = await Promise.all([
    keys.length ? computeBoardMetrics(clients, keys, since, until) : Promise.resolve({}),
    cachedThrough(clients),
  ]);
  return NextResponse.json(
    { range: { since, until }, metaCachedThrough: through.meta, googleCachedThrough: through.google, rows },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
