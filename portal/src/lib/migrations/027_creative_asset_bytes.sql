-- Creatives v3: store the actual thumbnail image bytes instead of just a
-- Meta-sourced URL. The existing `thumbnail` URL decays — Meta's CDN URLs
-- are signed with a ~4-day expiry (`oe=` param), some are session-gated
-- `facebook.com/ads/image/?d=...` links that 403 without an active Meta
-- login, and cross-account video lookups fail outright — so on a large,
-- slow-to-sync account a meaningful share of cards go permanently blank.
-- Storing bytes once (see the extended phash-backfill pass in metaSync.ts)
-- means a thumbnail never expires once downloaded. `thumbnail` itself is
-- kept as-is: it remains the fetch INPUT for this backfill, plus a
-- debugging aid — not replaced or repurposed.
--
-- thumbnail_bytes:              the actual image bytes (JPEG/PNG).
-- thumbnail_content_type:       MIME type from the download response's
--                                Content-Type header, so the serving route
--                                can set an accurate header instead of
--                                assuming JPEG for every row.
-- thumbnail_bytes_fetched_at:   separate from the existing
--                                thumbnail_fetched_at (URL freshness) —
--                                tracks byte-download recency, used by a
--                                much longer staleness window (bytes don't
--                                expire the way a signed URL does).

ALTER TABLE meta_creative_assets ADD COLUMN IF NOT EXISTS thumbnail_bytes BYTEA;
ALTER TABLE meta_creative_assets ADD COLUMN IF NOT EXISTS thumbnail_content_type TEXT;
ALTER TABLE meta_creative_assets ADD COLUMN IF NOT EXISTS thumbnail_bytes_fetched_at TIMESTAMPTZ;

-- Creatives v3: same card grid as the existing Creatives v2 tab, but
-- thumbnails are served from thumbnail_bytes instead of a Meta URL. A
-- SEPARATE tab/flag from v2 rather than an in-place swap — see the comment
-- above this ALTER in db.ts for why (byte backfill takes multiple sync
-- runs; v2 must stay unaffected while it catches up).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS show_creatives_v3 BOOLEAN NOT NULL DEFAULT false;
