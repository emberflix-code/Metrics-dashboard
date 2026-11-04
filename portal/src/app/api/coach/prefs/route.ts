import { NextRequest, NextResponse } from 'next/server';
import { getCoachSession, coachUnauthorized } from '@/lib/coachAuth';
import { loadBoardPrefs, saveBoardPrefs } from '@/lib/coach/prefs';

// The signed-in user's coach-board settings (see lib/coach/prefs.ts).
export async function GET() {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  return NextResponse.json(await loadBoardPrefs(ctx.session.user.id, ctx.isAdmin), { headers: { 'Cache-Control': 'no-store' } });
}

export async function PUT(req: NextRequest) {
  const ctx = await getCoachSession();
  if (!ctx) return coachUnauthorized();
  const body = await req.json().catch(() => ({}));
  await saveBoardPrefs(ctx.session.user.id, ctx.isAdmin, body && typeof body === 'object' ? body : {});
  return NextResponse.json({ ok: true });
}
