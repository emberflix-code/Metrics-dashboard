import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getClientDbScope } from '@/lib/meta';
import { query } from '@/lib/db';
import { decrypt } from '@/lib/crypto';
import { computePhash } from '@/lib/phash';

interface AdCreativeResp {
  creative?: { effective_object_story_id?: string };
}
interface PageAccountsResp {
  data?: { id: string; access_token: string }[];
}
interface PostResp {
  full_picture?: string;
}

// On-demand only — never called during sync. A user clicking "low-res
// preview — click to view" on a Creatives v2/v3 card fires this once for
// that specific asset. Recovers a full-resolution image via the ad's
// effective_object_story_id -> Page post -> full_picture, using the single
// agency-wide Page-content token (see 028_page_content_token.sql), and
// caches the result onto meta_creative_assets so it's never re-fetched.
// Gated on the requesting client's enable_page_image_fallback flag, same
// gate the toggle in admin controls.
export async function POST(req: NextRequest) {
  try {
    const { accountIds } = await getClientDbScope();
    const { account_id, asset_key, ad_id } = await req.json();

    if (!account_id || !asset_key || !ad_id) {
      return NextResponse.json({ error: 'account_id, asset_key, and ad_id are required' }, { status: 400 });
    }
    if (!accountIds.includes(account_id)) {
      return NextResponse.json({ error: 'Account not authorized' }, { status: 403 });
    }

    // Scoped to the REQUESTING session's own client row, not just any client
    // that happens to include this account_id — several accounts in this
    // agency are shared across many client rows, and the toggle is a
    // per-client decision (see EnablePageImageFallbackToggle).
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const [clientRow] = await query<{ enable_page_image_fallback: boolean }>(
      `SELECT c.enable_page_image_fallback
       FROM clients c
       JOIN client_users cu ON cu.client_id = c.id
       WHERE cu.user_id = $1
       LIMIT 1`,
      [session.user.id]
    );
    if (!clientRow?.enable_page_image_fallback) {
      return NextResponse.json({ error: 'not_enabled' }, { status: 403 });
    }

    const [pageTokenRow] = await query<{ token_enc: string | null }>(`SELECT token_enc FROM agency_page_token WHERE id = 1`);
    if (!pageTokenRow?.token_enc) {
      return NextResponse.json({ error: 'no_page_token_configured' }, { status: 400 });
    }
    const systemUserToken = decrypt(pageTokenRow.token_enc);

    const [bmRow] = await query<{ token_enc: string }>(
      `SELECT token_enc FROM agency_bm_connections WHERE $1 = ANY(account_ids) LIMIT 1`,
      [account_id]
    );
    if (!bmRow) {
      return NextResponse.json({ error: 'no_ad_account_token' }, { status: 400 });
    }
    const adToken = decrypt(bmRow.token_enc);

    // 1) Ad -> effective_object_story_id (needs only ads_read, uses the existing ad-account token).
    const adUrl = new URL(`https://graph.facebook.com/v21.0/${ad_id}`);
    adUrl.searchParams.set('fields', 'creative{effective_object_story_id}');
    adUrl.searchParams.set('access_token', adToken);
    const adRes = await fetch(adUrl.toString());
    const adJson = await adRes.json() as AdCreativeResp;
    const storyId = adJson?.creative?.effective_object_story_id;
    if (!storyId) {
      return NextResponse.json({ error: 'no_story_id' }, { status: 404 });
    }

    // 2) System User token -> Page-scoped token for the Page that owns this post.
    // storyId is "<page_id>_<post_id>" — the part before the underscore is the Page ID.
    const pageId = storyId.split('_')[0];
    const accountsUrl = new URL('https://graph.facebook.com/v21.0/me/accounts');
    accountsUrl.searchParams.set('access_token', systemUserToken);
    accountsUrl.searchParams.set('limit', '200');
    const accountsRes = await fetch(accountsUrl.toString());
    const accountsJson = await accountsRes.json() as PageAccountsResp;
    const page = (accountsJson.data || []).find(p => p.id === pageId);
    if (!page?.access_token) {
      return NextResponse.json({ error: 'page_not_accessible' }, { status: 404 });
    }

    // 3) Post -> full_picture, using the Page-scoped token.
    const storyUrl = new URL(`https://graph.facebook.com/v21.0/${storyId}`);
    storyUrl.searchParams.set('fields', 'full_picture');
    storyUrl.searchParams.set('access_token', page.access_token);
    const storyRes = await fetch(storyUrl.toString());
    const storyJson = await storyRes.json() as PostResp;
    const fullPicture = storyJson?.full_picture;
    if (!fullPicture) {
      return NextResponse.json({ error: 'no_full_picture' }, { status: 404 });
    }

    // Download and cache — same shape as the sync-time thumbnail-bytes backfill.
    const imgRes = await fetch(fullPicture);
    if (!imgRes.ok) {
      return NextResponse.json({ error: 'image_download_failed' }, { status: 502 });
    }
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const hash = await computePhash(bytes).catch(() => null);

    await query(
      `UPDATE meta_creative_assets
       SET thumbnail_bytes = $3, thumbnail_content_type = $4, thumbnail_bytes_fetched_at = now(),
           phash = COALESCE($5, phash)
       WHERE account_id = $1 AND asset_key = $2`,
      [account_id, asset_key, bytes, contentType, hash]
    );

    return NextResponse.json({
      ok: true,
      thumbnail: `/api/meta/db/asset-thumbnail/${encodeURIComponent(account_id)}/${encodeURIComponent(asset_key)}`,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'unknown_error' }, { status: 500 });
  }
}