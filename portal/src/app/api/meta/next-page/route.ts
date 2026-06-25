import { NextRequest, NextResponse } from 'next/server';
import { getClientConnection, sanitizePaging } from '@/lib/meta';

export async function GET(req: NextRequest) {
  try {
    const { tokenForAccount, accountIds, token: defaultToken } = await getClientConnection();
    const rawUrl = req.nextUrl.searchParams.get('url');
    if (!rawUrl) return NextResponse.json({ error: { message: 'Missing url param' } }, { status: 400 });

    const metaUrl = new URL(decodeURIComponent(rawUrl));

    // Only allow Meta API URLs
    if (!metaUrl.hostname.endsWith('facebook.com')) {
      return NextResponse.json({ error: { message: 'Invalid URL' } }, { status: 400 });
    }

    // Multi-BM: paging.next URLs include `/act_<id>/...` — extract the account
    // ID so we use the right BM's token to follow the link. Fall back to the
    // default token when no act_ is present (e.g. /<obj_id>/insights calls).
    const actMatch = metaUrl.pathname.match(/\/act_(\d+)/);
    let token = defaultToken;
    if (actMatch) {
      const accId = actMatch[1];
      if (!accountIds.includes(accId)) {
        return NextResponse.json({ error: { message: 'Account not authorized' } }, { status: 403 });
      }
      token = tokenForAccount(accId);
    }

    // Replace any embedded token (Meta embeds it in paging.next) with ours
    metaUrl.searchParams.delete('access_token');
    metaUrl.searchParams.set('access_token', token);

    const res = await fetch(metaUrl.toString());
    const json = await res.json();
    return NextResponse.json(sanitizePaging(json), { status: res.status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: { message: msg } }, { status: 500 });
  }
}
