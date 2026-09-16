import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { query } from '@/lib/db';
import { clusterByPerceptualHashCached, hasFreshClusterCache, invalidateClusterCache, computeDownsampledGray, computePixelMADFromDownsampled, PIXEL_MAD_MATCH_THRESHOLD, PHASH_MATCH_THRESHOLD, PHASH_CANDIDATE_THRESHOLD } from '@/lib/phash';

// Admin-only manual creative tagging (Theme, UGC status) — the dropdowns
// that call this only ever render while an admin is impersonating a client
// (see _isAdminView gating in DashboardClient.tsx), but the route itself
// re-checks role server-side rather than trusting the client not to call it
// directly.
//
// While impersonating, session.user.role is the CLIENT's role ('client'),
// not 'admin' — the original admin identity only survives in
// impersonatedBy (see api/admin/impersonate/route.ts). So the actual gate
// has to accept either a real admin session or an impersonating one.
//
// Partial updates: either field can be omitted/null to leave the other
// unchanged, so the two dropdowns on a creative card can each save
// independently without clobbering the other's current value.

const VALID_THEMES = new Set(['non-active', 'strength', 'tread', 'strength+tread']);
const VALID_UGC_STATUSES = new Set(['ugc', 'non-ugc']);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const isAdmin = session?.user.role === 'admin' || !!session?.user.impersonatedBy;
  if (!session || !isAdmin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json();
  const accountId = String(body?.accountId ?? '').trim();
  const assetKey = String(body?.assetKey ?? '').trim();
  if (!accountId || !assetKey) {
    return NextResponse.json({ error: 'accountId and assetKey are required' }, { status: 400 });
  }

  // Cross-account creative tagging (see EnableCrossAccountCreativeTaggingToggle
  // and DashboardClient.tsx's mergeInto/contributingAccountIds): a merged
  // card can represent the SAME shared-template creative across several of
  // a rollup client's accounts. accountIds, when sent, is every account
  // that card was merged from — the tag applies to each one's own row so
  // it's saved consistently everywhere the creative appears. Falls back to
  // just [accountId] for a normal single-account tag-save (accountIds
  // omitted, or sent by an older client build).
  const rawAccountIds = Array.isArray(body?.accountIds) ? body.accountIds : [];
  const accountIds = Array.from(new Set(
    [accountId, ...rawAccountIds].map(id => String(id ?? '').trim()).filter(Boolean)
  ));

  const existingAssets = await query<{ account_id: string }>(
    'SELECT account_id FROM meta_creative_assets WHERE account_id = ANY($1) AND asset_key = $2',
    [accountIds, assetKey]
  );
  if (existingAssets.length === 0) {
    // TEMP-DIAG: pin down a live "Creative asset not found" report where
    // the asset_key visibly exists in meta_creative_assets when checked
    // directly — logs exactly what the browser actually sent vs what the
    // DB has, so the mismatch (wrong account scoping? a stale/encoded
    // assetKey? session issue?) shows up in railway logs on the next repro.
    console.log('[CREATIVE-TAG-404]', JSON.stringify({ accountId, accountIds, assetKey, rawBody: body }));
    return NextResponse.json({ error: 'Creative asset not found' }, { status: 404 });
  }
  const foundAccountIds = existingAssets.map(r => r.account_id);

  // Also apply this tag to every OTHER asset_key that the display-side
  // phash clustering (see /api/meta/db/asset-breakdown and
  // resolveClusteredThemeAndUgc in lib/phash.ts) already folds onto this
  // same visible card — same visual photo re-uploaded under a different
  // Meta asset_key. Without this, tagging the merged card only ever wrote
  // to whichever ONE asset_key the click happened to carry, leaving real
  // spend on its untagged siblings invisible until each was tagged
  // separately (see untaggedSiblingCount/DashboardClient.tsx's sibling-gap
  // badge — this closes the gap that badge surfaces, instead of just
  // reporting it). Scoped per account: each foundAccountIds entry gets its
  // own cluster expanded independently, since phash/theme/ugc_status are
  // all per-(account_id, asset_key) rows.
  const clusterAssetKeysByAccount = new Map<string, string[]>();
  for (const accId of foundAccountIds) {
    const accountAssets = await query<{ asset_key: string; phash: string | null; theme: string | null; ugc_status: string | null }>(
      'SELECT asset_key, phash, theme, ugc_status FROM meta_creative_assets WHERE account_id = $1',
      [accId]
    );
    // Same widened-candidate-band + pixel confirmation, per-asset byte
    // fetch/decode, and result caching as /api/meta/db/asset-breakdown —
    // see PHASH_CANDIDATE_THRESHOLD's and clusterByPerceptualHashCached's
    // comments in lib/phash.ts. Applying a tag must fold in the exact same
    // cluster that Creatives v3 displays as one card, or a tag saved here
    // could miss a sibling the badge/card already shows as merged. Cache
    // key is bare accId (this route clusters the WHOLE account, unlike the
    // Creatives-tab routes' own narrower, differently-keyed slices) — this
    // read uses the cache as-is (pre-write tag state, correct for deciding
    // who bundles with `assetKey`); invalidateClusterCache runs after the
    // write below so the NEXT read picks up the new tag.
    const clusterInputAssets = accountAssets.map(a => ({ assetKey: a.asset_key, phash: a.phash, tagged: !!(a.theme || a.ugc_status) }));
    let confirmByPixelDiff: ((a: string, b: string) => Promise<boolean>) | undefined;
    if (!hasFreshClusterCache(accId, clusterInputAssets)) {
      const candidateAssetKeys = new Set<string>();
      for (let i = 0; i < accountAssets.length; i++) {
        const a = accountAssets[i];
        if (!a.phash) continue;
        for (let j = i + 1; j < accountAssets.length; j++) {
          const b = accountAssets[j];
          if (!b.phash) continue;
          let x = BigInt('0x' + a.phash) ^ BigInt('0x' + b.phash);
          let dist = 0;
          while (x > BigInt(0)) { dist += Number(x & BigInt(1)); x >>= BigInt(1); }
          if (dist > PHASH_MATCH_THRESHOLD && dist <= PHASH_CANDIDATE_THRESHOLD) {
            candidateAssetKeys.add(a.asset_key);
            candidateAssetKeys.add(b.asset_key);
          }
        }
      }
      const downsampledByKey = new Map<string, Buffer>();
      if (candidateAssetKeys.size > 0) {
        const bytesRows = await query<{ asset_key: string; thumbnail_bytes: Buffer | null }>(
          `SELECT asset_key, thumbnail_bytes FROM meta_creative_assets WHERE account_id = $1 AND asset_key = ANY($2)`,
          [accId, Array.from(candidateAssetKeys)]
        );
        await Promise.all(bytesRows.map(async r => {
          if (!r.thumbnail_bytes) return;
          const downsampled = await computeDownsampledGray(r.thumbnail_bytes);
          if (downsampled) downsampledByKey.set(r.asset_key, downsampled);
        }));
      }
      confirmByPixelDiff = async (a: string, b: string): Promise<boolean> => {
        const bufA = downsampledByKey.get(a), bufB = downsampledByKey.get(b);
        if (!bufA || !bufB) return false;
        const mad = computePixelMADFromDownsampled(bufA, bufB);
        return mad !== null && mad <= PIXEL_MAD_MATCH_THRESHOLD;
      };
    }
    const canonicalKeyOf = await clusterByPerceptualHashCached(accId, clusterInputAssets, confirmByPixelDiff);
    const canonicalKey = canonicalKeyOf.get(assetKey) || assetKey;
    const clusterKeys = accountAssets
      .filter(a => (canonicalKeyOf.get(a.asset_key) || a.asset_key) === canonicalKey)
      .map(a => a.asset_key);
    clusterAssetKeysByAccount.set(accId, clusterKeys.length > 0 ? clusterKeys : [assetKey]);
  }

  const hasTheme = Object.prototype.hasOwnProperty.call(body, 'theme');
  const hasUgcStatus = Object.prototype.hasOwnProperty.call(body, 'ugcStatus');

  // Validate before writing anything — a bad value must not leave some
  // accounts' clusters updated and others not.
  const theme = hasTheme ? (body.theme === null ? null : String(body.theme).trim()) : undefined;
  if (theme !== undefined && theme !== null && !VALID_THEMES.has(theme)) {
    return NextResponse.json({ error: `theme must be one of: ${Array.from(VALID_THEMES).join(', ')}, or null to clear` }, { status: 400 });
  }
  const ugcStatus = hasUgcStatus ? (body.ugcStatus === null ? null : String(body.ugcStatus).trim()) : undefined;
  if (ugcStatus !== undefined && ugcStatus !== null && !VALID_UGC_STATUSES.has(ugcStatus)) {
    return NextResponse.json({ error: `ugcStatus must be one of: ${Array.from(VALID_UGC_STATUSES).join(', ')}, or null to clear` }, { status: 400 });
  }

  for (const accId of foundAccountIds) {
    const clusterKeys = clusterAssetKeysByAccount.get(accId) || [assetKey];
    if (theme !== undefined) {
      await query('UPDATE meta_creative_assets SET theme = $1, updated_at = now() WHERE account_id = $2 AND asset_key = ANY($3)', [theme, accId, clusterKeys]);
    }
    if (ugcStatus !== undefined) {
      await query('UPDATE meta_creative_assets SET ugc_status = $1, updated_at = now() WHERE account_id = $2 AND asset_key = ANY($3)', [ugcStatus, accId, clusterKeys]);
    }
    // A saved tag changes `tagged` for this asset, which is part of the
    // clustering cache's fingerprint (see lib/phash.ts) — the fingerprint
    // check would eventually catch this on its own, but only on whichever
    // request happens to run AFTER this write; a request already in flight
    // (e.g. this same admin's next page load) could still read a
    // just-turned-stale cached result if it lands first. Explicit
    // invalidation closes that window instead of relying on timing luck.
    // Three separate cache slots exist per account (this route's own bare
    // accId, plus the Creatives-tab routes' accId and `${accId}:static`
    // keys — see their own comments) since each clusters a different asset
    // scope; a tag change affects all three, so all three need clearing.
    invalidateClusterCache(accId);
    invalidateClusterCache(`${accId}:static`);
  }

  return NextResponse.json({ ok: true, appliedToAccountIds: foundAccountIds });
}
