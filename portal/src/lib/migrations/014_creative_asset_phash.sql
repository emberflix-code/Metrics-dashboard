-- Perceptual-hash dedup for image creatives shown as duplicate cards.
-- Meta's image_hash hashes uploaded FILE BYTES, not pixel content -- two
-- uploads of the identical visual photo get two different image_hash
-- values and show as two separate cards with split stats. phash stores a
-- 64-bit difference-hash (dHash) computed once per image asset at sync
-- time; read-time grouping clusters rows within a small Hamming distance
-- into one card. NULL until backfilled; never set for non-image types.

ALTER TABLE meta_creative_assets ADD COLUMN IF NOT EXISTS phash TEXT;
