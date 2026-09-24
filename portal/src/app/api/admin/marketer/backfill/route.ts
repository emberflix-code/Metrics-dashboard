import { NextRequest, NextResponse } from 'next/server';
import { getMarketerSession, marketerUnauthorized } from '@/lib/marketerAuth';
import { startMarketerBackfill, getBackfillStatus, type BackfillStep } from '@/lib/marketerBackfill';

const STEPS = new Set<BackfillStep>(['geocode', 'targeting', 'copy', 'attribution']);
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

// Kicks off a marketer-data backfill in the background (see
// lib/marketerBackfill.ts) and returns immediately; poll GET for progress.
export async function POST(req: NextRequest) {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  const body = await req.json().catch(() => ({}));
  const step = String(body?.step || '') as BackfillStep;
  if (!STEPS.has(step)) return NextResponse.json({ error: 'step must be one of: geocode, targeting, copy, attribution' }, { status: 400 });
  const accountId = body?.accountId ? String(body.accountId).replace(/^act_/i, '') : undefined;
  const result = await startMarketerBackfill(step, accountId);
  return NextResponse.json({ ok: result.started, ...result, status: getBackfillStatus() }, NO_STORE);
}

export async function GET() {
  const session = await getMarketerSession();
  if (!session) return marketerUnauthorized();
  return NextResponse.json(getBackfillStatus(), NO_STORE);
}
