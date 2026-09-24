import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { geocodePendingClients, geocoderName } from '@/lib/geocode';
import { invalidateTargetingCache } from '@/lib/marketer/targeting';

const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

export const dynamic = 'force-dynamic';
// Nominatim is rate-limited to ~1 req/s, so a full first pass over ~90
// clubs takes a couple of minutes.
export const maxDuration = 300;

// Geocodes clubs whose address was never geocoded (or edited since); pass
// { clientId } for one club, { force: true } to redo already-geocoded ones.
// Marketer-gated rather than admin-only because the Targeting page's
// "Geocode clubs" button is the normal way this runs.
export async function POST(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();

  const body = await req.json().catch(() => ({})) as { clientId?: unknown; force?: unknown };
  const clientId = typeof body.clientId === 'string' && body.clientId.trim() ? body.clientId.trim() : undefined;
  const force = body.force === true || body.force === 1 || body.force === '1';

  try {
    const result = await geocodePendingClients({ clientId, force });
    invalidateTargetingCache();
    return NextResponse.json({ ok: true, ...result, provider: geocoderName() }, NO_STORE);
  } catch (err) {
    invalidateTargetingCache();
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : 'Failed' }, { status: 500, ...NO_STORE });
  }
}
