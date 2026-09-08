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
// fall this close. Kept tight (not the looser ~10-bit "similar" band) per
// product decision: exact-pixel dedupe only, no loose merges.
export const PHASH_MATCH_THRESHOLD = 4;

// Omega/GMN "Join40%Off" template incident, 2026-08-31 – 2026-09-02: these 3
// image assets shipped with a scrambled headline ("40% Your Off Membership"
// instead of "40% Off Your Membership"), live across 77 club campaigns
// nationwide before marketing corrected it on 2026-09-02. The corrected
// version is the exact same photo (same face/scene), so phash clustering
// already merges each bad/good pair's spend and leads onto one card — but
// clusterByPerceptualHash's tie-break (lexicographically smallest assetKey)
// happens to land on the bad hash in all 3 pairs, so the merged card shows
// the typo'd thumbnail. This map forces the correct member of each
// already-correct cluster to be the one selected as canonical, without
// touching the clustering/merge logic itself. Never delete a bad→good
// mapping once the underlying asset_key rows age out of any date range
// still viewable on a dashboard.
const CANONICAL_KEY_OVERRIDES: Record<string, string> = {
  'image:476bb0aef44d736c5a46d2f34b83c88a': 'image:7b6580e9485f0563d0ef9cc953a22f72',
  'image:3b8890f23d0a076a3779708dd7b351f7': 'image:5cb047c99980b5784c25033786397494',
  'image:684b8982ceffaf6a3d5b0d37e7c20921': 'image:d4badc0b8e05aebb2ea0e41876dcc036',
};

// Clusters assets whose phash values are within PHASH_MATCH_THRESHOLD
// Hamming distance and returns a map from every input assetKey to its
// cluster's canonical key. Entries with a null/missing phash (not yet
// backfilled, or a non-image asset type) map to themselves. Canonical key
// = lexicographically smallest assetKey in the cluster, for determinism
// independent of date range, spend, or fetch order — except where
// CANONICAL_KEY_OVERRIDES above forces a specific member to win instead.
export function clusterByPerceptualHash(
  assets: { assetKey: string; phash: string | null }[]
): Map<string, string> {
  const canonicalOf = new Map<string, string>();
  const withHash = assets.filter((a): a is { assetKey: string; phash: string } => !!a.phash);
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

  for (let i = 0; i < withHash.length; i++) {
    for (let j = i + 1; j < withHash.length; j++) {
      if (hammingDistance(withHash[i].phash, withHash[j].phash) <= PHASH_MATCH_THRESHOLD) {
        union(withHash[i].assetKey, withHash[j].assetKey);
      }
    }
  }
  for (const a of withHash) {
    const auto = find(a.assetKey);
    canonicalOf.set(a.assetKey, CANONICAL_KEY_OVERRIDES[auto] ?? auto);
  }
  return canonicalOf;
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
