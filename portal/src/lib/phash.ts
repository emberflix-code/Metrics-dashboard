import sharp from 'sharp';
import { query } from './db';

const HASH_SIZE = 8;

// 64-bit difference-hash (dHash): resize to 9x8 grayscale, set each bit to
// 1 when a pixel is darker than its right neighbor. Robust to re-encoding
// (same photo re-saved/re-uploaded gets a near-identical hash) while still
// being structural/pixel-based rather than a loose semantic similarity hash.
export async function computePhash(imageBytes: Buffer): Promise<string> {
  const { data } = await sharp(imageBytes)
    .resize(HASH_SIZE + 1, HASH_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = BigInt(0);
  for (let row = 0; row < HASH_SIZE; row++) {
    for (let col = 0; col < HASH_SIZE; col++) {
      const i = row * (HASH_SIZE + 1) + col;
      bits = (bits << BigInt(1)) | (data[i] < data[i + 1] ? BigInt(1) : BigInt(0));
    }
  }
  return bits.toString(16).padStart(16, '0');
}

function hammingDistance(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let dist = 0;
  while (x > BigInt(0)) {
    dist += Number(x & BigInt(1));
    x >>= BigInt(1);
  }
  return dist;
}

// Same visual photo uploaded twice reliably lands within a handful of
// flipped bits after re-encoding; unrelated creatives essentially never
// fall this close, so a pair in this band always merges — no further
// confirmation needed (audited 2026-09-16 across every AF Corporate
// account: zero false-positive merges found at this distance).
export const PHASH_MATCH_THRESHOLD = 4;

// Wider candidate band for the same underlying photo re-uploaded at a
// different resolution (Meta serves some ad variants a full-res thumbnail
// and others a heavily downscaled one — dHash is gradient-based, so that
// resolution gap alone can flip enough bits to land a genuine duplicate out
// past PHASH_MATCH_THRESHOLD). Audited 2026-09-16: 228 real duplicate pairs
// found sitting at distance 5-10 across AF Corporate's 4 accounts, several
// with thousands of dollars of spend split across the "duplicate" cards
// that should have been one. A pair in (PHASH_MATCH_THRESHOLD,
// PHASH_CANDIDATE_THRESHOLD] is only merged if the caller's confirmMatch
// callback (a real pixel-difference check, not just hash distance) agrees —
// unconfirmed candidates never merge. Widening PHASH_MATCH_THRESHOLD itself
// instead of adding this second band was considered and rejected: even at
// distance 5, over a third of candidate pairs in the same audit were
// genuinely different photos that happen to share this account's template
// (same headline font/position, same accent-color footer band), so a
// single wider hash-only threshold trades the current false negatives for
// worse false positives.
export const PHASH_CANDIDATE_THRESHOLD = 10;

// Independent pixel-level cross-check for candidate pairs in the widened
// band above — mean absolute difference on a 32x32 grayscale downsample. A
// different algorithm family from dHash's gradient comparison on purpose:
// two images sharing an on-brand template (same headline font/position,
// same accent color) can still collide on gradient structure alone, but a
// coarse whole-image pixel diff isn't fooled by that the same way. Returns
// null (never confirms a match) if either image fails to decode.
export async function computePixelMAD(bufA: Buffer, bufB: Buffer): Promise<number | null> {
  try {
    const [a, b] = await Promise.all([
      sharp(bufA).resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer(),
      sharp(bufB).resize(32, 32, { fit: 'fill' }).grayscale().raw().toBuffer(),
    ]);
    if (a.length !== b.length || a.length === 0) return null;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length; // 0-255 scale
  } catch {
    return null;
  }
}

// Cutoff for computePixelMAD's 0-255 scale below which two images are
// treated as the same underlying photo. Chosen from the 2026-09-16 audit:
// genuine duplicates (same photo, different offer text/resolution) mostly
// landed under 3; unrelated photos sharing this account's template mostly
// landed well above 8, with only a thin, genuinely ambiguous band between —
// 8 sits in that gap, favoring "don't merge" for the truly borderline cases
// since a missed merge (two cards instead of one) is far less costly than a
// wrong merge (two different customers' photos combined under one tag).
export const PIXEL_MAD_MATCH_THRESHOLD = 8;

// Omega/GMN "Join40%Off" template incident, 2026-08-31 – 2026-09-02: these 3
// image assets shipped with a scrambled headline ("40% Your Off Membership"
// instead of "40% Off Your Membership"), live across 77 club campaigns
// nationwide before marketing corrected it on 2026-09-02. Superseded by the
// tag-aware tie-break below (2026-09-09) for the general case, but kept as a
// belt-and-suspenders override for this specific incident in case these 3
// bad assets are ever viewed in a date range where NEITHER member of their
// pair has been tagged yet (tag-aware tie-break falls through to lexicographic
// order in that case, same as before, which would show the typo'd thumbnail).
const CANONICAL_KEY_OVERRIDES: Record<string, string> = {
  'image:476bb0aef44d736c5a46d2f34b83c88a': 'image:7b6580e9485f0563d0ef9cc953a22f72',
  'image:3b8890f23d0a076a3779708dd7b351f7': 'image:5cb047c99980b5784c25033786397494',
  'image:684b8982ceffaf6a3d5b0d37e7c20921': 'image:d4badc0b8e05aebb2ea0e41876dcc036',
};

// Clusters assets whose phash values are within PHASH_MATCH_THRESHOLD
// Hamming distance and returns a map from every input assetKey to its
// cluster's canonical key. Entries with a null/missing phash (not yet
// backfilled, or a non-image asset type) map to themselves.
//
// Pairs additionally within PHASH_CANDIDATE_THRESHOLD (but past
// PHASH_MATCH_THRESHOLD) also merge, but ONLY when `confirmMatch` is
// supplied and resolves true for that pair — see PHASH_CANDIDATE_THRESHOLD's
// own comment for why hash distance alone isn't trusted out that far.
// Callers that can't supply real pixel bytes (or don't want the extra
// async work) simply omit confirmMatch and get the exact same
// PHASH_MATCH_THRESHOLD-only behavior as before this widened band existed.
//
// Canonical-key tie-break, in priority order:
//   1. CANONICAL_KEY_OVERRIDES (see above) — specific known-bad assets.
//   2. Whichever cluster member has an admin-set Theme or UGC tag — an
//      untagged duplicate must never "steal" canonical status from a
//      tagged one, since that silently un-tags the merged card the moment
//      both members fall inside the same viewed date range. Discovered
//      2026-09-09: the SAME cluster displayed correctly tagged in a
//      September-only range (untagged sibling had no spend yet, so it
//      wasn't even in the clustering input) but showed untagged the moment
//      the range widened to include August, where both members have real
//      spend and the untagged one happened to sort first lexicographically.
//      Only relevant to callers that pass `tagged` (the two DB-cached
//      routes, which have theme/ugc_status on hand); the live route has no
//      tagging concept at all and every asset is untagged=false there, so
//      it falls through to rule 3 unchanged.
//   3. Lexicographically smallest assetKey — deterministic fallback,
//      independent of date range, spend, or fetch order, same as before
//      this tag-aware tie-break existed.
export async function clusterByPerceptualHash(
  assets: { assetKey: string; phash: string | null; tagged?: boolean }[],
  confirmMatch?: (a: string, b: string) => Promise<boolean>
): Promise<Map<string, string>> {
  const canonicalOf = new Map<string, string>();
  const withHash = assets.filter((a): a is { assetKey: string; phash: string; tagged?: boolean } => !!a.phash);
  for (const a of assets) if (!a.phash) canonicalOf.set(a.assetKey, a.assetKey);

  // Union-find over the small (hundreds-of-rows) per-account asset list —
  // an O(n^2) pairwise compare is fine at this scale.
  const parent = new Map<string, string>(withHash.map(a => [a.assetKey, a.assetKey]));
  function find(k: string): string {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)!)!);
      k = parent.get(k)!;
    }
    return k;
  }
  function union(a: string, b: string) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra > rb ? ra : rb, ra > rb ? rb : ra); // keep lexicographically smaller root
  }

  // Certain merges (dist <= PHASH_MATCH_THRESHOLD) run first and
  // synchronously, exactly as before. Candidate merges (dist in
  // (PHASH_MATCH_THRESHOLD, PHASH_CANDIDATE_THRESHOLD]) are collected and
  // only unioned after confirmMatch resolves — running them serially would
  // needlessly slow down large accounts with many candidate pairs.
  const candidatePairs: [string, string][] = [];
  for (let i = 0; i < withHash.length; i++) {
    for (let j = i + 1; j < withHash.length; j++) {
      const dist = hammingDistance(withHash[i].phash, withHash[j].phash);
      if (dist <= PHASH_MATCH_THRESHOLD) {
        union(withHash[i].assetKey, withHash[j].assetKey);
      } else if (confirmMatch && dist <= PHASH_CANDIDATE_THRESHOLD) {
        candidatePairs.push([withHash[i].assetKey, withHash[j].assetKey]);
      }
    }
  }
  if (confirmMatch && candidatePairs.length > 0) {
    const confirmations = await Promise.all(candidatePairs.map(([a, b]) => confirmMatch(a, b)));
    for (let i = 0; i < candidatePairs.length; i++) {
      if (confirmations[i]) union(candidatePairs[i][0], candidatePairs[i][1]);
    }
  }

  // Group members by their union-find root, then pick each group's
  // canonical key by the tie-break priority documented above.
  const membersByRoot = new Map<string, { assetKey: string; tagged?: boolean }[]>();
  for (const a of withHash) {
    const root = find(a.assetKey);
    const list = membersByRoot.get(root) || [];
    list.push(a);
    membersByRoot.set(root, list);
  }
  for (const members of Array.from(membersByRoot.values())) {
    const lexicographicWinner = members.reduce((min, m) => (m.assetKey < min.assetKey ? m : min)).assetKey;
    const taggedMember = members.find(m => m.tagged);
    const winner = CANONICAL_KEY_OVERRIDES[lexicographicWinner]
      ?? (taggedMember ? taggedMember.assetKey : lexicographicWinner);
    for (const m of members) canonicalOf.set(m.assetKey, winner);
  }
  return canonicalOf;
}

/**
 * Resolves theme/ugc_status per canonical cluster INDEPENDENTLY of which
 * member clusterByPerceptualHash picked as the canonical key for display
 * (thumbnail/title/body identity). The `tagged` flag that function's
 * tie-break uses is a single boolean covering EITHER field — a member with
 * theme set but ugc_status null still counts as "tagged" and can win
 * canonical status over a sibling that has ugc_status set but no theme,
 * silently hiding whichever field the losing member actually had. Found
 * live 2026-09-11: a UGC tag saved successfully and persisted in the DB,
 * but the merged card kept showing untagged after reload because its
 * sibling (tagged via theme only) won canonical status and had a null
 * ugc_status. Scans every member of each cluster for a non-null value per
 * field, independent of the canonical-identity pick above — so a tag
 * saved on ANY cluster member is visible on the merged card, not just one
 * saved on whichever member happened to become canonical.
 */
export function resolveClusteredThemeAndUgc(
  assets: { assetKey: string; theme: string | null; ugcStatus: string | null }[],
  canonicalKeyOf: Map<string, string>
): Map<string, { theme: string | null; ugcStatus: string | null }> {
  const byCanonical = new Map<string, { theme: string | null; ugcStatus: string | null }>();
  for (const a of assets) {
    const canonicalKey = canonicalKeyOf.get(a.assetKey) || a.assetKey;
    const existing = byCanonical.get(canonicalKey) || { theme: null, ugcStatus: null };
    if (!existing.theme && a.theme) existing.theme = a.theme;
    if (!existing.ugcStatus && a.ugcStatus) existing.ugcStatus = a.ugcStatus;
    byCanonical.set(canonicalKey, existing);
  }
  return byCanonical;
}

// Live (non-cached, data_source='live') dashboards fetch straight from
// Meta's API and never touch meta_creative_assets — so a live client had no
// path to ever get a phash computed, and image-asset grouping silently
// never worked for them (not a backfill-timing issue, an entirely missing
// code path). This gives live routes the same clustering by computing any
// missing hashes on demand and persisting them into meta_creative_assets,
// keyed by (account_id, asset_key) — same table/column the background sync
// job's backfill writes to. First view of a given asset pays the fetch+hash
// cost once; every later view (live or cached, any client on the account)
// reads the stored value instead of recomputing it.
export async function getOrComputePhashes(
  accountId: string,
  images: { assetKey: string; thumbnail: string | null }[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const withThumbnail = images.filter((i): i is { assetKey: string; thumbnail: string } => !!i.thumbnail);
  if (withThumbnail.length === 0) return result;

  const assetKeys = withThumbnail.map(i => i.assetKey);
  const existing = await query<{ asset_key: string; phash: string | null }>(
    `SELECT asset_key, phash FROM meta_creative_assets WHERE account_id = $1 AND asset_key = ANY($2)`,
    [accountId, assetKeys]
  );
  const existingByKey = new Map(existing.map(r => [r.asset_key, r.phash]));
  for (const [key, phash] of Array.from(existingByKey)) if (phash) result.set(key, phash);

  const missing = withThumbnail.filter(i => !existingByKey.has(i.assetKey) || !existingByKey.get(i.assetKey));
  if (missing.length === 0) return result;

  // Cap per-request work so one Creatives-tab load can't stall on dozens of
  // image fetches — remaining assets simply stay ungrouped until a later
  // view picks them up (each view chips away at whatever's still missing).
  const PER_REQUEST_LIMIT = 40;
  await Promise.all(missing.slice(0, PER_REQUEST_LIMIT).map(async ({ assetKey, thumbnail }) => {
    try {
      const res = await fetch(thumbnail);
      if (!res.ok) return;
      const bytes = Buffer.from(await res.arrayBuffer());
      const hash = await computePhash(bytes);
      result.set(assetKey, hash);
      await query(
        `INSERT INTO meta_creative_assets (account_id, asset_key, type, thumbnail, phash, updated_at)
         VALUES ($1, $2, 'image', $3, $4, now())
         ON CONFLICT (account_id, asset_key)
         DO UPDATE SET phash = EXCLUDED.phash, updated_at = now()`,
        [accountId, assetKey, thumbnail, hash]
      );
    } catch { /* leave this asset ungrouped; retried on a future request */ }
  }));
  return result;
}
