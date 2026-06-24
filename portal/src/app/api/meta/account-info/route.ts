import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection } from '@/lib/meta';

// Lightweight metadata about the ad account (currency, timezone). The dashboard
// uses timezone_name to make "today / yesterday" line up with the ad account's
// reporting day rather than the user's browser clock — critical when a client
// in PHT is looking at a US-based account.
export async function GET(req: NextRequest) {
  try {
    const { token, accountIds } = await getClientConnection();
    const sp = req.nextUrl.searchParams;

    const accountId = sp.get('account_id')?.replace(/^act_/i, '');
    if (!accountId) return NextResponse.json({ error: { message: 'Missing account_id' } }, { status: 400 });
    if (!accountIds.includes(accountId)) return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });

    const url = new URL(`https://graph.facebook.com/v22.0/act_${accountId}`);
    url.searchParams.set('fields', 'id,timezone_name,timezone_offset_hours_utc,currency,name');
    url.searchParams.set('access_token', token);

    const res = await fetch(url.toString());
    const json = await res.json() as {
      id?: string;
      timezone_name?: string;
      timezone_offset_hours_utc?: number;
      currency?: string;
      name?: string;
      error?: { message?: string };
    };
    if (json.error) return NextResponse.json({ error: json.error }, { status: res.status });

    return NextResponse.json({
      id: json.id,
      timezone_name: json.timezone_name || null,
      timezone_offset_hours_utc: json.timezone_offset_hours_utc ?? null,
      currency: json.currency || null,
      name: json.name || null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
