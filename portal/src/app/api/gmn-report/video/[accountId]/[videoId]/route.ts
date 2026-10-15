import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getClientDbScope } from '@/lib/meta';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

// Playable video for the GMN Marketing Report's top-creatives cards.
// meta_creative_assets.video_source is a Meta CDN URL that expires, so this
// asks Meta for a fresh `source` each time (same lookup as metaSync.ts's video
// enrichment, including the /act_X/advideos fallback for videos Meta won't
// serve by id across accounts) and 302-redirects the <video> element to it.
// Falls back to the stored URL, then 404 — the page then shows the poster
// frame with an "open in Ads Manager" link.
//
// Same account scoping as /api/meta/db/asset-thumbnail: a client may only ask
// for its own ad accounts; admin/marketer sessions may ask for any.
const GRAPH = 'https://graph.facebook.com/v22.0';
const NO_STORE = { 'Cache-Control': 'no-store' };

async function allowedAccountIds(): Promise<string[]> {
  const session = await getServerSession(authOptions);
  if (!session) throw new Error('Unauthorized');
  if (session.user.role === 'admin' || session.user.role === 'marketer') {
    const rows = await query<{ account_ids: string[] | null }>(`SELECT account_ids FROM agency_bm_connections`);
    return Array.from(new Set(rows.flatMap(r => r.account_ids || [])));
  }
  return (await getClientDbScope()).accountIds;
}

async function freshSource(accountId: string, videoId: string): Promise<string | null> {
  const [conn] = await query<{ token_enc: string }>(
    `SELECT token_enc FROM agency_bm_connections WHERE $1 = ANY(account_ids) LIMIT 1`,
    [accountId]
  );
  if (!conn) return null;
  const token = encodeURIComponent(decrypt(conn.token_enc));
  for (const url of [
    `${GRAPH}/${videoId}?fields=source&access_token=${token}`,
    `${GRAPH}/act_${accountId}/advideos/${videoId}?fields=source&access_token=${token}`,
  ]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      const json = (await res.json()) as { source?: string };
      if (json.source) return json.source;
    } catch { /* try the next lookup */ }
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { accountId: string; videoId: string } }
) {
  try {
    const accountId = decodeURIComponent(params.accountId).replace(/^act_/i, '');
    const videoId = decodeURIComponent(params.videoId);
    if (!/^\d+$/.test(accountId) || !/^\d+$/.test(videoId)) return new NextResponse(null, { status: 400, headers: NO_STORE });
    if (!(await allowedAccountIds()).includes(accountId)) return new NextResponse(null, { status: 403, headers: NO_STORE });

    let source = await freshSource(accountId, videoId);
    if (!source) {
      const [row] = await query<{ video_source: string | null }>(
        `SELECT video_source FROM meta_creative_assets WHERE account_id = $1 AND asset_key = $2`,
        [accountId, `video:${videoId}`]
      );
      source = row?.video_source ?? null;
    }
    if (!source) return new NextResponse(null, { status: 404, headers: NO_STORE });
    return NextResponse.redirect(source, { status: 302, headers: NO_STORE });
  } catch (e) {
    const unauthorized = e instanceof Error && e.message === 'Unauthorized';
    return new NextResponse(null, { status: unauthorized ? 401 : 500, headers: NO_STORE });
  }
}
