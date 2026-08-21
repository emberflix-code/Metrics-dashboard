import { NextRequest, NextResponse } from 'next/server';
import { getClientDbScope } from '@/lib/meta';
import { query } from '@/lib/db';

// Serves the actual thumbnail image bytes stored on meta_creative_assets
// (see 027_creative_asset_bytes.sql) — the Creatives v3 tab's <img src>/
// <video poster> values point here instead of a Meta-sourced URL, so a
// thumbnail never goes dead once it's been through the bytes-backfill
// pass in metaSync.ts (Meta's CDN URLs expire in ~4 days; some are
// session-gated and 403 for anyone without an active Meta login).
//
// Requested same-origin by the browser using the existing session cookie
// (same as any other fetch from DashboardClient.tsx) — no separate
// token/signature scheme needed, just the same accountId-scoping check
// every other DB-backed route already does.
export async function GET(
  _req: NextRequest,
  { params }: { params: { accountId: string; assetKey: string } }
) {
  try {
    const { accountIds } = await getClientDbScope();
    const accountId = decodeURIComponent(params.accountId).replace(/^act_/i, '');
    const assetKey = decodeURIComponent(params.assetKey);
    if (!accountIds.includes(accountId)) {
      return new NextResponse(null, { status: 403 });
    }

    const [row] = await query<{ thumbnail_bytes: Buffer | null; thumbnail_content_type: string | null }>(
      `SELECT thumbnail_bytes, thumbnail_content_type FROM meta_creative_assets
       WHERE account_id = $1 AND asset_key = $2`,
      [accountId, assetKey]
    );
    // No row, or bytes not backfilled yet: 404 with no placeholder image —
    // the client's existing onerror handling (adds a `no-thumb` class,
    // same as a broken/expired URL does today) takes it from there with
    // zero client-side changes needed. Explicitly no-store: this is a
    // transient "not backfilled YET" state, not a permanent absence — the
    // bytes-backfill pass fills it in on a later sync, and without this
    // header the browser was caching the 404 for up to a day (same
    // default heuristic that made the 200 path's max-age worth setting
    // explicitly), so a card stayed blank long after its bytes actually
    // landed until the cache happened to expire or a hard refresh forced
    // a re-request.
    if (!row?.thumbnail_bytes) {
      return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    return new NextResponse(new Uint8Array(row.thumbnail_bytes), {
      status: 200,
      headers: {
        'Content-Type': row.thumbnail_content_type || 'image/jpeg',
        // private: this is session-gated per account, not a publicly
        // cacheable resource shared across users/accounts.
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch {
    return new NextResponse(null, { status: 401 });
  }
}
