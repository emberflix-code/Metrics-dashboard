import sharp from 'sharp';

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

// Clusters assets whose phash values are within PHASH_MATCH_THRESHOLD
// Hamming distance and returns a map from every input assetKey to its
// cluster's canonical key. Entries with a null/missing phash (not yet
// backfilled, or a non-image asset type) map to themselves. Canonical key
// = lexicographically smallest assetKey in the cluster, for determinism
// independent of date range, spend, or fetch order.
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
  for (const a of withHash) canonicalOf.set(a.assetKey, find(a.assetKey));
  return canonicalOf;
}
